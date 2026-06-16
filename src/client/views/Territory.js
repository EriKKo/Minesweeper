// Client for the 2-player Territory (versus) mode.
//
// Territory reuses the SAME board widget as the racing/solo/puzzle modes — the #game0 canvas,
// renderPlayerBoard/drawCell, and Input.js's performAction pipeline — so keyboard focus, the
// key-repeat guard, right-click preventDefault and hit-testing all behave identically and we don't
// reimplement (and re-break) them. The only additions are: a per-cell owner tint (drawCell reads
// `view.getOwner`, fed by the global `territoryOwnerColors` grid), a "territory" action mode in
// Input (server-authoritative — emit, no optimistic reveal), and a small territory HUD.
//
// State arrives via territory_start / territory_board / territory_result (forwarded from the inline
// socket handlers in index.html). Globals territoryActive / territoryOwnerColors are read by
// Input.currentActionMode and Animations.liveBoardView respectively.

var territoryActive = false;          // Input.currentActionMode → "territory" while true
var territoryOwnerColors = null;      // [r][c] -> owner colour hex (or null) for drawCell tint
var territoryInfo = null;             // { myId, players, colorOf, started, playing, scores, deadline }
var territoryFlags = null;            // [r][c] -> bool, local-only "suspected mine" marks (not shared/scored)
var territoryStructures = null;       // "r,c" -> { owner, readyAt (perf.now ms), cooldownMs } surrounded-mine forts
var territoryBeams = [];              // active beam streaks: { from:[r,c], to:[r,c], color, start } for the firing animation
var TV_BEAM_DUR = 480;                // ms a beam streak stays on screen
var territoryEnergyLines = [];        // power grid: [{ a:[r,c], b:[r,c], color, builtAt(perf.now), buildMs }]
var territoryEnergy = {};             // pid -> { value, rate, at(perf.now) } banked energy, interpolated for the HUD
var territoryEnergyTick = null;       // setInterval handle that counts the energy HUD up between broadcasts
var territoryPackets = [];            // travelling energy blips on built lines: [{ a, b, color, start, dur, dir }]
var territoryNextPacketAt = 0;        // perf.now ms before which we don't spawn the next packet ("sometimes")
var territoryMissiles = [];           // energy bombs in flight: [{ from:[r,c], to:[r,c], color, start, dur }]
var territoryAiming = false;          // true while the player is choosing a bomb target (next click = launch)
var territoryClaims = [];             // crater cells reserved for a launcher: [{ r, c, color, until(perf.now) }]

// True while any bomb-claim lock is still active (keeps the render loop alive so the overlay pulses + clears).
function territoryClaimsActive() {
	var now = performance.now();
	for (var i = 0; i < territoryClaims.length; i++) if (territoryClaims[i].until > now) return true;
	return false;
}

// Draw the claim lock: bombed cells reserved for their launcher pulse in that player's colour (a soft fill
// + outline) until the 5s window ends, signalling that only they can take this ground for now.
function drawTerritoryClaims(ctx, sw, sh) {
	if (!territoryClaims.length) return;
	var now = performance.now();
	territoryClaims = territoryClaims.filter(function(cl) { return cl.until > now; });
	var pulse = 0.5 + 0.5 * Math.sin(now / 220); // breathe
	for (var i = 0; i < territoryClaims.length; i++) {
		var cl = territoryClaims[i], x = cl.c * sw, y = cl.r * sh;
		ctx.save();
		ctx.fillStyle = cl.color; ctx.globalAlpha = 0.14 + 0.12 * pulse;
		ctx.fillRect(x + 1, y + 1, sw - 2, sh - 2);
		ctx.globalAlpha = 0.35 + 0.35 * pulse; ctx.strokeStyle = cl.color; ctx.lineWidth = Math.max(1, Math.min(sw, sh) * 0.06);
		ctx.strokeRect(x + 1.5, y + 1.5, sw - 3, sh - 3);
		ctx.restore();
	}
}

// Draw any energy bombs mid-flight: a glowing projectile streaking from the launch silo to its target,
// with a short fading tail. The blast itself arrives via the explosion broadcast when the flight ends.
function drawTerritoryMissiles(ctx, sw, sh) {
	if (!territoryMissiles.length) return;
	var now = performance.now(), unit = Math.min(sw, sh);
	territoryMissiles = territoryMissiles.filter(function(m) { return now - m.start < m.dur; });
	for (var i = 0; i < territoryMissiles.length; i++) {
		var m = territoryMissiles[i], t = (now - m.start) / m.dur;
		var x0 = (m.from[1] + 0.5) * sw, y0 = (m.from[0] + 0.5) * sh;
		var x1 = (m.to[1] + 0.5) * sw, y1 = (m.to[0] + 0.5) * sh;
		var hx = x0 + (x1 - x0) * t, hy = y0 + (y1 - y0) * t;
		var tt = Math.max(0, t - 0.12), tx = x0 + (x1 - x0) * tt, ty = y0 + (y1 - y0) * tt;
		ctx.save();
		ctx.strokeStyle = m.color; ctx.lineCap = "round";
		ctx.globalAlpha = 0.5; ctx.lineWidth = unit * 0.18;
		ctx.shadowColor = m.color; ctx.shadowBlur = unit * 0.5;
		ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
		ctx.globalAlpha = 1; ctx.fillStyle = "#fff"; ctx.shadowBlur = unit * 0.9;
		ctx.beginPath(); ctx.arc(hx, hy, unit * 0.2, 0, Math.PI * 2); ctx.fill();
		ctx.restore();
	}
}

