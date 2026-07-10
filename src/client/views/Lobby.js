// Lobby UI: ranked queue panel (findRanked + setRankedSearching + status
// text), the room list rendered for casual play, and the small formatters
// that label room options (round time, death penalty, mine density, board
// size, series format).
//
// Top-level addEventListener bindings for the lobby buttons stay in the main
// inline script — they need access to DOM elements declared there.

function findRanked(mode) {
	autoEnterGameFullscreen();
	currentRankedMode = mode;
	socket.emit("find_ranked", { mode: mode });
	// Racing modes (1v1 + 6P Sprint/Standard) drop straight into the battle UI and slot opponents
	// into the opponent boards as they're found; territory/tournament use the roster overlay.
	if (typeof isRaceRankedMode === "function" && isRaceRankedMode(mode)) startBattleSearch(mode);
	else setRankedSearching(true, mode);
}
var rankedSearchInfo = null;
var MODE_LABELS = {
	sprint_duo: "1v1 Sprint",   sprint_six: "6-player Sprint",
	standard_duo: "1v1 Standard", standard_six: "6-player Standard",
	tournament: "Tournament",
	territory_duo: "1v1 Territory", territory_quad: "4-player Territory"
};

// Short flavour line shown under the mode label in the waiting room — the
// achtungroyale-style "what this match feels like" tag.
var MODE_TAGLINES = {
	sprint_duo: "Fast race · head-to-head",
	sprint_six: "Fast race · free-for-all",
	standard_duo: "Deduction · head-to-head",
	standard_six: "Dense free-for-all",
	tournament: "Battle royale · 16 → 1",
	territory_duo: "Claim the board · 1v1",
	territory_quad: "Claim the board · 4-player"
};

// Fixed match-search waiting room lives in the bottom-right while queued — it
// survives navigation so the player can poke around the rest of the UI
// without losing their place in line. The elapsed timer ticks while
// the toast is visible, and the roster fills in as players/bots arrive.
var rankedSearchStart = 0;
var rankedSearchTickHandle = null;
var matchToastModeEl = document.getElementById("match_toast_mode");
var matchToastElapsedEl = document.getElementById("match_toast_elapsed");
var matchToastTaglineEl = document.getElementById("match_toast_tagline");
var matchRosterEl = document.getElementById("match_roster");
var searchProgressFill = document.getElementById("search_progress_fill");
var matchToastEl = document.querySelector("#ranked_searching .match-toast");
// The waiting room takes the mode's accent colour (amber sprint / violet standard / gold
// tournament / cyan territory) so each queue feels distinct; CSS maps the data-style.
function searchStyleOf(mode) { return (mode || "").split("_")[0] || "sprint"; }
// How many roster rows were filled on the previous render — lets us animate
// only the newly-arrived rows, not re-flash everyone on each broadcast.
var matchRosterShown = 0;

function setRankedSearching(on, mode) {
	if (on) rankedSearching.removeAttribute("hidden");
	else rankedSearching.setAttribute("hidden", "");
	if (on) {
		rankedSearchStart = Date.now();
		updateRankedSearchingText();
		updateRankedSearchingElapsed();
		if (rankedSearchTickHandle) clearInterval(rankedSearchTickHandle);
		rankedSearchTickHandle = setInterval(updateRankedSearchingElapsed, 500);
	} else {
		rankedSearchInfo = null;
		matchRosterShown = 0;
		if (matchRosterEl) matchRosterEl.innerHTML = "";
		if (rankedSearchTickHandle) { clearInterval(rankedSearchTickHandle); rankedSearchTickHandle = null; }
	}
	// currentRankedMode stays set after match formation so series-end can re-queue.
}

function updateRankedSearchingElapsed() {
	if (!matchToastElapsedEl) return;
	var s = Math.floor((Date.now() - rankedSearchStart) / 1000);
	var m = Math.floor(s / 60);
	matchToastElapsedEl.textContent = m + ":" + ((s % 60) < 10 ? "0" : "") + (s % 60);
}

