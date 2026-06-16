// Replay playback — decodes the server's input-log format (see runtime/replay.js) and re-simulates
// each player's board, scrubbable on a timeline. The wire payload is the *gunzipped* binary (the
// server decompresses); we only need the decoder + a re-sim that mirrors GameCreator's click logic.
//
// Re-sim parity with the engine (templated board, so no first-click relocation):
//   left  on UNKNOWN → cascade reveal; on KNOWN → chord (reveal covered neighbours if flags == clue)
//   right on UNKNOWN → flag; on FLAGGED → unflag; on KNOWN → chord
// Mines are only ever revealed by a direct click (cascades stop at any non-zero clue), exactly as live.

(function() {
	// --- binary decode (unsigned LEB128 varints, mirror of the server Writer) ---------------------
	function Reader(u8) { this.b = u8; this.pos = 0; }
	Reader.prototype.u8 = function() { return this.b[this.pos++]; };
	Reader.prototype.varint = function() {
		var x = 0, s = 0, byte;
		do { byte = this.b[this.pos++]; x |= (byte & 0x7f) << s; s += 7; } while (byte & 0x80);
		return x >>> 0;
	};
	Reader.prototype.str = function() {
		var n = this.varint();
		var s = "";
		// UTF-8 decode (names are short; TextDecoder avoids surrogate edge cases).
		var slice = this.b.subarray(this.pos, this.pos + n);
		this.pos += n;
		try { return new TextDecoder("utf-8").decode(slice); } catch (e) {
			for (var i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
			return s;
		}
	};
	Reader.prototype.bits = function(byteLen) { var out = this.b.subarray(this.pos, this.pos + byteLen); this.pos += byteLen; return out; };

	function decodeReplay(u8) {
		var rd = new Reader(u8);
		if (rd.u8() !== 0x4d || rd.u8() !== 0x52) throw new Error("bad replay magic");
		var version = rd.u8();
		rd.u8(); // flags (reserved)
		var rows = rd.varint(), cols = rd.varint();
		var mineCount = rd.varint(), gameCount = rd.varint();
		var style = rd.str(), mode = rd.str();
		var pc = rd.varint(), players = [];
		for (var p = 0; p < pc; p++) {
			var pl = { name: rd.str(), bot: !!rd.u8(), userId: rd.varint() || null };
			pl.skin = version >= 2 ? (rd.str() || null) : null; // v2+ stores each player's board skin
			if (version >= 3) { pl.avatar = rd.str() || null; pl.country = rd.str() || null; } // v3+ avatar + country
			players.push(pl);
		}
		var bitLen = Math.ceil((rows * cols) / 8);
		var rounds = [];
		for (var g = 0; g < gameCount; g++) {
			var startR = rd.varint(), startC = rd.varint();
			var mines = rd.bits(bitLen).slice();   // copy out of the backing buffer
			var known = rd.bits(bitLen).slice();
			var tracks = [];
			for (var pi = 0; pi < pc; pi++) {
				var ec = rd.varint();
				var ct = 0, evs = [];
				for (var e = 0; e < ec; e++) {
					ct += rd.varint();                 // cumulative time from round start
					var packed = rd.varint();
					evs.push({ ct: ct, cell: packed >>> 1, button: packed & 1 });
				}
				tracks.push(evs);
			}
			rounds.push({ startR: startR, startC: startC, mines: mines, known: known, tracks: tracks });
		}
		return { version: version, rows: rows, cols: cols, mineCount: mineCount, gameCount: gameCount,
			style: style, mode: mode, players: players, rounds: rounds };
	}

	function bitSet(bits, idx) { return (bits[idx >> 3] >> (idx & 7)) & 1; }

	// --- re-simulation -----------------------------------------------------------------------------
	// Build a per-round model: mine grid + clue grid + a fresh-state factory. cellAt feeds BoardView.
	function buildRoundModel(rep, round) {
		var R = rep.rows, C = rep.cols;
		var mines = [], clue;
		for (var r = 0; r < R; r++) { mines[r] = []; for (var c = 0; c < C; c++) mines[r][c] = !!bitSet(round.mines, r * C + c); }
		clue = BoardLogic.buildClueGrid(R, C, function(r, c) { return mines[r][c]; });
		return {
			R: R, C: C, mines: mines, clue: clue,
			cellAt: function(r, c) { return mines[r][c] ? MINE : clue[r][c]; },
			freshState: function() {
				var s = [];
				for (var r = 0; r < R; r++) { s[r] = []; for (var c = 0; c < C; c++) s[r][c] = bitSet(round.known, r * C + c) ? KNOWN : UNKNOWN; }
				return s;
			}
		};
	}

	// Apply one player's events up to (and including) cumulative time T into a fresh state array.
	function stateAt(model, events, T) {
		var s = model.freshState();
		var R = model.R, C = model.C, mines = model.mines, clue = model.clue;
		function dfs(r, c) {
			BoardLogic.cascadeReveal(r, c, R, C,
				function(rr, cc) { return s[rr][cc] === UNKNOWN; },
				function(rr, cc) { s[rr][cc] = KNOWN; return false; },
				function(rr, cc) { return mines[rr][cc] ? -1 : clue[rr][cc]; });
		}
		function chord(r, c) {
			var ctx = BoardLogic.chordContext(r, c, R, C,
				function(rr, cc) { return s[rr][cc] === FLAGGED; },
				function(rr, cc) { return s[rr][cc] === KNOWN && mines[rr][cc]; },
				function(rr, cc) { return s[rr][cc] === UNKNOWN; });
			if (ctx.flagCount === clue[r][c]) for (var i = 0; i < ctx.covered.length; i++) dfs(ctx.covered[i][0], ctx.covered[i][1]);
		}
		var applied = 0;
		for (var i = 0; i < events.length; i++) {
			var ev = events[i];
			if (ev.ct > T) break;
			applied++;
			var r = (ev.cell / C) | 0, c = ev.cell % C;
			if (ev.button === 0) { if (s[r][c] === UNKNOWN) dfs(r, c); else if (s[r][c] === KNOWN) chord(r, c); }
			else { if (s[r][c] === UNKNOWN) s[r][c] = FLAGGED; else if (s[r][c] === FLAGGED) s[r][c] = UNKNOWN; else if (s[r][c] === KNOWN) chord(r, c); }
		}
		return { state: s, applied: applied };
	}

	function roundDuration(round) {
		var max = 0;
		for (var p = 0; p < round.tracks.length; p++) { var t = round.tracks[p]; if (t.length) max = Math.max(max, t[t.length - 1].ct); }
		return max;
	}

	// --- playback state ----------------------------------------------------------------------------
	var R = {
		rep: null, roundIdx: 0, model: null, focusIdx: 0,
		playerStates: [],    // per player: the (mutated-in-place) cell-state array, shared by all its views
		playerViews: [],     // per player: [BoardView, …] — the strip thumbnail, plus the big stage board for the focused player
		playT: 0, duration: 0, playing: false, speed: 1,
		raf: 0, lastTs: 0, lastApplied: [],
		els: null
	};

	function fmtTime(ms) {
		var s = Math.max(0, Math.round(ms / 1000));
		return (Math.floor(s / 60)) + ":" + ("0" + (s % 60)).slice(-2);
	}
	function styleName(rep) {
		var m = (rep.mode || rep.style || "").replace(/_/g, " ");
		return m ? m.charAt(0).toUpperCase() + m.slice(1) : "Match";
	}

	// The focused board is large; the filmstrip thumbnails are small. Both clamp to fit the grid width.
	function stageCellPx(cols) { return Math.max(12, Math.min(32, Math.floor(560 / cols))); }
	function thumbCellPx(cols) { return Math.max(5, Math.min(12, Math.floor(150 / cols))); }

	function skinFor(pl) {
		// v2+ replays carry each player's skin; unknown/missing ids fall back to the default.
		return (pl.skin && typeof BOARD_SKIN_LIST !== "undefined" && BOARD_SKIN_LIST.indexOf(pl.skin) >= 0) ? pl.skin : "classic";
	}

	// Build one board card (label + canvas + BoardView) for player p at the given cell size, sharing the
	// player's state array so a single re-sim feeds both its stage board and its filmstrip thumbnail.
	function buildBoardCard(rep, p, px, state) {
		var pl = rep.players[p];
		var wrap = document.createElement("div"); wrap.className = "replay-board";
		var label = document.createElement("div"); label.className = "replay-board-label";
		if (typeof buildAvatarChip === "function") label.appendChild(buildAvatarChip(pl.avatar || DEFAULT_AVATAR, pl.country || null, px >= 20 ? 40 : 28));
		var nm = document.createElement("span"); nm.className = "replay-board-name"; nm.textContent = pl.name;
		label.appendChild(nm);
		if (pl.bot) { var bt = document.createElement("span"); bt.className = "replay-bot-tag"; bt.textContent = "BOT"; label.appendChild(bt); }
		if (rep.winnerId && pl.userId === rep.winnerId) { var w = document.createElement("span"); w.className = "replay-win-tag"; w.textContent = "🏆"; label.appendChild(w); }
		wrap.appendChild(label);
		var canvas = buildCellCanvas(rep.cols, rep.rows, px, "replay-canvas");
		wrap.appendChild(canvas);
		var view = new BoardView(canvas, rep.rows, rep.cols, state, R.model.cellAt, { skin: skinFor(pl) });
		return { wrap: wrap, view: view };
	}

	// (Re)build the stage + filmstrip for the current round and focused player. Does NOT reset the
	// playhead, so changing focus keeps you at the same moment; selectRound handles the position reset.
	function buildBoards() {
		var rep = R.rep, round = rep.rounds[R.roundIdx];
		R.model = buildRoundModel(rep, round);
		R.duration = roundDuration(round);
		if (R.focusIdx < 0 || R.focusIdx >= rep.players.length) R.focusIdx = 0;
		R.playerStates = []; R.playerViews = []; R.lastApplied = [];
		var stage = R.els.stage, strip = R.els.strip;
		stage.innerHTML = ""; strip.innerHTML = "";
		var thumbPx = thumbCellPx(rep.cols);
		// Filmstrip: every player, click to focus. The focused one is highlighted in place.
		for (var p = 0; p < rep.players.length; p++) {
			var state = R.model.freshState();
			R.playerStates.push(state); R.playerViews.push([]); R.lastApplied.push(-1);
			var thumb = buildBoardCard(rep, p, thumbPx, state);
			thumb.wrap.classList.add("replay-thumb");
			if (p === R.focusIdx) thumb.wrap.classList.add("focused");
			(function(idx) { thumb.wrap.addEventListener("click", function() { setFocus(idx); }); })(p);
			strip.appendChild(thumb.wrap);
			R.playerViews[p].push(thumb.view);
		}
		// Stage: the focused player's board, large. Shares the same state array as its thumbnail.
		var fp = R.focusIdx;
		var stageCard = buildBoardCard(rep, fp, stageCellPx(rep.cols), R.playerStates[fp]);
		stageCard.wrap.classList.add("replay-stage-board");
		stage.appendChild(stageCard.wrap);
		R.playerViews[fp].push(stageCard.view);
		renderFrame(true);
	}

	// Switch the big board to another player (keeps playback position + play state).
	function setFocus(idx) {
		if (idx === R.focusIdx) return;
		R.focusIdx = idx;
		buildBoards();
	}

	// Recompute each player's state once for the current playT and draw all of that player's views (the
	// filmstrip thumbnail plus, for the focused player, the stage board). Skips a player whose applied-
	// event count is unchanged since the last frame (cheap steady state); forced on (re)build / scrub.
	function renderFrame(force) {
		var round = R.rep.rounds[R.roundIdx];
		for (var p = 0; p < R.playerStates.length; p++) {
			var res = stateAt(R.model, round.tracks[p], R.playT);
			if (!force && res.applied === R.lastApplied[p]) continue;
			R.lastApplied[p] = res.applied;
			var st = R.playerStates[p];
			for (var r = 0; r < R.model.R; r++) for (var c = 0; c < R.model.C; c++) st[r][c] = res.state[r][c];
			var views = R.playerViews[p];
			for (var v = 0; v < views.length; v++) views[v].draw();
		}
		if (R.els.slider) R.els.slider.value = String(Math.round(R.playT));
		if (R.els.time) R.els.time.textContent = fmtTime(R.playT) + " / " + fmtTime(R.duration);
	}

	function tick(ts) {
		if (!R.rep) return;
		if (R.playing) {
			if (!R.lastTs) R.lastTs = ts;
			R.playT += (ts - R.lastTs) * R.speed;
			R.lastTs = ts;
			if (R.playT >= R.duration) { R.playT = R.duration; setPlaying(false); }
			renderFrame(false);
		} else {
			R.lastTs = 0;
		}
		R.raf = requestAnimationFrame(tick);
	}

	function setPlaying(on) {
		// Restart from the top if hitting play at the very end.
		if (on && R.playT >= R.duration) { R.playT = 0; R.lastApplied = R.lastApplied.map(function() { return -1; }); }
		R.playing = on; R.lastTs = 0;
		if (R.els.play) R.els.play.textContent = on ? "❚❚ Pause" : "▶ Play";
	}

	function setSpeed(mult) {
		R.speed = mult;
		var btns = R.els.speeds || [];
		for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", parseFloat(btns[i].dataset.mult) === mult);
	}

	function selectRound(idx) {
		R.roundIdx = idx;
		var tabs = R.els.roundTabs ? R.els.roundTabs.children : [];
		for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle("active", i === idx);
		R.playT = 0; // a new round starts from the top
		buildBoards();
		if (R.els.slider) { R.els.slider.max = String(Math.round(R.duration)); R.els.slider.value = "0"; }
		setPlaying(false);
	}

	// --- view scaffold -----------------------------------------------------------------------------
	function showReplayView(id) {
		teardownReplay();
		setSiteNavActive(null);
		var view = document.getElementById("replay_view");
		view.style.display = "";
		view.innerHTML = "";

		var back = document.createElement("a"); back.href = "/profile"; back.className = "replay-back"; back.textContent = "← Back to profile";
		view.appendChild(back);
		var status = document.createElement("div"); status.className = "replay-status"; status.textContent = "Loading replay…";
		view.appendChild(status);
		R.els = { view: view, status: status };

		if (typeof socket !== "undefined") socket.emit("get_replay", { id: id });
	}

	function onReplayData(data) {
		if (!R.els || !R.els.view) return; // navigated away before it arrived
		if (!data || data.error) { R.els.status.textContent = "Replay unavailable (" + ((data && data.error) || "error") + ")."; return; }
		var u8;
		try { u8 = data.data instanceof ArrayBuffer ? new Uint8Array(data.data) : new Uint8Array(data.data.buffer || data.data); }
		catch (e) { R.els.status.textContent = "Replay data could not be read."; return; }
		var rep;
		try { rep = decodeReplay(u8); } catch (e) { R.els.status.textContent = "Replay could not be decoded."; return; }
		rep.winnerId = data.winnerId || null; // for the 🏆 tag on the winning player's board
		R.rep = rep; R.roundIdx = 0; R.speed = 1;
		// Start focused on the viewer's own board; fall back to the first player.
		R.focusIdx = 0;
		if (typeof account !== "undefined" && account) {
			for (var i = 0; i < rep.players.length; i++) if (rep.players[i].userId === account.userId) { R.focusIdx = i; break; }
		}
		buildPlayerUI(data);
		R.raf = requestAnimationFrame(tick);
	}

	function buildPlayerUI(data) {
		var rep = R.rep, view = R.els.view;
		view.innerHTML = "";

		var bar = document.createElement("div"); bar.className = "replay-topbar";
		var back = document.createElement("a"); back.href = "/profile"; back.className = "replay-back"; back.textContent = "← Back";
		bar.appendChild(back);
		var title = document.createElement("div"); title.className = "replay-title";
		title.textContent = styleName(rep) + " · " + rep.rows + "×" + rep.cols;
		bar.appendChild(title);
		var when = document.createElement("div"); when.className = "replay-when";
		when.textContent = data.createdAt ? new Date(data.createdAt).toLocaleString() : "";
		bar.appendChild(when);
		view.appendChild(bar);

		// Round tabs (only when more than one game in the series).
		var roundTabs = null;
		if (rep.gameCount > 1) {
			roundTabs = document.createElement("div"); roundTabs.className = "replay-rounds";
			for (var g = 0; g < rep.gameCount; g++) {
				(function(gi) {
					var t = document.createElement("button"); t.type = "button";
					t.className = "replay-round-tab" + (gi === 0 ? " active" : "");
					t.textContent = "Game " + (gi + 1);
					t.addEventListener("click", function() { selectRound(gi); });
					roundTabs.appendChild(t);
				})(g);
			}
			view.appendChild(roundTabs);
		}

		// Focused board (large) + a filmstrip of all players (click to focus).
		var stage = document.createElement("div"); stage.className = "replay-stage"; view.appendChild(stage);
		var strip = document.createElement("div"); strip.className = "replay-strip"; view.appendChild(strip);

		// Controls
		var controls = document.createElement("div"); controls.className = "replay-controls";
		var play = document.createElement("button"); play.type = "button"; play.className = "replay-play"; play.textContent = "▶ Play";
		play.addEventListener("click", function() { setPlaying(!R.playing); });
		controls.appendChild(play);

		var slider = document.createElement("input"); slider.type = "range"; slider.className = "replay-slider";
		slider.min = "0"; slider.max = String(Math.round(roundDuration(rep.rounds[0]))); slider.value = "0"; slider.step = "50";
		slider.addEventListener("input", function() { setPlaying(false); R.playT = parseInt(slider.value, 10) || 0; renderFrame(true); });
		controls.appendChild(slider);

		var time = document.createElement("span"); time.className = "replay-time"; time.textContent = "0:00 / 0:00";
		controls.appendChild(time);

		var speeds = [];
		var speedWrap = document.createElement("div"); speedWrap.className = "replay-speeds";
		[0.5, 1, 2, 4].forEach(function(m) {
			var b = document.createElement("button"); b.type = "button"; b.className = "replay-speed" + (m === 1 ? " active" : "");
			b.dataset.mult = String(m); b.textContent = m + "×";
			b.addEventListener("click", function() { setSpeed(m); });
			speedWrap.appendChild(b); speeds.push(b);
		});
		controls.appendChild(speedWrap);
		view.appendChild(controls);

		R.els = { view: view, stage: stage, strip: strip, roundTabs: roundTabs, play: play, slider: slider, time: time, speeds: speeds };
		selectRound(0);
	}

	function teardownReplay() {
		if (R.raf) cancelAnimationFrame(R.raf);
		R.raf = 0; R.rep = null; R.playing = false; R.playerStates = []; R.playerViews = []; R.model = null; R.els = null;
	}

	// Exports (globals, matching the no-module-bundler convention).
	window.showReplayView = showReplayView;
	window.onReplayData = onReplayData;
	window.teardownReplay = teardownReplay;
})();