// True while any extractor/line is under construction OR a packet is in flight (keeps the loop animating).
function territoryInfraAnimating() {
	if (territoryPackets.length || territoryMissiles.length) return true;
	if (territoryClaimsActive()) return true;
	var now = performance.now();
	if (territoryStructures) for (var k in territoryStructures) { var s = territoryStructures[k]; if (s.buildMs && s.builtAt > now) return true; }
	for (var i = 0; i < territoryEnergyLines.length; i++) { var l = territoryEnergyLines[i]; if (l.buildMs && l.builtAt > now) return true; }
	return false;
}

// A line is routed orthogonally (Manhattan): horizontal along A's row to B's column, then vertical to B —
// so it runs along the grid axes, not diagonally. This returns the pixel point at fraction t of that path.
function territoryGridPoint(a, b, t, sw, sh) {
	var x0 = (a[1] + 0.5) * sw, y0 = (a[0] + 0.5) * sh;
	var x1 = (b[1] + 0.5) * sw, y1 = (b[0] + 0.5) * sh;
	var hlen = Math.abs(x1 - x0), vlen = Math.abs(y1 - y0), total = hlen + vlen;
	if (total === 0) return [x0, y0];
	var d = t * total;
	if (d <= hlen) return [x0 + Math.sign(x1 - x0) * d, y0];
	return [x1, y0 + Math.sign(y1 - y0) * (d - hlen)];
}

// Occasionally launch an energy packet along a built line (driven by the 250ms HUD tick). Spawns one at a
// time on a randomised cadence so blips appear "sometimes" rather than constantly.
function territorySpawnPackets(now) {
	var built = [];
	for (var i = 0; i < territoryEnergyLines.length; i++) {
		var l = territoryEnergyLines[i];
		if (!l.buildMs || l.builtAt <= now) built.push(l);
	}
	if (!built.length) { territoryNextPacketAt = 0; return; }
	if (!territoryNextPacketAt) territoryNextPacketAt = now + 400;
	if (now >= territoryNextPacketAt) {
		var pick = built[Math.floor(Math.random() * built.length)];
		territoryPackets.push({ a: pick.a, b: pick.b, color: pick.color, start: now,
			dur: 750 + Math.random() * 650, dir: Math.random() < 0.5 ? 1 : -1 });
		territoryNextPacketAt = now + 550 + Math.random() * 1600;
	}
}

// Draw the energy grid: faint orthogonal traces between wired extractors (subtle so they don't dominate the
// board), dashed while a line is still building, plus the little energy packets travelling along them.
function drawTerritoryEnergyLines(ctx, sw, sh) {
	if (!territoryEnergyLines.length && !territoryPackets.length) return;
	var now = performance.now(), unit = Math.min(sw, sh);
	for (var i = 0; i < territoryEnergyLines.length; i++) {
		var l = territoryEnergyLines[i];
		var frac = !l.buildMs ? 1 : Math.max(0, Math.min(1, 1 - (l.builtAt - now) / l.buildMs));
		var built = frac >= 1;
		var x0 = (l.a[1] + 0.5) * sw, y0 = (l.a[0] + 0.5) * sh;
		var x1 = (l.b[1] + 0.5) * sw, y1 = (l.b[0] + 0.5) * sh;
		ctx.save();
		ctx.strokeStyle = l.color;
		ctx.lineCap = "round"; ctx.lineJoin = "round";
		if (built) {
			ctx.globalAlpha = 0.18; ctx.lineWidth = Math.max(1, unit * 0.04); ctx.setLineDash([]);
		} else {
			ctx.globalAlpha = 0.10 + 0.10 * frac; ctx.lineWidth = Math.max(1, unit * 0.03);
			ctx.setLineDash([unit * 0.16, unit * 0.16]);
		}
		// Orthogonal L route: along the row to B's column, then down/up the column to B.
		ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1); ctx.stroke();
		ctx.restore();
	}
	for (var p = territoryPackets.length - 1; p >= 0; p--) {
		var pk = territoryPackets[p], pt = (now - pk.start) / pk.dur;
		if (pt >= 1) { territoryPackets.splice(p, 1); continue; }
		var pos = territoryGridPoint(pk.a, pk.b, pk.dir > 0 ? pt : 1 - pt, sw, sh);
		ctx.save();
		ctx.globalAlpha = Math.sin(pt * Math.PI); // fade in as it leaves, out as it arrives
		ctx.fillStyle = "#eaffff";
		ctx.shadowColor = pk.color; ctx.shadowBlur = unit * 0.55;
		ctx.beginPath(); ctx.arc(pos[0], pos[1], Math.max(1.5, unit * 0.11), 0, Math.PI * 2); ctx.fill();
		ctx.restore();
	}
}

