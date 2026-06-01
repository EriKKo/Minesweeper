// Rated puzzle play view.
//
// Architecturally identical to Solo: ask the server for a puzzle, receive
// the obfuscated board, render it in the standard game view via the same
// canvas + Input.js stack. Every click goes to the server (left_click /
// right_click) — server validates against the real game state and decides
// outcome via game.win / game.mineHit. No client-trusted "I solved it".

var puzzleSession = null;  // { puzzleId, totalSafe, totalMines, playerRating, startedAt, finished, result }

// Show the puzzle play view: trigger a server-side pick. The server responds
// with `puzzle_board`, which routes us into the game view in puzzle chrome.
function renderPuzzlePlay() {
	var view = document.getElementById("puzzle_play_view");
	if (!view) return;
	view.innerHTML = "";
	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Rated puzzles";
	view.appendChild(title);

	if (!account) {
		var msg = document.createElement("p");
		msg.className = "puzzle-play-empty";
		msg.textContent = "Sign in to play rated puzzles — your rating is tied to your account.";
		view.appendChild(msg);
		return;
	}
	var loading = document.createElement("p");
	loading.className = "puzzle-play-empty";
	loading.textContent = "Finding a puzzle near your rating…";
	view.appendChild(loading);
	socket.emit("puzzle_next");
}

function exitPuzzle() {
	puzzleSession = null;
	if (puzzleFlashTimer) { clearTimeout(puzzleFlashTimer); puzzleFlashTimer = null; }
	var flash = document.getElementById("puzzle_flash");
	if (flash) { flash.style.display = "none"; flash.classList.remove("playing"); }
	togglePuzzleChrome(false);
	if (gameView) {
		gameView.classList.remove("puzzle");
	}
	hideOverlay();
	myState = null;
	prevPlayerState = null;
	boardDecoder = null;
	location.hash = "#/";
}

function togglePuzzleChrome(on) {
	// Puzzles: just the board + the rank bar below it. Everything else in
	// the game-view chrome (side panels, ready button, hotkey hint, ranked
	// tag) is multiplayer-only — hide them for the entire puzzle session.
	var inlineRank = document.getElementById("puzzle_inline_rank");
	if (inlineRank) inlineRank.style.display = on ? "" : "none";
	var gameSide = document.querySelector(".game-side");
	if (gameSide) gameSide.style.display = on ? "none" : "";
	if (readyButton) readyButton.style.display = on ? "none" : "";
	var hotkeyHint = document.querySelector(".game-view .hotkey-hint");
	if (hotkeyHint) hotkeyHint.style.display = on ? "none" : "";
	var rankedTagEl = document.getElementById("ranked_tag");
	if (rankedTagEl) rankedTagEl.style.display = "none";
	var soloCard = document.getElementById("solo_card");
	if (soloCard) soloCard.style.display = "none";
}

function updatePuzzleHud() {
	if (!puzzleSession) return;
	renderPuzzleRank(puzzleSession.playerRating);
}

// Puzzle-specific tier ladder. Wider bands than the ranked ladder so the
// progression feels meaningful at the rate puzzle ratings change (K=20 means
// ~10 points per solve at parity, so a 250-point band fills in ~25 puzzles).
// Ratings start at 800, the top of generated puzzle ratings is ~3000, so the
// ladder spans roughly that range.
var PUZZLE_TIERS = [
	{ name: "Novice",      start: 0,    color: "#94a3b8" },
	{ name: "Apprentice",  start: 800,  color: "#d08b5b" },
	{ name: "Skilled",     start: 1100, color: "#cbd5e1" },
	{ name: "Advanced",    start: 1400, color: "#fbbf24" },
	{ name: "Expert",      start: 1700, color: "#5eead4" },
	{ name: "Master",      start: 2000, color: "#60a5fa" },
	{ name: "Grandmaster", start: 2400, color: "#c084fc" }
];

function puzzleTierFor(rating) {
	for (var i = PUZZLE_TIERS.length - 1; i >= 0; i--) {
		if (rating >= PUZZLE_TIERS[i].start) {
			var next = PUZZLE_TIERS[i + 1] || null;
			return {
				name: PUZZLE_TIERS[i].name,
				color: PUZZLE_TIERS[i].color,
				start: PUZZLE_TIERS[i].start,
				end: next ? next.start : null,
				next: next
			};
		}
	}
	return { name: PUZZLE_TIERS[0].name, color: PUZZLE_TIERS[0].color, start: 0, end: PUZZLE_TIERS[1].start, next: PUZZLE_TIERS[1] };
}

function renderPuzzleRank(rating) {
	var tierEl = document.getElementById("puzzle_rank_tier");
	var ratingEl = document.getElementById("puzzle_rank_rating");
	var fillEl = document.getElementById("puzzle_rank_fill");
	var progEl = document.getElementById("puzzle_rank_progress");
	var nextEl = document.getElementById("puzzle_rank_next");
	if (!tierEl || rating == null) return;

	var info = puzzleTierFor(rating);
	tierEl.textContent = info.name;
	tierEl.style.color = info.color;
	ratingEl.textContent = String(rating);

	if (info.end == null) {
		// Top tier — bar is full, no "next" label.
		fillEl.style.width = "100%";
		fillEl.style.background = info.color;
		progEl.textContent = "Maxed";
		nextEl.textContent = "";
	} else {
		var bandWidth = info.end - info.start;
		var within = Math.max(0, Math.min(bandWidth, rating - info.start));
		fillEl.style.width = (within / bandWidth * 100) + "%";
		fillEl.style.background = info.color;
		progEl.textContent = within + " / " + bandWidth;
		nextEl.textContent = "→ " + info.next.name;
	}
}

var puzzleFlashTimer = null;

// Brief floating overlay over the board after solve/fail. Auto-fades and
// auto-advances to the next puzzle — no modal, no blocking action.
function flashPuzzleResult(result) {
	var flash = document.getElementById("puzzle_flash");
	if (!flash) return;
	flash.className = "puzzle-flash " + (result.solved ? "puzzle-flash-solved" : "puzzle-flash-fail");
	flash.style.display = "";
	flash.innerHTML = "";

	var icon = document.createElement("div");
	icon.className = "puzzle-flash-icon";
	icon.textContent = result.solved ? "✓" : "✗";
	flash.appendChild(icon);

	var label = document.createElement("div");
	label.className = "puzzle-flash-label";
	label.textContent = result.solved ? "Solved" : "Mine hit";
	flash.appendChild(label);

	var delta = document.createElement("div");
	delta.className = "puzzle-flash-delta";
	delta.textContent = (result.playerDelta > 0 ? "+" : "") + result.playerDelta;
	flash.appendChild(delta);

	// Trigger CSS animation by re-adding the class — toggle ensures the
	// keyframes restart even if we flash twice in a row.
	flash.classList.remove("playing");
	void flash.offsetWidth; // force reflow
	flash.classList.add("playing");

	if (puzzleFlashTimer) clearTimeout(puzzleFlashTimer);
	var holdMs = result.solved ? 1200 : 1600;
	puzzleFlashTimer = setTimeout(function() {
		flash.style.display = "none";
		flash.classList.remove("playing");
		// Auto-advance only if the user hasn't navigated away during the flash.
		if (puzzleSession && puzzleSession.finished) {
			socket.emit("puzzle_next");
		}
	}, holdMs);
}

function showPuzzleOutcome(result) {
	// Replaces the old modal panel with the inline flash + auto-advance.
	flashPuzzleResult(result);
}
