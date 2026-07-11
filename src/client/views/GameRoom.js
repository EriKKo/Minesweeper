// In-room rendering: room state (player list, ready buttons, the option
// dropdowns / read-only labels, danger flash, the bot count card),
// scoreboard (live progress + final scores), and the small bot-list panel
// players can show/hide for casual rooms.
//
// renderRoomState fires on every server room_state update; renderScoreboard
// is called both from there and from draw_board for live progress refresh.

function formatDifficulty(d) {
	return d ? d.charAt(0).toUpperCase() + d.slice(1) : "";
}

function renderBotList(state, isOwner) {
	var bots = state.players.filter(function(p) { return p.isBot; });
	botListEl.innerHTML = "";
	var canEdit = isOwner && state.phase === "planning";
	bots.forEach(function(bot) {
		var row = document.createElement("div");
		row.className = "bot-row";

		var name = document.createElement("span");
		name.className = "bot-row-name";
		name.textContent = bot.name;
		row.appendChild(name);

		if (canEdit) {
			var sel = document.createElement("select");
			sel.className = "bot-difficulty-select";
			(state.botDifficultyOptions || []).forEach(function(d) {
				var opt = document.createElement("option");
				opt.value = d;
				opt.textContent = formatDifficulty(d);
				sel.appendChild(opt);
			});
			sel.value = bot.difficulty;
			sel.addEventListener("change", function() {
				socket.emit("set_bot_difficulty", { botId: bot.id, difficulty: sel.value });
			});
			row.appendChild(sel);
		} else {
			var tag = document.createElement("span");
			tag.className = "bot-row-difficulty";
			tag.textContent = formatDifficulty(bot.difficulty);
			row.appendChild(tag);
		}
		botListEl.appendChild(row);
	});
}

// The lobby roster: one row per seat (up to maxPlayers). Filled seats show the player (host ★, tier,
// ready status; bots get an inline difficulty picker + remove ×). Empty seats carry an "Add bot" button
// for the owner, or a muted "Open slot" otherwise. Replaces both the planning scoreboard and the
// separate bots card while waiting in a casual room.
function renderLobbySlots(state) {
	if (!scoreboardEl) return;
	scoreboardEl.innerHTML = "";
	var isOwner = state.owner === id;
	var canEdit = isOwner && state.phase === "planning";
	var canAddBot = canEdit && (state.botCount || 0) < state.maxBots;
	var players = state.players || [];
	var seats = state.maxPlayers || players.length;
	for (var i = 0; i < seats; i++) {
		var p = players[i];
		var li = document.createElement("li");
		li.className = "lobby-slot";

		var num = document.createElement("span");
		num.className = "lobby-slot-num";
		num.textContent = i + 1;
		li.appendChild(num);

		if (p) {
			if (p.id === id) li.classList.add("lobby-slot-me");
			var main = document.createElement("div");
			main.className = "lobby-slot-main";
			var nameEl = document.createElement("div");
			nameEl.className = "lobby-slot-name";
			nameEl.textContent = p.name + (p.isOwner ? " ★" : "");
			main.appendChild(nameEl);

			var sub = document.createElement("div");
			sub.className = "lobby-slot-sub";
			if (p.isBot && !state.ranked) {
				var botTag = document.createElement("span");
				botTag.className = "lobby-slot-bottag";
				botTag.textContent = "BOT";
				sub.appendChild(botTag);
			}
			if (typeof p.rating === "number") {
				var t = tierFor(p.rating, p.provisional);
				var tier = document.createElement("span");
				tier.className = "lobby-slot-tier";
				tier.textContent = t.name;
				tier.style.color = t.color;
				sub.appendChild(tier);
			}
			if (sub.childNodes.length) main.appendChild(sub);
			li.appendChild(main);

			// Owner can retune / drop a bot inline, no separate panel.
			if (p.isBot && canEdit) {
				var sel = document.createElement("select");
				sel.className = "bot-difficulty-select lobby-slot-diff";
				(state.botDifficultyOptions || []).forEach(function(d) {
					var opt = document.createElement("option");
					opt.value = d; opt.textContent = formatDifficulty(d);
					sel.appendChild(opt);
				});
				sel.value = p.difficulty;
				(function(botId, selEl) {
					selEl.addEventListener("change", function() {
						socket.emit("set_bot_difficulty", { botId: botId, difficulty: selEl.value });
					});
				})(p.id, sel);
				li.appendChild(sel);

				var rm = document.createElement("button");
				rm.className = "lobby-slot-remove";
				rm.type = "button";
				rm.title = "Remove bot";
				rm.setAttribute("aria-label", "Remove bot");
				rm.textContent = "×";
				rm.addEventListener("click", function() { socket.emit("remove_bot"); });
				li.appendChild(rm);
			}

			var status = document.createElement("span");
			status.className = "lobby-slot-status " + (p.ready ? "lobby-slot-ready" : "lobby-slot-waiting");
			status.textContent = p.ready ? "Ready" : "Waiting";
			li.appendChild(status);
		} else {
			li.classList.add("lobby-slot-empty");
			var open = document.createElement("span");
			open.className = "lobby-slot-open";
			open.textContent = canAddBot ? "Empty slot" : (isOwner ? "Bot limit reached" : "Open slot");
			li.appendChild(open);
			if (canAddBot) {
				var add = document.createElement("button");
				add.className = "lobby-slot-add";
				add.type = "button";
				add.textContent = "+ Add bot";
				add.addEventListener("click", function() { socket.emit("add_bot"); });
				li.appendChild(add);
			}
		}
		scoreboardEl.appendChild(li);
	}
}