// True while any beam streak is still animating (keeps the render loop alive).
function territoryBeamsActive(now) {
	for (var i = 0; i < territoryBeams.length; i++) if (now - territoryBeams[i].start < TV_BEAM_DUR) return true;
	return false;
}

// Draw the active beam streaks on the shared board: a glowing line from the firing structure to the
// blast's end, fading out. Called by renderPlayerBoard after the cells (territory only).
function drawTerritoryBeams(ctx, sw, sh) {
	if (!territoryBeams.length) return;
	var now = performance.now();
	territoryBeams = territoryBeams.filter(function(b) { return now - b.start < TV_BEAM_DUR; });
	for (var i = 0; i < territoryBeams.length; i++) {
		var b = territoryBeams[i], t = (now - b.start) / TV_BEAM_DUR;
		var x0 = (b.from[1] + 0.5) * sw, y0 = (b.from[0] + 0.5) * sh;
		var x1 = (b.to[1] + 0.5) * sw, y1 = (b.to[0] + 0.5) * sh;
		ctx.save();
		ctx.globalAlpha = (1 - t) * 0.9;
		ctx.strokeStyle = b.color;
		ctx.shadowColor = b.color;
		ctx.shadowBlur = Math.min(sw, sh) * 0.7;
		ctx.lineWidth = Math.min(sw, sh) * (0.5 - 0.3 * t); // thick, tapering as it fades
		ctx.lineCap = "round";
		ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
		// bright head racing to the impact in the first part of the animation
		var hp = Math.min(1, t / 0.5);
		ctx.globalAlpha = 1 - t;
		ctx.fillStyle = "#fff";
		ctx.shadowBlur = Math.min(sw, sh) * 1.1;
		ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * hp, y0 + (y1 - y0) * hp, Math.min(sw, sh) * 0.32 * (1 - t), 0, Math.PI * 2); ctx.fill();
		ctx.restore();
	}
}

var TERRITORY_HEX = { cyan: "#22d3ee", amber: "#fb923c", violet: "#a78bfa", rose: "#fb7185" };
function territoryColorHex(color) { return TERRITORY_HEX[color] || "#22d3ee"; }

function territoryColorOf(pid) {
	var p = territoryInfo && territoryInfo.players.filter(function(x) { return x.id === pid; })[0];
	return p ? p.color : "cyan";
}

// Build / fetch the HUD that sits above the shared board in game_view. Two players get the classic
// chip · bar · chip row; with more (4-player territory) the chips sit in a row above a single bar.
function territoryEnsureHud() {
	var n = (territoryInfo && territoryInfo.players) ? territoryInfo.players.length : 2;
	var hud = document.getElementById("territory_hud");
	if (hud && +hud.getAttribute("data-n") === n) return hud;
	var left = document.querySelector("#game_view .game-left");
	if (!left) return null;
	if (hud) hud.remove();
	hud = document.createElement("div");
	hud.id = "territory_hud";
	hud.className = n > 2 ? "tv-hud tv-hud-multi" : "tv-hud";
	hud.setAttribute("data-n", n);
	var fills = "";
	for (var i = 0; i < n; i++) fills += '<div class="tv-bar-fill" id="tv_bar' + i + '"></div>';
	if (n === 2) {
		hud.innerHTML = '<div class="tv-chip" id="tv_chip0"></div><div class="tv-bar">' + fills + '</div><div class="tv-chip" id="tv_chip1"></div>';
	} else {
		var chips = "";
		for (var j = 0; j < n; j++) chips += '<div class="tv-chip" id="tv_chip' + j + '"></div>';
		hud.innerHTML = '<div class="tv-chips">' + chips + '</div><div class="tv-bar">' + fills + '</div>';
	}
	// Energy-bomb launcher: click to aim, then click a target area on the board.
	var bomb = document.createElement("button");
	bomb.id = "tv_bomb_btn"; bomb.className = "tv-bomb-btn btn"; bomb.type = "button";
	bomb.addEventListener("click", territoryToggleAim);
	hud.appendChild(bomb);
	left.insertBefore(hud, left.firstChild);
	territoryUpdateBombBtn();
	return hud;
}

var TV_BOMB_COST = 1000; // mirror of the server's BOMB_COST (energy spent per launch)

