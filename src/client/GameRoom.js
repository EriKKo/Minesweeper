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

function renderRoomState(state) {
	var isOwner = state.owner === id;
	populateSelect(gameCountSelect, state.gameCountOptions, function(n) { return String(n); });
	populateSelect(roundSecondsSelect, state.roundSecondsOptions, formatRoundOption);
	populateSelect(deathPenaltySelect, state.deathPenaltyOptions, formatPenaltyOption);
	populateSelect(boardSizeSelect, state.boardSizeOptions, formatBoardSize);
	populateSelect(mineDensitySelect, state.mineDensityOptions, formatMineDensity);

	gameCountSelect.value = String(state.gameCount);
	roundSecondsSelect.value = String(state.roundSeconds);
	deathPenaltySelect.value = String(state.deathPenalty);
	boardSizeSelect.value = String(state.boardSize);
	mineDensitySelect.value = String(state.mineDensity);

	rankedTag.style.display = state.ranked ? "" : "none";
	// Ranked rooms have a locked ruleset — show the values read-only, even to the owner.
	var showSelects = isOwner && !state.ranked;
	var canEdit = showSelects && state.phase === "planning";
	gameCountSelect.disabled = !canEdit;
	roundSecondsSelect.disabled = !canEdit;
	deathPenaltySelect.disabled = !canEdit;
	boardSizeSelect.disabled = !canEdit;
	mineDensitySelect.disabled = !canEdit;
	gameCountSelect.style.display = showSelects ? "" : "none";
	roundSecondsSelect.style.display = showSelects ? "" : "none";
	deathPenaltySelect.style.display = showSelects ? "" : "none";
	boardSizeSelect.style.display = showSelects ? "" : "none";
	mineDensitySelect.style.display = showSelects ? "" : "none";
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
	allOpponentsDiv.style.display = playing ? "" : "none";
	seriesCard.style.display = (playing || state.ranked) ? "none" : "";
	var showBotCard = !playing && !state.ranked && (isOwner || (state.botCount && state.botCount > 0));
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
			botStatus.textContent = state.botCount + " bot" + (state.botCount === 1 ? "" : "s") + " in this room.";
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

	renderScoreboard();
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
	// player_div is shared with puzzle play AND territory. Only toggle the "Waiting for series to
	// start" idle overlay when we're actually viewing the multiplayer lobby — otherwise room_state
	// ticks would fade out the puzzle board mid-play, or fade the territory board after a match
	// (territory has no series, so it should never go idle).
	var inTerritory = (typeof territoryActive !== "undefined" && territoryActive);
	var inMpView = (location.pathname === "/");
	if (inMpView && !inTerritory) {
		document.getElementById("player_div").classList.toggle("idle", state.phase === "planning");
	} else if (inTerritory) {
		document.getElementById("player_div").classList.remove("idle");
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
			if (p.id === id) tierChip.title = (p.provisional ? "~" : "") + p.rating;
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

			var score = document.createElement("span");
			score.className = "score-points";
			score.textContent = p.score;
			if (lastScores[p.id] != null && p.score > lastScores[p.id]) {
				score.classList.add("score-points-bumped");
			}
			li.appendChild(score);
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