function renderRoomState(state) {
	// A room is never solo/puzzle — if we arrived straight from one (those views share the game-view),
	// clear their mode class + chrome so they don't bleed into the lobby. No-op once cleared.
	if (typeof gameView !== "undefined" && gameView) {
		if (gameView.classList.contains("solo")) { gameView.classList.remove("solo"); if (typeof toggleSoloChrome === "function") toggleSoloChrome(false); }
		if (gameView.classList.contains("puzzle")) { gameView.classList.remove("puzzle"); gameView.classList.remove("marathon"); if (typeof togglePuzzleChrome === "function") togglePuzzleChrome(false); }
	}
	var isOwner = state.owner === id;
	populateSelect(gameCountSelect, state.gameCountOptions, function(n) { return String(n); });
	populateSelect(roundSecondsSelect, state.roundSecondsOptions, formatRoundOption);
	populateSelect(deathPenaltySelect, state.deathPenaltyOptions, formatPenaltyOption);
	populateSelect(boardSizeSelect, state.boardSizeOptions, formatBoardSize);

	gameCountSelect.value = String(state.gameCount);
	roundSecondsSelect.value = String(state.roundSeconds);
	deathPenaltySelect.value = String(state.deathPenalty);
	boardSizeSelect.value = String(state.boardSize);
	// Mine density is a 10%–30% slider; don't yank it out from under the owner while they drag.
	if (mineDensitySlider) {
		var densityPct = Math.round((state.mineDensity || 0.1) * 100);
		if (document.activeElement !== mineDensitySlider) mineDensitySlider.value = String(densityPct);
		if (mineDensityVal) mineDensityVal.textContent = mineDensitySlider.value + "%";
	}

	rankedTag.style.display = state.ranked ? "" : "none";
	// Hide the site navbar for ranked games (the game-header takes over that role — see the
	// body.ranked-game rules in style.css) — only re-run the board resize on an actual transition,
	// not on every room_state broadcast.
	var wasRanked = document.body.classList.contains("ranked-game");
	var isRanked = !!state.ranked;
	document.body.classList.toggle("ranked-game", isRanked);
	if (isRanked !== wasRanked && typeof refreshPlayerBoardSize === "function") {
		requestAnimationFrame(refreshPlayerBoardSize);
	}
	// Ranked rooms have a locked ruleset — show the values read-only, even to the owner.
	var showSelects = isOwner && !state.ranked;
	var canEdit = showSelects && state.phase === "planning";
	gameCountSelect.disabled = !canEdit;
	roundSecondsSelect.disabled = !canEdit;
	deathPenaltySelect.disabled = !canEdit;
	boardSizeSelect.disabled = !canEdit;
	if (mineDensitySlider) mineDensitySlider.disabled = !canEdit;
	gameCountSelect.style.display = showSelects ? "" : "none";
	roundSecondsSelect.style.display = showSelects ? "" : "none";
	deathPenaltySelect.style.display = showSelects ? "" : "none";
	boardSizeSelect.style.display = showSelects ? "" : "none";
	if (mineDensityControl) mineDensityControl.style.display = showSelects ? "" : "none";
	gameCountReadonly.style.display = showSelects ? "none" : "";
	roundSecondsReadonly.style.display = showSelects ? "none" : "";
	deathPenaltyReadonly.style.display = showSelects ? "none" : "";
	boardSizeReadonly.style.display = showSelects ? "none" : "";
	mineDensityReadonly.style.display = showSelects ? "none" : "";
	gameCountReadonly.textContent = formatSeriesFormat(state.gameCount, state.scoreTarget);
	roundSecondsReadonly.textContent = formatRoundOption(state.roundSeconds);
	deathPenaltyReadonly.textContent = formatPenaltyOption(state.deathPenalty);
	boardSizeReadonly.textContent = formatBoardSize(state.boardSize);
	mineDensityReadonly.textContent = formatMineDensity(state.mineDensity);

	// During play, the right column shows the other players; in planning, it shows
	// the room options. The scoreboard stays visible in both phases. Ranked rooms
	// have a locked ruleset and no lobby to configure, so the options card never
	// shows for them — it's only meaningful in a custom lobby.
	var playing = state.phase !== "planning";
	// Show the opponent board(s) during play, and also through the battle layout's planning/reveal
	// AND result windows (ranked 1v1 + 6-player) so the field — and the finish-place stamps under the
	// result modal — stay visible, not only while play is live. Both the duo and multi classes count.
	var battleActive = typeof gameView !== "undefined" && gameView && (gameView.classList.contains("duo") || gameView.classList.contains("multi"));
	allOpponentsDiv.style.display = (playing || battleActive) ? "" : "none";

	// Clean waiting-room lobby: a custom casual room sitting in its planning phase (not the ranked
	// battle layout, not territory). Drops the empty board and the "Scoreboard" framing for a two-column
	// layout — a slot-based player roster (empty slots carry an "Add bot" button) on the left, the
	// ruleset on the right, and a full-width Ready bar below. No separate bots card.
	var lobbyMode = !playing && !battleActive && !state.ranked
		&& (state.gameMode || "race") === "race"
		&& !(typeof territoryActive !== "undefined" && territoryActive);
	if (typeof gameView !== "undefined" && gameView) gameView.classList.toggle("lobby", lobbyMode);
	var scoreTitleEl = scoreboardCard ? scoreboardCard.querySelector(".side-title") : null;
	if (scoreTitleEl) scoreTitleEl.textContent = lobbyMode ? "Players" : "Scoreboard";

	seriesCard.style.display = (playing || state.ranked) ? "none" : "";
	// The separate bots card is only used outside the lobby — in the lobby, bots live in the roster slots.
	var showBotCard = !playing && !state.ranked && !lobbyMode && (isOwner || (state.botCount && state.botCount > 0));
	botsCard.style.display = showBotCard ? "" : "none";
	if (showBotCard) {
		var canAddBot = isOwner && state.phase === "planning" && state.botCount < state.maxBots;
		var canRemoveBot = isOwner && state.phase === "planning" && state.botCount > 0;
		addBotButton.style.display = isOwner ? "" : "none";
		removeBotButton.style.display = isOwner ? "" : "none";
		addBotButton.disabled = !canAddBot;
		removeBotButton.disabled = !canRemoveBot;
		if (state.botCount === 0) {
			botStatus.textContent = isOwner ? "Add a bot to practice solo." : "";
		} else {
			botStatus.textContent = state.botCount + " bot" + (state.botCount === 1 ? "" : "s") + " in this lobby.";
		}
		renderBotList(state, isOwner);
	}

	if (state.phase === "playing" && state.roundDeadline) {
		if (!roundDeadline || roundDeadline !== state.roundDeadline) {
			startRoundTimer(state.roundDeadline);
		}
	} else {
		stopRoundTimer();
	}

	if (lobbyMode) renderLobbySlots(state);
	else renderScoreboard();
	state.players.forEach(function(p) { lastScores[p.id] = p.score; });

	// Race-tension cue: an opponent just cleared their board. Pitch rises with how
	// many rivals are already done. Suppressed once the round result is up.
	if (state.phase === "playing" && !roundResultShown) {
		var doneCount = 0;
		state.players.forEach(function(p) { if (p.id !== id && p.finished) doneCount++; });
		state.players.forEach(function(p) {
			if (p.id !== id && p.finished && !lastFinished[p.id]) sound.opponentDone(doneCount);
		});
	}
	state.players.forEach(function(p) { lastFinished[p.id] = !!p.finished; });

	var me = state.players.find(function(p) { return p.id === id; });
	var ownName = (me || {}).name || myName;
	document.getElementById("player_name0").textContent = ownName;
	// player_div is shared with puzzle play AND territory, but this function only ever runs off a
	// room_state broadcast — which only reaches sockets actually seated in a room, never during
	// solo/puzzle play — so no separate "are we really looking at the mp lobby" check is needed
	// beyond excluding territory (territory rooms broadcast room_state too, but have no series and
	// should never go idle). Was previously also gated on `location.pathname === "/"`, which broke
	// idle for every custom room joined from /custom (the whole custom-lobby flow never navigates the
	// URL to "/" — showGameView() just swaps which view is visible) — that gate never matched, so
	// idle silently never activated for casual custom rooms. Stays on through the WHOLE planning
	// phase now, not just the under-filled stretch — waiting on players to join and waiting on Ready
	// clicks read the same visually, and cutting it off the moment enough players show up left a dead,
	// static gap between "idle stops" and "the go sweep starts" instead of one continuous transition.
	// The sweep (Animations.js, paintBoardGoWithIdle) is what actually turns it off now, by settling
	// into it as the round starts. Actually leaving the room is handled by teardownRoomUI, not here.
	var inTerritory = (typeof territoryActive !== "undefined" && territoryActive);
	var stillPlanning = state.phase === "planning";
	if (!inTerritory) {
		document.getElementById("player_div").classList.toggle("idle", stillPlanning);
		if (typeof setBoardIdleActive === "function") setBoardIdleActive(stillPlanning);
	} else {
		document.getElementById("player_div").classList.remove("idle");
		if (typeof setBoardIdleActive === "function") setBoardIdleActive(false);
	}

	if (state.phase === "playing" && me && me.finished && !roundResultShown) {
		showOverlay("Cleared — waiting for others", "win");
	} else if (boardOverlay.textContent === "Cleared — waiting for others") {
		hideOverlay();
	}

	if (state.phase === "planning") {
		if (state.gamesPlayed === 0 && !state.seriesWinner) {
			seriesStatus.textContent = state.players.length < 2
				? "Waiting for more players to join…"
				: "Click Ready when you're set.";
		} else {
			seriesStatus.textContent = "Next series starts when everyone clicks Ready.";
		}
		var meRdy = state.players.find(function(p) { return p.id === id; });
		var iAmReady = meRdy && meRdy.ready;
		readyButton.style.display = iAmReady ? "none" : "";
		readyButton.disabled = state.players.length < 2;
		readyStatus.textContent = iAmReady ? "Waiting for others…" : "";
		gameProgressText.textContent = "";
		clearCanvas(playerCanvas);
	} else {
		var nextGameNum = state.scoreTarget
			? state.gamesPlayed + 1
			: Math.min(state.gamesPlayed + 1, state.gameCount);
		seriesStatus.textContent = formatGameProgress(nextGameNum, state.gameCount, state.scoreTarget);
		readyButton.style.display = "none";
		readyStatus.textContent = "";
		if (!gameProgressText.textContent) {
			gameProgressText.textContent = formatGameProgress(nextGameNum, state.gameCount, state.scoreTarget);
		}
	}
}
function renderScoreboard() {
	if (!currentRoom || !scoreboardEl) return;
	var state = currentRoom;
	var playing = state.phase === "playing";

	var sorted = state.players.slice();
	if (playing) {
		sorted.sort(function(a, b) {
			var lpa = liveProgress[a.id] || {}, lpb = liveProgress[b.id] || {};
			if (lpa.finished !== lpb.finished) return lpa.finished ? -1 : 1;
			if (lpa.finished && lpb.finished) return (lpa.finishedAt || 0) - (lpb.finishedAt || 0);
			return (lpb.progress || 0) - (lpa.progress || 0);
		});
	} else {
		// Planning / match-preview: rank by rating (highest first) so the player
		// can see where they place in the lobby. Score remains the tiebreaker
		// for casual rooms after the first game has been played.
		sorted.sort(function(a, b) {
			if (b.score !== a.score) return b.score - a.score;
			var ar = typeof a.rating === "number" ? a.rating : 0;
			var br = typeof b.rating === "number" ? b.rating : 0;
			return br - ar;
		});
	}

	// Top 5 are always shown. If your position is below rank 8 in a lobby of
	// more than 11, the rows between fold into a "···" gap. Otherwise the whole
	// field fits and we render every player.
	var TOP_COUNT = 5;
	var NEIGHBOURS = 2; // rows above and below you
	var rows;
	var myIdx = -1;
	for (var mi = 0; mi < sorted.length; mi++) { if (sorted[mi].id === id) { myIdx = mi; break; } }
	var canFitAll = sorted.length <= TOP_COUNT + 1 + 2 * NEIGHBOURS + 1;
	if (canFitAll || myIdx < TOP_COUNT + NEIGHBOURS) {
		rows = sorted.map(function(p, idx) { return { kind: "player", p: p, rank: idx + 1 }; });
	} else {
		rows = [];
		for (var ti = 0; ti < TOP_COUNT; ti++) rows.push({ kind: "player", p: sorted[ti], rank: ti + 1 });
		var meStart = Math.max(TOP_COUNT, myIdx - NEIGHBOURS);
		if (meStart > TOP_COUNT) rows.push({ kind: "gap" });
		var meEnd = Math.min(sorted.length, myIdx + NEIGHBOURS + 1);
		for (var k = meStart; k < meEnd; k++) rows.push({ kind: "player", p: sorted[k], rank: k + 1 });
	}

	scoreboardEl.innerHTML = "";
	rows.forEach(function(row) {
		var li = document.createElement("li");
		if (row.kind === "gap") {
			li.className = "score-row score-row-gap";
			li.textContent = "···";
			scoreboardEl.appendChild(li);
			return;
		}
		var p = row.p;
		li.className = "score-row";
		li.dataset.pid = p.id;
		if (p.id === id) li.classList.add("score-row-me");
		// Spectator: clickable rows that switch the big-board target.
		// Mark the current target so it reads as "watching".  Skip your
		// own row (already self-styled) and only enable during play.
		if (iAmEliminated && playing && p.id !== id) {
			li.classList.add("score-row-spectatable");
			if (typeof spectatorTarget !== "undefined" && p.id === spectatorTarget) {
				li.classList.add("score-row-watching");
			}
		}

		var rank = document.createElement("span");
		rank.className = "score-rank";
		rank.textContent = row.rank + ".";
		li.appendChild(rank);

		var name = document.createElement("span");
		name.className = "score-name";
		name.textContent = p.name + (p.isOwner ? " ★" : "");
		if (p.isBot && !state.ranked) {
			var tag = document.createElement("span");
			tag.className = "score-bot-tag";
			tag.textContent = "BOT";
			name.appendChild(document.createTextNode(" "));
			name.appendChild(tag);
		}
		if (typeof p.rating === "number") {
			var t = tierFor(p.rating, p.provisional);
			var tierChip = document.createElement("span");
			tierChip.className = "score-tier";
			tierChip.textContent = t.name;
			tierChip.style.color = t.color;
			if (p.id === id) tierChip.title = String(p.rating);
			name.appendChild(document.createTextNode(" "));
			name.appendChild(tierChip);
		}
		li.appendChild(name);

		if (playing) {
			var lp = liveProgress[p.id] || {};
			var pct = Math.round((lp.progress || 0) * 100);
			var trail = document.createElement("span");
			trail.className = "score-progress" + (lp.finished ? " score-progress-finished" : "");
			var fill = document.createElement("span");
			fill.className = "score-progress-fill";
			fill.style.width = (lp.finished ? 100 : pct) + "%";
			trail.appendChild(fill);
			li.appendChild(trail);
			var pctText = document.createElement("span");
			pctText.className = "score-pct";
			pctText.textContent = lp.finished ? "✓" : pct + "%";
			li.appendChild(pctText);
		} else {
			var meta = document.createElement("span");
			meta.className = "score-meta";
			meta.textContent = p.ready ? "Ready" : "Waiting";
			meta.classList.add(p.ready ? "score-meta-ready" : "score-meta-waiting");
			li.appendChild(meta);

			// Running score only matters once a series is underway; a brand-new lobby stays clean.
			if (state.gamesPlayed > 0) {
				var score = document.createElement("span");
				score.className = "score-points";
				score.textContent = p.score;
				if (lastScores[p.id] != null && p.score > lastScores[p.id]) {
					score.classList.add("score-points-bumped");
				}
				li.appendChild(score);
			}
		}

		scoreboardEl.appendChild(li);
	});
}
function populateSelect(select, options, fmt) {
	if (select.options.length === options.length) return;
	select.innerHTML = "";
	options.forEach(function(v) {
		var opt = document.createElement("option");
		opt.value = String(v);
		opt.textContent = fmt(v);
		select.appendChild(opt);
	});
}