// Bomb hotkeys: S toggles aiming (same as the HUD button), Esc cancels it. Ignored while typing in a field.
document.addEventListener("keydown", function(e) {
	if (!territoryActive) return;
	var el = document.activeElement, typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
	if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
	if (e.key === "Escape" && territoryAiming) { territoryAiming = false; territoryUpdateBombBtn(); }
	else if (e.key === "s" || e.key === "S") { e.preventDefault(); territoryToggleAim(); }
});

// How many generators (structures) the local player owns — you need at least one to launch from.
function territoryMyGenerators() {
	var n = 0;
	if (territoryStructures && territoryInfo) for (var k in territoryStructures) if (territoryStructures[k].owner === territoryInfo.myId) n++;
	return n;
}

// Refresh the bomb button label + enabled state (called from the 250ms energy tick so affordability is live).
function territoryUpdateBombBtn() {
	var btn = document.getElementById("tv_bomb_btn");
	if (!btn || !territoryInfo) return;
	var energy = Math.floor(territoryEnergyNow(territoryInfo.myId));
	var hasGen = territoryMyGenerators() > 0, canAfford = energy >= TV_BOMB_COST;
	btn.disabled = !(hasGen && canAfford && territoryInfo.playing) && !territoryAiming;
	btn.classList.toggle("aiming", territoryAiming);
	document.body.classList.toggle("tv-aiming", territoryAiming); // crosshair cursor over the board
	btn.textContent = territoryAiming ? "🎯 Pick a target…" : ("💣 Bomb · " + TV_BOMB_COST + "⚡");
	btn.title = !hasGen ? "Build a generator (surround a mine) to launch from"
		: !canAfford ? "Need " + TV_BOMB_COST + " energy" : "Launch an energy bomb at the enemy (hotkey: S)";
}

// Toggle bomb-aiming mode (click the button, then click the target on the board). No-op if you can't launch.
function territoryToggleAim() {
	if (!territoryInfo || !territoryInfo.playing) return;
	if (!territoryAiming) {
		var energy = Math.floor(territoryEnergyNow(territoryInfo.myId));
		if (energy < TV_BOMB_COST || territoryMyGenerators() === 0) return;
	}
	territoryAiming = !territoryAiming;
	territoryUpdateBombBtn();
}

// Fire the bomb at (r,c) — called from Input when a board cell is clicked while aiming.
function territoryLaunchBomb(r, c) {
	if (!territoryAiming) return;
	territoryAiming = false;
	territoryUpdateBombBtn();
	if (typeof socket !== "undefined") socket.emit("territory_bomb", { r: r, c: c });
}

function territoryStart(data) {
	var R = data.rows, C = data.cols;
	territoryInfo = { myId: data.you, players: data.players, started: false, playing: true, scores: {}, deadline: null, total: R * C };
	territoryActive = true;
	territoryOwnerColors = [];
	territoryFlags = [];
	territoryStructures = {};
	territoryBeams = [];
	territoryEnergyLines = [];
	territoryEnergy = {};
	territoryPackets = [];
	territoryNextPacketAt = 0;
	territoryMissiles = [];
	territoryAiming = false;
	territoryClaims = [];
	if (territoryEnergyTick) clearInterval(territoryEnergyTick);
	territoryEnergyTick = setInterval(territoryEnergyTickFn, 250); // count energy up + launch the odd packet
	for (var r = 0; r < R; r++) { territoryOwnerColors.push(new Array(C).fill(null)); territoryFlags.push(new Array(C).fill(false)); }

	// Set up the shared board exactly like a normal round start.
	applyBoardDims(R, C);
	if (data.boardData && data.boardMask) installBoardDecoder(data.boardData, data.boardMask, R, C);
	myState = null;
	prevPlayerState = null;
	resetBoardAnimations();
	clearFreeze();
	// Focus a sensible starting cell (the player's own corner) for keyboard play.
	var myStart = (data.starts && data.players[0] && data.players[0].id === data.you) ? data.starts[0] : (data.starts ? data.starts[1] : [0, 0]);
	focusedR = myStart ? myStart[0] : 0;
	focusedC = myStart ? myStart[1] : 0;
	focusVisible = false;

	showGameView();
	var gv = document.getElementById("game_view");
	if (gv) gv.classList.add("territory");
	document.body.classList.add("territory-fullscreen");
	if (typeof hideReadyButton === "function") hideReadyButton();
	territoryEnsureHud();
	territoryRenderHud();
	countDown(data.time || 3);
	// Re-fit the board now that the .territory single-column layout is applied (applyBoardDims
	// sized it against the racing layout / may have early-returned on unchanged dims).
	requestAnimationFrame(sizeTerritoryBoard);
}

// Size the shared canvas to fill the territory board area (reuses the fit-to-space sizing), then
// recompute the hit-test cell size and repaint. Also run on window resize via the shared handler.
function sizeTerritoryBoard() {
	if (!territoryActive || typeof sizePlayerCanvas !== "function") return;
	sizePlayerCanvas();
	if (typeof renderPlayerBoard === "function") renderPlayerBoard();
}