function updateRankedSearchingText() {
	var info = rankedSearchInfo || {};
	var count = info.count || 1, size = info.size || 2;
	var mode = info.mode || currentRankedMode;
	var modeLabel = MODE_LABELS[mode] || "Ranked";
	var ready = count >= size;
	rankedSearchingText.textContent = ready ? "Match found" : "Finding match";
	if (matchToastEl) {
		matchToastEl.dataset.style = searchStyleOf(mode);
		matchToastEl.classList.toggle("match-toast-ready", ready);
	}
	if (matchToastModeEl) matchToastModeEl.textContent = modeLabel;
	if (matchToastTaglineEl) matchToastTaglineEl.textContent = MODE_TAGLINES[mode] || "";
	if (searchCountText) searchCountText.textContent = count;
	if (searchSizeText) searchSizeText.textContent = size;
	if (searchProgressFill) {
		var ratio = Math.max(0, Math.min(1, count / size));
		searchProgressFill.style.width = (ratio * 100) + "%";
	}
	renderMatchRoster(info);
}

// The waiting-room roster: one row per match slot. Filled slots show the
// player/bot name (+ a "YOU" tag for self) and a tier chip; the rest are muted
// "Waiting…" placeholders. Re-rendered on every ranked_searching broadcast, so
// the list visibly fills as bots/humans arrive. Only rows beyond the last
// render's fill count get the entrance animation, so existing rows don't
// re-flash each tick.
function renderMatchRoster(info) {
	if (!matchRosterEl) return;
	var size = info.size || 2;
	var members = info.members || [];
	matchRosterEl.innerHTML = "";
	for (var i = 0; i < size; i++) {
		var row = document.createElement("li");
		row.className = "match-roster-row";
		var m = members[i];
		if (m) {
			if (m.isYou) row.classList.add("match-roster-row-you");
			// Animate only freshly-arrived rows (index >= what we showed last time).
			if (i >= matchRosterShown) row.classList.add("match-roster-row-new");

			if (typeof m.rating === "number" && typeof buildRankBadge === "function") {
				var badge = buildRankBadge(m.rating);
				badge.classList.add("match-roster-badge");
				row.appendChild(badge);
			}

			var name = document.createElement("span");
			name.className = "match-roster-name";
			name.textContent = m.name;
			row.appendChild(name);
			if (m.isYou) {
				var youTag = document.createElement("span");
				youTag.className = "match-roster-you-tag";
				youTag.textContent = "YOU";
				row.appendChild(youTag);
			}
			// The rank badge already conveys the tier, so no separate tier chip here.
		} else {
			row.classList.add("match-roster-slot-empty");
			var waiting = document.createElement("span");
			waiting.className = "match-roster-waiting";
			waiting.textContent = "Waiting…";
			row.appendChild(waiting);
		}
		matchRosterEl.appendChild(row);
	}
	matchRosterShown = Math.min(members.length, size);
}

function formatRoundTime(s) {
	if (s <= 0) return "0:00";
	var m = Math.floor(s / 60);
	var sec = s % 60;
	return m + ":" + (sec < 10 ? "0" : "") + sec;
}

function formatRoundOption(s) {
	return s === 0 ? "Unlimited" : (s % 60 === 0 ? (s/60) + " min" : s + "s");
}

function formatPenaltyOption(s) {
	return s === 0 ? "None" : s + "s";
}

// Mirror of the server's board presets, for option labels.
var BOARD_DIMS = { small: [10, 13], medium: [15, 20], large: [16, 30] };

// Low / Medium / High map to 10 / 15 / 20% mines. Keyed by integer percent to
// dodge float-equality issues; anything else just shows the raw percentage.
var DENSITY_LABELS = { 10: "Low", 15: "Medium", 20: "High" };
function formatMineDensity(d) {
	var pct = Math.round(d * 100);
	var label = DENSITY_LABELS[pct];
	return label ? label + " (" + pct + "%)" : pct + "%";
}

function formatBoardSize(size) {
	var dims = BOARD_DIMS[size];
	var label = size.charAt(0).toUpperCase() + size.slice(1);
	return dims ? label + " (" + dims[0] + "×" + dims[1] + ")" : label;
}

