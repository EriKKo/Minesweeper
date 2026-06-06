// Lobby UI: ranked queue panel (findRanked + setRankedSearching + status
// text), the room list rendered for casual play, and the small formatters
// that label room options (round time, death penalty, mine density, board
// size, series format).
//
// Top-level addEventListener bindings for the lobby buttons stay in the main
// inline script — they need access to DOM elements declared there.

function findRanked(mode) {
	currentRankedMode = mode;
	socket.emit("find_ranked", { mode: mode });
	setRankedSearching(true, mode);
}
var rankedSearchInfo = null;
var MODE_LABELS = {
	sprint_duo: "1v1 Sprint",   sprint_six: "6-player Sprint",
	standard_duo: "1v1 Standard", standard_six: "6-player Standard",
	tournament: "Tournament"
};

// Fixed match-search toast lives in the bottom-right while queued — it
// survives navigation so the player can poke around the rest of the UI
// without losing their place in line. The elapsed timer ticks while
// the toast is visible.
var rankedSearchStart = 0;
var rankedSearchTickHandle = null;
var matchToastModeEl = document.getElementById("match_toast_mode");
var matchToastElapsedEl = document.getElementById("match_toast_elapsed");
var searchProgressFill = document.getElementById("search_progress_fill");

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
	var modeLabel = MODE_LABELS[info.mode || currentRankedMode] || "Ranked";
	rankedSearchingText.textContent = count >= size
		? "Match found — joining…"
		: "Finding match…";
	if (matchToastModeEl) matchToastModeEl.textContent = modeLabel;
	if (searchCountText) searchCountText.textContent = count;
	if (searchSizeText) searchSizeText.textContent = size;
	if (searchProgressFill) {
		var ratio = Math.max(0, Math.min(1, count / size));
		searchProgressFill.style.width = (ratio * 100) + "%";
	}
}

// (Old slot rendering intentionally removed — the searching view shows only a
// player count + filling ring; the full lobby reveals once the match starts.)

function renderRankedSlots_DISABLED(info) {
	if (!rankedSlotsEl) return;
	var size = info.size || 4;
	var members = info.members || [];
	rankedSlotsEl.innerHTML = "";
	for (var i = 0; i < size; i++) {
		var slot = document.createElement("div");
		slot.className = "ranked-slot";
		var m = members[i];
		if (m) {
			if (m.isYou) slot.classList.add("ranked-slot-you");
			var name = document.createElement("div");
			name.className = "ranked-slot-name";
			name.textContent = m.name;
			if (m.isYou) {
				var youTag = document.createElement("span");
				youTag.className = "ranked-slot-you-tag";
				youTag.textContent = "YOU";
				name.appendChild(document.createTextNode(" "));
				name.appendChild(youTag);
			}
			slot.appendChild(name);

			var meta = document.createElement("div");
			meta.className = "ranked-slot-meta";
			var t = tierFor(m.rating, m.provisional);
			var tierEl = document.createElement("span");
			tierEl.className = "ranked-slot-tier";
			tierEl.textContent = t.name;
			tierEl.style.color = t.color;
			meta.appendChild(tierEl);
			// Only the player sees their own exact rating; opponents are tier-only.
			if (m.isYou) {
				var ratingEl = document.createElement("span");
				ratingEl.className = "ranked-slot-rating";
				ratingEl.textContent = (m.provisional ? "~" : "") + m.rating;
				meta.appendChild(ratingEl);
			}
			slot.appendChild(meta);
		} else {
			slot.classList.add("ranked-slot-empty");
			slot.textContent = "Searching for opponent…";
		}
		rankedSlotsEl.appendChild(slot);
	}
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

function formatMineDensity(d) {
	return Math.round(d * 100) + "%";
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
	for (var i = 1; i <= 5; i++) sizeBoardCanvas(document.getElementById("game" + i), OPP_CELL);
	playerCanvasWidth = playerCanvas.width;
	playerCanvasHeight = playerCanvas.height;
	playerCanvasSquareWidth = playerCanvasWidth / cols;
	playerCanvasSquareHeight = playerCanvasHeight / rows;
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
		return "Round " + gameNumber + " of " + gameCount + " · " + remaining + " remaining";
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
		openRoomList.appendChild(emptyRow("No open rooms. Create one to get started."));
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

function emptyRow(text) {
	var li = document.createElement("li");
	li.className = "room-empty";
	li.textContent = text;
	return li;
}

function roomRow(room, joinable) {
	var li = document.createElement("li");
	li.className = "room-row";

	var info = document.createElement("div");
	info.className = "room-info";

	var title = document.createElement("div");
	title.className = "room-title";
	title.textContent = room.ownerName + "'s room";
	info.appendChild(title);

	var meta = document.createElement("div");
	meta.className = "room-meta";
	var statusText;
	if (room.phase === "planning") {
		statusText = "Best of " + room.gameCount;
	} else {
		statusText = "Game " + room.gamesPlayed + " of " + room.gameCount;
	}
	meta.textContent = room.playerCount + "/" + room.maxPlayers + " · " + statusText + " · " + room.players.join(", ");
	info.appendChild(meta);

	li.appendChild(info);

	if (joinable) {
		var joinBtn = document.createElement("button");
		joinBtn.className = "btn btn-secondary";
		joinBtn.textContent = "Join";
		joinBtn.disabled = room.playerCount >= room.maxPlayers;
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