function territoryBoard(data) {
	if (!territoryInfo) return;
	territoryInfo.started = true;
	territoryInfo.playing = data.playing;
	territoryInfo.scores = data.scores || {};
	territoryInfo.deadline = data.roundDeadline || null;

	// A mine explosion re-covered a patch (origin noted below for the reverse-cascade animation). If the
	// explosion ever carries regenerated clue values again, patch them into the client's board.
	if (data.explosion && data.explosion.clues && typeof patchBoardCells === "function") patchBoardCells(data.explosion.clues);

	// Cells the server re-covered this tick (only an explosion does this). Used both to allow an
	// authoritative un-reveal and to drive the reverse-cascade animation.
	var recovered = (data.explosion && data.explosion.recovered) || [];
	var fireRecovered = (data.fire && data.fire.recovered) || [];
	var recoveredSet = {};
	recovered.concat(fireRecovered).forEach(function(p) { recoveredSet[p[0] + "," + p[1]] = true; });
	// Rebuild the structure map (surrounded-mine forts + their recharge state) from the broadcast.
	var sNow = performance.now();
	if (territoryStructures) {
		var fresh = {};
		(data.structures || []).forEach(function(s) {
			fresh[s.r + "," + s.c] = { owner: s.owner, cooldownMs: s.cooldownMs, readyAt: sNow + s.readyInMs,
				builtAt: sNow + (s.buildInMs || 0), buildMs: s.buildMs || 0 };
		});
		territoryStructures = fresh;
	}
	// Power grid + banked energy. Store builtAt as a local perf.now timestamp so the client animates
	// construction without clock sync; energy keeps value+rate+at so the HUD can count up smoothly.
	territoryEnergyLines = (data.energyLines || []).map(function(l) {
		return { a: l.a, b: l.b, color: territoryColorHex(territoryColorOf(l.owner)),
			builtAt: sNow + (l.buildInMs || 0), buildMs: l.buildMs || 0 };
	});
	if (data.energy) Object.keys(data.energy).forEach(function(pid) {
		territoryEnergy[pid] = { value: data.energy[pid], rate: (data.energyRate && data.energyRate[pid]) || 0, at: sNow };
	});
	// Bomb claim locks: crater cells reserved for their launcher for a few seconds (msLeft → local expiry).
	territoryClaims = (data.claims || []).map(function(cl) {
		return { r: cl.r, c: cl.c, color: territoryColorHex(territoryColorOf(cl.owner)), until: sNow + cl.msLeft };
	});
	// An energy bomb was launched — animate the missile streaking to its target (the blast lands when an
	// explosion broadcast arrives ~flightMs later).
	if (data.missile) {
		territoryMissiles.push({ from: data.missile.from, to: data.missile.to,
			color: territoryColorHex(territoryColorOf(data.missile.pid)), start: sNow, dur: data.missile.flightMs || 800 });
		if (typeof startAnimLoop === "function") startAnimLoop();
	}

	// When YOUR OWN mine hit refills an area, clear your flags within it (you'll re-explore it fresh).
	// An opponent's explosion never touches your flags. Done before myState is rebuilt below so the
	// cleared marks don't get re-applied. Covers the re-covered cells and their immediate neighbours
	// (where suspected-mine flags around the blast tend to sit).
	// A bomb blast wipes every flag in the area (anyone's); a self-mine refill only clears your own flags.
	// (Self-explosions are gone, so in practice this is the bomb path.) Done before myState is rebuilt so
	// the cleared marks aren't re-applied. Covers the re-covered cells + their immediate neighbours.
	if (data.explosion && (data.explosion.bomb || data.explosion.pid === territoryInfo.myId) && territoryFlags) {
		recovered.forEach(function(rc) {
			for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
				var fr = rc[0] + dr, fc = rc[1] + dc;
				if (fr >= 0 && fc >= 0 && fr < rows && fc < cols && territoryFlags[fr][fc]) { territoryFlags[fr][fc] = false; delete cellAnims[fr + "," + fc]; }
			}
		});
	}

	var R = rows, C = cols;
	// Translate the shared state + owner grids into the board's myState + tint grid, MERGING with the
	// local prediction: a cell we already revealed is never un-revealed by a server board unless an
	// explosion actually re-covered it. Otherwise a broadcast that races ahead of our own reveal's echo
	// (e.g. the opponent moving) would briefly revert our just-revealed cells — a flicker.
	var newState = [];
	for (var r = 0; r < R; r++) {
		newState.push(new Array(C));
		for (var c = 0; c < C; c++) {
			var s = data.state[r][c];
			var o = data.owner[r][c];
			if (s === UNKNOWN && myState && myState[r][c] === KNOWN && !recoveredSet[r + "," + c]) {
				s = KNOWN;                                  // keep our predicted reveal (server just hasn't echoed it yet)
				if (o == null) o = territoryInfo.myId;      // we predicted it ours
			}
			territoryOwnerColors[r][c] = o == null ? null : territoryColorHex(territoryColorOf(o));
			// A claimed cell can't stay flagged; otherwise re-apply the local flag mark so the
			// server's state broadcast doesn't wipe it (flags are client-only in territory).
			if (s === KNOWN) territoryFlags[r][c] = false;
			else if (territoryFlags[r][c]) s = FLAGGED;
			newState[r][c] = s;
		}
	}
	// Structures render as flagged cells in their owner's colour (drawCell draws a coloured flag + charge
	// gauge). They're covered mines, so without this overlay they'd just look like blank covered cells.
	if (territoryStructures) for (var sk in territoryStructures) {
		var sp = sk.split(","), str = +sp[0], stc = +sp[1];
		newState[str][stc] = FLAGGED;
		territoryOwnerColors[str][stc] = territoryColorHex(territoryColorOf(territoryStructures[sk].owner));
	}
	myState = newState;
	// Animate newly-claimed cells (queueRevealAnimations diffs against prevPlayerState, then we
	// snapshot). On the first board prevPlayerState is null, so the start cascades animate in.
	queueRevealAnimations(newState);
	// Reverse cascade: animate exactly the cells the server re-covered (the exploder's territory),
	// staggered outward from the blast origin — never inferred from a diff, so a rolled-back local
	// prediction can't trigger a spurious un-reveal. Queued AFTER queueRevealAnimations (which clears
	// anims for now-covered cells) so they aren't wiped.
	if (data.explosion && recovered.length) {
		var origin = data.explosion.origin, now = performance.now(), any = false;
		for (var ri = 0; ri < recovered.length; ri++) {
			var rc = recovered[ri];
			if (newState[rc[0]][rc[1]] !== UNKNOWN) continue;
			cellAnims[rc[0] + "," + rc[1]] = { type: "unreveal", start: now + Math.hypot(rc[0] - origin[0], rc[1] - origin[1]) * 26 };
			any = true;
		}
		if (any && typeof startAnimLoop === "function") startAnimLoop();
	}
	// Offensive beam: streak a glowing line from the structure to the impact (so you SEE the shot even
	// when the breach lands far away), and animate the re-covered enemy channel as an unreveal.
	if (data.fire) {
		var ffrom = data.fire.from, fnow = performance.now();
		territoryBeams.push({ from: data.fire.from, to: data.fire.to, color: territoryColorHex(territoryColorOf(data.fire.pid)), start: fnow });
		for (var fi = 0; fi < fireRecovered.length; fi++) {
			var frc = fireRecovered[fi];
			if (newState[frc[0]][frc[1]] !== UNKNOWN) continue;
			cellAnims[frc[0] + "," + frc[1]] = { type: "unreveal", start: fnow + Math.hypot(frc[0] - ffrom[0], frc[1] - ffrom[1]) * 18 };
		}
		if (typeof startAnimLoop === "function") startAnimLoop();
	}
	prevPlayerState = cloneState(newState);
	renderPlayerBoard();
	// While extractors/lines are building, keep the render loop spinning so construction animates smoothly
	// between the 1/s broadcasts (the loop self-stops once everything's built and no beam is flying).
	if (typeof startAnimLoop === "function" && territoryInfraAnimating()) startAnimLoop();

	// Freeze: reuse the shared frozenUntil + freeze visuals.
	var fz = (data.frozenUntil && data.frozenUntil[territoryInfo.myId]) || 0;
	if (fz > Date.now()) { frozenUntil = fz; if (typeof startFreezeTick === "function") startFreezeTick(); }
	else { clearFreeze(); }

	territoryRenderHud();
}