function applyBoardDims(newRows, newCols) {
	if (!newRows || !newCols || (newRows === rows && newCols === cols)) return;
	rows = newRows;
	cols = newCols;
	sizePlayerCanvas();
	sizeOpponentCanvases();
	focusedR = Math.floor(rows / 2);
	focusedC = Math.floor(cols / 2);
}

// Sub-tier ladder: Bronze 1 → 2 → 3 → Silver 1 → ... → Diamond 3 → Master.
// Bronze 1 starts at the DB default rating (1000); 50 ELO per sub-tier, 150 per
// tier, Master is the open-ended top at 1750+. Provisional players still get a
// real tier so progress is visible — the `~` rating prefix elsewhere signals
// that the number hasn't settled yet.
// Tier constants + rank helpers moved to Ranking.js.

// Series progress label: ranked plays exactly one match per lobby; casual plays
// a best-of-N. Tournament prints "Round N/M · K remaining".
function formatGameProgress(gameNumber, gameCount, scoreTarget) {
	if (currentRoom && currentRoom.rankedMode === "tournament") {
		var remaining = currentRoom.players ? currentRoom.players.length : 0;
		// "X cut" is the COTD-style danger counter: at a glance you know how
		// many heads are about to roll without scanning the standings.
		var schedule = currentRoom.tournamentSchedule || [];
		var nextSurvivors = schedule[gameNumber - 1];
		var willCut = (typeof nextSurvivors === "number") ? Math.max(0, remaining - nextSurvivors) : 0;
		var cutPart = willCut > 0 ? " · " + willCut + " cut" : "";
		return "Round " + gameNumber + " of " + gameCount + " · " + remaining + " alive" + cutPart;
	}
	if (scoreTarget) return "Game " + gameNumber + " · First to " + scoreTarget;
	if (gameCount === 1) {
		var mode = currentRoom && currentRoom.rankedMode;
		return mode ? (MODE_LABELS[mode] || "Ranked") + " match" : "Single match";
	}
	return "Game " + gameNumber + " of " + gameCount;
}

function formatSeriesFormat(gameCount, scoreTarget) {
	if (scoreTarget) return "First to " + scoreTarget;
	if (gameCount === 1) return "One match";
	if (currentRoom && currentRoom.rankedMode === "tournament") return "Battle royale · 16 → 1";
	return "Best of " + gameCount;
}
function renderRoomList(rooms) {
	var openRooms = rooms.filter(function(r) { return r.phase === "planning"; });
	var busyRooms = rooms.filter(function(r) { return r.phase !== "planning"; });

	openRoomList.innerHTML = "";
	if (openRooms.length === 0) {
		openRoomList.appendChild(emptyRow("No open lobbies. Create one to get started."));
	} else {
		openRooms.forEach(function(r) { openRoomList.appendChild(roomRow(r, true)); });
	}

	busyRoomList.innerHTML = "";
	if (busyRooms.length === 0) {
		busyRoomList.appendChild(emptyRow("No games in progress."));
	} else {
		busyRooms.forEach(function(r) { busyRoomList.appendChild(roomRow(r, false)); });
	}
}

// Compact active-rooms strip for the home dashboard aside (replaces the old
// "Top players" leaderboard). Shows open rooms first (joinable), then in-progress
// ones, capped so the card stays short — the "Browse Custom Lobbies" button leads
// to the full list. Open + not-full rooms get a Join button; everything else a tag.
var HOME_ROOMS_MAX = 6;
function renderHomeRooms(rooms) {
	var list = document.getElementById("home_room_list");
	if (!list) return;
	// This is always a real room_list response (there's no intermediate placeholder state to wait
	// past) — safe to reveal unconditionally (see hideSkeleton() in Router.js).
	if (typeof hideSkeleton === "function") hideSkeleton("dash_rooms_skel");
	var open = rooms.filter(function(r) { return r.phase === "planning"; });
	var busy = rooms.filter(function(r) { return r.phase !== "planning"; });
	var ordered = open.concat(busy);
	list.innerHTML = "";
	if (ordered.length === 0) {
		var empty = document.createElement("li");
		empty.className = "room-empty";
		empty.textContent = "No active lobbies right now.";
		list.appendChild(empty);
		return;
	}
	ordered.slice(0, HOME_ROOMS_MAX).forEach(function(r) {
		list.appendChild(homeRoomRow(r));
	});
	var extra = ordered.length - HOME_ROOMS_MAX;
	if (extra > 0) {
		var more = document.createElement("li");
		more.className = "dash-rooms-more";
		more.textContent = "+" + extra + " more";
		list.appendChild(more);
	}
}

function homeRoomRow(room) {
	var joinable = room.phase === "planning";
	var full = room.playerCount >= room.maxPlayers;
	var li = document.createElement("li");
	li.className = "dash-room-row";

	var info = document.createElement("div");
	info.className = "dash-room-info";
	var title = document.createElement("span");
	title.className = "dash-room-title";
	title.textContent = room.ownerName + "'s lobby";
	info.appendChild(title);
	var meta = document.createElement("span");
	meta.className = "dash-room-meta";
	var dims = BOARD_DIMS[room.boardSize];
	meta.textContent = room.playerCount + "/" + room.maxPlayers + " players"
		+ (dims ? " · " + dims[0] + "×" + dims[1] : "");
	info.appendChild(meta);
	li.appendChild(info);

	if (joinable && !full) {
		var joinBtn = document.createElement("button");
		joinBtn.className = "btn btn-secondary dash-room-join";
		joinBtn.textContent = "Join";
		joinBtn.addEventListener("click", function() { socket.emit("join_room", { roomId: room.id }); });
		li.appendChild(joinBtn);
	} else {
		var tag = document.createElement("span");
		tag.className = "dash-room-tag" + (joinable ? " dash-room-tag-full" : "");
		tag.textContent = joinable ? "Full" : "In game";
		li.appendChild(tag);
	}
	return li;
}

function emptyRow(text) {
	var li = document.createElement("li");
	li.className = "room-empty";
	li.textContent = text;
	return li;
}

function roomChip(text, cls) {
	var s = document.createElement("span");
	s.className = "room-chip" + (cls ? " " + cls : "");
	s.textContent = text;
	return s;
}

function roomRow(room, joinable) {
	var li = document.createElement("li");
	li.className = "room-row";

	var info = document.createElement("div");
	info.className = "room-info";

	var title = document.createElement("div");
	title.className = "room-title";
	title.textContent = room.ownerName + "'s lobby";
	info.appendChild(title);

	// At-a-glance ruleset chips: how full it is, then the board/density/timer/series options.
	var chips = document.createElement("div");
	chips.className = "room-chips";
	var full = room.playerCount >= room.maxPlayers;
	chips.appendChild(roomChip(room.playerCount + " / " + room.maxPlayers + " players",
		"room-chip-players" + (full ? " room-chip-full" : "")));
	var dims = BOARD_DIMS[room.boardSize];
	if (dims) chips.appendChild(roomChip(dims[0] + "×" + dims[1]));
	if (typeof room.mineDensity === "number") chips.appendChild(roomChip(Math.round(room.mineDensity * 100) + "% mines"));
	chips.appendChild(roomChip(formatRoundOption(room.roundSeconds)));
	chips.appendChild(roomChip(room.gameCount === 1 ? "Single game" : "Best of " + room.gameCount));
	info.appendChild(chips);

	var meta = document.createElement("div");
	meta.className = "room-meta";
	meta.textContent = (room.phase === "planning" ? "" : "Game " + room.gamesPlayed + " of " + room.gameCount + " · ")
		+ room.players.join(", ");
	info.appendChild(meta);

	li.appendChild(info);

	if (joinable) {
		var joinBtn = document.createElement("button");
		joinBtn.className = "btn btn-secondary room-join";
		joinBtn.textContent = full ? "Full" : "Join";
		joinBtn.disabled = full;
		joinBtn.addEventListener("click", function() {
			socket.emit("join_room", { roomId: room.id });
		});
		li.appendChild(joinBtn);
	} else {
		var badge = document.createElement("span");
		badge.className = "room-badge";
		badge.textContent = "In game";
		li.appendChild(badge);
	}

	return li;
}