function territoryResult(data) {
	// Keep territoryActive true so the final board still shows the territory tints behind the
	// result overlay; it's fully reset by territoryReset() when the player actually leaves.
	if (territoryInfo) { territoryInfo.playing = false; territoryInfo.ranked = !!data.ranked; }
	var mine = data.scores && data.scores.filter(function(s) { return s.id === (territoryInfo && territoryInfo.myId); })[0];
	var win = data.winnerId === (territoryInfo && territoryInfo.myId);
	var head = data.winnerId == null ? "Draw" : (win ? "You win!" : "You lose");
	var detail = (data.scores || []).map(function(s) {
		return '<span style="color:' + territoryColorHex(s.color) + '">' + s.name + ": " + s.score + "</span>";
	}).join(" &nbsp;·&nbsp; ");
	if (data.ranked && mine && typeof mine.ratingDelta === "number") {
		var sign = mine.ratingDelta >= 0 ? "+" : "";
		detail += '<br><span class="tv-elo">Territory rating ' + mine.rating + " (" + sign + mine.ratingDelta + ")</span>";
		if (typeof account !== "undefined" && account) {
			account.ratingTerritory = mine.rating;
			account.provisional = !!mine.provisional;
		}
		if (typeof renderHomeRankChips === "function") renderHomeRankChips();
		if (typeof renderRatingBadge === "function") renderRatingBadge(); // refresh the topbar overall
	}
	var wrap = document.querySelector("#game_view .board-wrap");
	if (wrap) {
		var ov = document.getElementById("territory_result_overlay");
		if (!ov) { ov = document.createElement("div"); ov.id = "territory_result_overlay"; ov.className = "tv-result-overlay"; wrap.appendChild(ov); }
		ov.innerHTML = '<div class="tv-result"><h2>' + head + '</h2><p>' + detail + '</p>' +
			'<div class="tv-result-actions">' +
			'<button class="btn btn-secondary" onclick="territoryViewBoard()">View board</button>' +
			'<button class="btn btn-primary" onclick="territoryPlayAgain()">Find another game</button>' +
			'<button class="btn btn-secondary" onclick="leaveRoom()">Back to lobby</button>' +
			'</div></div>';
		ov.style.display = "";
	}
}

function leaveTerritory() {
	territoryReset();
	if (typeof socket !== "undefined") socket.emit("leave_room");
}

// "View board": dismiss the result overlay so the player can look over the finished board, leaving a
// small "Show result" pill to bring the result (and its actions) back.
function territoryViewBoard() {
	var ov = document.getElementById("territory_result_overlay");
	if (ov) ov.style.display = "none";
	var wrap = document.querySelector("#game_view .board-wrap");
	if (!wrap) return;
	var pill = document.getElementById("territory_result_pill");
	if (!pill) { pill = document.createElement("div"); pill.id = "territory_result_pill"; pill.className = "tv-result-pill"; wrap.appendChild(pill); }
	pill.innerHTML = '<button class="btn btn-primary" onclick="territoryShowResult()">Show result</button>';
	pill.style.display = "";
}
function territoryShowResult() {
	var ov = document.getElementById("territory_result_overlay"); if (ov) ov.style.display = "";
	var pill = document.getElementById("territory_result_pill"); if (pill) pill.style.display = "none";
}

// "Find another game": leave this one and, if it was ranked, re-queue for another ranked match;
// otherwise drop back to the custom lobby to start/join one.
function territoryPlayAgain() {
	var ranked = territoryInfo && territoryInfo.ranked;
	leaveTerritory();
	if (ranked && typeof findRanked === "function") findRanked("territory_duo");
}

// Tear down ALL territory state + DOM. Called when leaving by any path (the result button, or the
// left_room handler when navigating away) so territoryActive/owner colours can't leak into the
// other modes that share the board (which would break chording and tint their cells).
function territoryReset() {
	territoryActive = false;
	territoryOwnerColors = null;
	territoryFlags = null;
	territoryStructures = null;
	territoryBeams = [];
	territoryEnergyLines = [];
	territoryEnergy = {};
	territoryPackets = [];
	territoryNextPacketAt = 0;
	territoryMissiles = [];
	territoryAiming = false;
	territoryClaims = [];
	if (territoryEnergyTick) { clearInterval(territoryEnergyTick); territoryEnergyTick = null; }
	territoryInfo = null;
	var ov = document.getElementById("territory_result_overlay");
	if (ov) ov.remove();
	var pill = document.getElementById("territory_result_pill");
	if (pill) pill.remove();
	var hud = document.getElementById("territory_hud");
	if (hud) hud.remove();
	var gv = document.getElementById("game_view");
	if (gv) gv.classList.remove("territory");
	document.body.classList.remove("territory-fullscreen");
	// NB: don't exit fullscreen here. territoryReset runs on every room teardown (teardownRoomUI),
	// including "Play another"/"Find another game" re-queues that must stay fullscreen. Leaving the
	// game for good exits fullscreen via the explicit leave paths (leaveRoom / Router navigate-away).
}

// Is (r,c) one of MY structures (a surrounded-mine fort I own)? Left-clicking it fires an offensive beam.
function territoryIsMyStructure(r, c) {
	var s = territoryStructures && territoryStructures[r + "," + c];
	return !!(s && territoryInfo && s.owner === territoryInfo.myId);
}

// Client-side contiguity check, mirroring the server's g.canReveal: a covered cell 8-adjacent to one
// of my own cells. Lets us predict a reveal locally instead of waiting for the server round-trip.
function territoryCanReveal(r, c) {
	if (!myState || !territoryOwnerColors || myState[r][c] !== UNKNOWN) return false;
	var mine = territoryColorHex(territoryColorOf(territoryInfo.myId));
	for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
		if (!dr && !dc) continue;
		var nr = r + dr, nc = c + dc;
		if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && territoryOwnerColors[nr][nc] === mine) return true;
	}
	return false;
}

// Optimistic local reveal: the client knows the decoded board, so it predicts a safe reveal + cascade
// exactly as the server will, claims the cells for me, and animates immediately — no waiting on the
// round-trip. Mines are NOT predicted (the server owns the explosion/regen); enclosure capture and the
// opponent's moves arrive on the authoritative territory_board, which reconciles the whole grid. A move
// the server ends up rejecting is simply overwritten by the next board. Returns true if it revealed.
function territoryLocalReveal(r, c) {
	if (!territoryActive || !myState) return false;
	if (myState[r][c] !== UNKNOWN) return false;          // covered cells only (FLAGGED is protected upstream)
	if (boardCell(r, c) === MINE) return false;           // let the server compute the explosion
	if (!territoryCanReveal(r, c)) return false;          // must touch my own territory
	var mine = territoryColorHex(territoryColorOf(territoryInfo.myId));
	var revealed = [];
	BoardLogic.cascadeReveal(r, c, rows, cols,
		function(rr, cc) { return myState[rr][cc] === UNKNOWN && boardCell(rr, cc) !== MINE; },
		function(rr, cc) { myState[rr][cc] = KNOWN; territoryOwnerColors[rr][cc] = mine; territoryFlags[rr][cc] = false; revealed.push([rr, cc]); return false; },
		function(rr, cc) { return boardCell(rr, cc); });
	if (!revealed.length) return false;
	lastActionCell = { r: r, c: c };
	queueRevealAnimations(myState);
	prevPlayerState = cloneState(myState);                // so the matching server board doesn't re-animate these
	return true;
}

// Toggle a local "suspected mine" flag on a covered cell (client-only — not sent to the server,
// not scored). Reuses the shared flag animation + sounds so it looks identical to the other modes.
function territoryToggleFlag(r, c) {
	if (!myState || !territoryFlags || myState[r][c] === KNOWN) return;
	territoryFlags[r][c] = !territoryFlags[r][c];
	var key = r + "," + c;
	if (territoryFlags[r][c]) {
		myState[r][c] = FLAGGED;
		cellAnims[key] = { type: "flag", start: performance.now() };
		if (typeof sound !== "undefined" && sound.flag) sound.flag();
		startAnimLoop();
	} else {
		myState[r][c] = UNKNOWN;
		delete cellAnims[key];
		if (typeof sound !== "undefined" && sound.unflag) sound.unflag();
	}
	// Mirror the change into prevPlayerState so the next territory_board diff doesn't see a phantom
	// flag transition and re-play the flag-pop (which starts at scale 0, making the flag blink out
	// once). Flags are client-only, so the server's broadcast never carries them.
	if (prevPlayerState) prevPlayerState[r][c] = myState[r][c];
}

// Interpolated banked energy for a player: last broadcast value + rate × elapsed (smooth between ticks).
function territoryEnergyNow(pid) {
	var e = territoryEnergy[pid];
	if (!e) return 0;
	return e.value + e.rate * (performance.now() - e.at) / 1000;
}

// Tick the energy numbers on the HUD chips between broadcasts so they count up live.
function territoryUpdateEnergyHud() {
	if (!territoryInfo) return;
	for (var i = 0; i < territoryInfo.players.length; i++) {
		var el = document.getElementById("tv_energy" + i);
		if (el) el.textContent = "⚡ " + Math.floor(territoryEnergyNow(territoryInfo.players[i].id));
	}
	territoryUpdateBombBtn();
}

// 250ms heartbeat: refresh the energy numbers and occasionally launch a grid packet. When a packet is in
// flight it kicks the rAF loop so the blip animates smoothly; the loop self-stops in the gaps between them.
function territoryEnergyTickFn() {
	territoryUpdateEnergyHud();
	if (!territoryActive) return;
	territorySpawnPackets(performance.now());
	if (territoryPackets.length && typeof startAnimLoop === "function") startAnimLoop();
}

function territoryRenderHud() {
	var info = territoryInfo;
	if (!info) return;
	for (var i = 0; i < info.players.length; i++) {
		var p = info.players[i];
		var sc = (info.scores && info.scores[p.id]) || 0;
		var chip = document.getElementById("tv_chip" + i);
		if (chip) {
			chip.innerHTML = '<span class="tv-swatch" style="background:' + territoryColorHex(p.color) + '"></span>' +
				'<span class="tv-name">' + p.name + (p.id === info.myId ? " (you)" : "") + '</span>' +
				'<span class="tv-score">' + sc + '</span>' +
				'<span class="tv-energy" id="tv_energy' + i + '" style="color:' + territoryColorHex(p.color) + '">⚡ ' + Math.floor(territoryEnergyNow(p.id)) + '</span>';
		}
		var bar = document.getElementById("tv_bar" + i);
		if (bar) { bar.style.width = (100 * sc / info.total) + "%"; bar.style.background = territoryColorHex(p.color); }
	}
}
