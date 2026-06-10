// Rated puzzle play view.
//
// Architecturally identical to Solo: ask the server for a puzzle, receive
// the obfuscated board, render it in the standard game view via the same
// canvas + Input.js stack. Every click goes to the server (left_click /
// right_click) — server validates against the real game state and decides
// outcome via game.win / game.mineHit. No client-trusted "I solved it".

var puzzleSession = null;  // { puzzleId, totalSafe, totalMines, playerRating, startedAt, finished, result, hintUsed, mode, run }
var puzzleStreak = 0;       // solved-in-a-row across the session; resets on miss / fresh login
var puzzleHintClues = [];   // [[r,c], …] — clue cells highlighted by the active hint
var puzzleHintCovered = []; // [[r,c], …] — covered cells whose status the clues determine
var puzzleRunMode = null;   // "streak" | "storm" while a run is active, else null
var puzzleStormTimer = null; // setInterval for storm countdown rendering
var pendingRunFlash = null; // "solved" | "fail" — primed locally on the click, drained by puzzle_board / puzzle_run_end

// Brief board-border pulse (green = solved, red = miss) used in run modes.
// We buffer the next puzzle_board / puzzle_run_end for the flash duration
// so the feedback lands on the OLD board before the new one swaps in.
function flashRunBoard(kind) {
	var wrap = document.querySelector(".game-view.puzzle .board-wrap");
	if (!wrap) return;
	wrap.classList.remove("flash-solved", "flash-fail");
	void wrap.offsetWidth;
	wrap.classList.add(kind === "solved" ? "flash-solved" : "flash-fail");
}

function withPendingRunFlash(fn) {
	if (!pendingRunFlash) { fn(); return; }
	var kind = pendingRunFlash;
	pendingRunFlash = null;
	flashRunBoard(kind);
	setTimeout(fn, 280);
}

// Called from Input.js performAction after a reveal in puzzle mode — primes
// the flash based on the LOCAL outcome so the visual fires immediately,
// before the server's next message arrives. Only "fail" primes the board
// flash; solve feedback is the big solve-counter bump that fires when the
// next puzzle_board installs, which feels punchier than a board outline.
function notePuzzleReveal(result) {
	if (!puzzleSession) return;
	if (puzzleSession.mode !== "streak" && puzzleSession.mode !== "storm") return;
	if (result.hitMine) pendingRunFlash = "fail";
}

// Show the puzzle play view: trigger a server-side pick. Server responds
// with `puzzle_board` (rated/streak/storm flavor), which routes us into the
// game view with puzzle chrome.
function renderPuzzlePlay(mode) {
	mode = mode || "rated";
	puzzleRunMode = (mode === "streak" || mode === "storm" || mode === "daily") ? mode : null;
	// player_div is shared with the multiplayer view, which leaves an
	// .idle class on it during the lobby's "planning" phase. Clear it
	// so the puzzle board isn't faded behind a "Waiting for series" tag.
	var playerDiv = document.getElementById("player_div");
	if (playerDiv) playerDiv.classList.remove("idle");
	var view = document.getElementById("puzzle_play_view");
	if (!view) return;
	view.innerHTML = "";
	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = mode === "streak" ? "Streak"
		: mode === "storm" ? "Storm"
		: mode === "daily" ? "Daily puzzle"
		: "Rated puzzles";
	view.appendChild(title);

	if (!account) {
		var msg = document.createElement("p");
		msg.className = "puzzle-play-empty";
		msg.textContent = "Sign in to play — your score is tied to your account.";
		view.appendChild(msg);
		return;
	}
	enterGameFullscreen();
	if (mode === "daily") {
		// Check first — if already attempted today, show the result without
		// starting a fresh play.
		var loading = document.createElement("p");
		loading.className = "puzzle-play-empty";
		loading.textContent = "Checking today's puzzle…";
		view.appendChild(loading);
		socket.emit("puzzle_daily_status");
		return;
	}
	var loading2 = document.createElement("p");
	loading2.className = "puzzle-play-empty";
	loading2.textContent = mode === "streak" ? "Starting streak run…"
		: mode === "storm" ? "Starting storm run…"
		: "Finding a puzzle near your rating…";
	view.appendChild(loading2);
	if (mode === "streak") socket.emit("puzzle_streak_start");
	else if (mode === "storm") socket.emit("puzzle_storm_start");
	else socket.emit("puzzle_next");
}

function exitPuzzle() {
	exitGameFullscreen();
	// If a run is active, tell the server to wrap it up so the score gets
	// recorded as a personal-best update if it qualifies.
	if (puzzleSession && (puzzleSession.mode === "streak" || puzzleSession.mode === "storm") && !puzzleSession.finished) {
		socket.emit("puzzle_run_abandon");
	}
	puzzleSession = null;
	puzzleRunMode = null;
	stopStormTicker();
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

function togglePuzzleChrome(on, mode) {
	var card = document.getElementById("puzzle_card");
	if (card) card.style.display = on ? "" : "none";
	var scoreboardCard = document.getElementById("scoreboard_card");
	if (scoreboardCard) scoreboardCard.style.display = on ? "none" : "";
	if (allOpponentsDiv) allOpponentsDiv.style.display = on ? "none" : "";
	if (seriesCard) seriesCard.style.display = on ? "none" : "";
	if (botsCard) botsCard.style.display = on ? "none" : "";
	if (readyButton) readyButton.style.display = on ? "none" : "";
	var hotkeyHint = document.querySelector(".game-view .hotkey-hint");
	if (hotkeyHint) hotkeyHint.style.display = on ? "none" : "";
	var rankedTagEl = document.getElementById("ranked_tag");
	if (rankedTagEl) rankedTagEl.style.display = "none";
	var soloCard = document.getElementById("solo_card");
	if (soloCard) soloCard.style.display = "none";

	if (!on) return;
	var ratedPanel = document.getElementById("puzzle_rated_panel");
	var runPanel = document.getElementById("puzzle_run_panel");
	var titleEl = document.getElementById("puzzle_side_title");
	var primaryLabel = document.getElementById("puzzle_run_primary_label");
	var secondaryLabel = document.getElementById("puzzle_run_secondary_label");
	var footLabel = document.getElementById("puzzle_run_foot_label");
	if (mode === "streak" || mode === "storm" || mode === "daily") {
		if (ratedPanel) ratedPanel.style.display = "none";
		if (runPanel) runPanel.style.display = "";
		if (titleEl) {
			titleEl.textContent = mode === "streak" ? "Streak"
				: mode === "storm" ? "Storm"
				: "Daily puzzle";
		}
		if (primaryLabel) {
			primaryLabel.textContent = mode === "daily" ? "Streak" : "Solved";
		}
		if (secondaryLabel) {
			secondaryLabel.textContent = mode === "streak" ? "Level"
				: mode === "storm" ? "Time"
				: "Today";
		}
		if (footLabel) footLabel.textContent = "Best";
	} else {
		if (ratedPanel) ratedPanel.style.display = "";
		if (runPanel) runPanel.style.display = "none";
		if (titleEl) titleEl.textContent = "Rated puzzles";
	}
}

function updatePuzzleHud() {
	if (!puzzleSession) return;
	if (puzzleSession.mode === "streak" || puzzleSession.mode === "storm") {
		renderPuzzleRunHud();
	} else {
		renderPuzzleRank(puzzleSession.playerRating);
		renderPuzzleStreak();
		updatePuzzleHintButton();
	}
}

function renderPuzzleRunHud() {
	var run = puzzleSession && puzzleSession.run;
	if (!run) return;
	var solvesEl = document.getElementById("puzzle_run_solves");
	if (solvesEl) {
		// Daily uses the streak number as the primary counter; streak/storm
		// use the in-run solve count.
		var newPrimary = run.mode === "daily" ? (run.streak || 0) : (run.solves || 0);
		var prevPrimary = parseInt(solvesEl.textContent, 10);
		if (isNaN(prevPrimary)) prevPrimary = newPrimary;
		solvesEl.textContent = String(newPrimary);
		if (newPrimary > prevPrimary) {
			solvesEl.classList.remove("bump");
			void solvesEl.offsetWidth;
			solvesEl.classList.add("bump");
		}
	}
	var secondary = document.getElementById("puzzle_run_secondary_value");
	if (secondary) {
		if (run.mode === "streak") {
			secondary.textContent = String(run.targetRating || 0);
		} else if (run.mode === "storm") {
			var remaining = Math.max(0, (run.endsAt || 0) - Date.now());
			var sec = Math.ceil(remaining / 1000);
			var m = Math.floor(sec / 60), s = sec % 60;
			secondary.textContent = m + ":" + (s < 10 ? "0" : "") + s;
		} else if (run.mode === "daily") {
			// Trim YYYY-MM-DD → "MMM D" for a friendlier label.
			secondary.textContent = formatDailyDate(run.date || "");
		}
	}
	var bestEl = document.getElementById("puzzle_run_best");
	if (bestEl && account) {
		if (run.mode === "streak") bestEl.textContent = String(account.streakBest || 0);
		else if (run.mode === "storm") bestEl.textContent = String(account.stormBest || 0);
		else if (run.mode === "daily") {
			// Foot reads "Best · solved (Y/N today)" — keep it short.
			bestEl.textContent = puzzleSession && puzzleSession.finished
				? (puzzleSession.run.lastSolved ? "Solved" : "Missed")
				: "—";
		}
	}
}

function formatDailyDate(iso) {
	if (!iso || iso.length < 10) return iso;
	var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
	var y = iso.slice(0, 4), m = parseInt(iso.slice(5, 7), 10), d = parseInt(iso.slice(8, 10), 10);
	return months[m - 1] + " " + d;
}

function startStormTicker() {
	stopStormTicker();
	puzzleStormTimer = setInterval(renderPuzzleRunHud, 250);
}

function stopStormTicker() {
	if (puzzleStormTimer) { clearInterval(puzzleStormTimer); puzzleStormTimer = null; }
}

function renderPuzzleStreak() {
	var chip = document.getElementById("puzzle_streak_chip");
	var countEl = document.getElementById("puzzle_streak_count");
	if (!chip || !countEl) return;
	if (puzzleStreak >= 2) {
		chip.style.display = "";
		countEl.textContent = String(puzzleStreak);
	} else {
		chip.style.display = "none";
	}
}

function clearPuzzleHints() {
	puzzleHintClues = [];
	puzzleHintCovered = [];
}

function updatePuzzleHintButton() {
	var btn = document.getElementById("puzzle_hint_btn");
	if (!btn) return;
	// Re-usable per puzzle — only disabled when the puzzle isn't active.
	// The `used` class still toggles to indicate the Elo penalty is in
	// effect even though the button is still clickable.
	var hintUsed = puzzleSession && puzzleSession.hintUsed;
	btn.disabled = !puzzleSession || puzzleSession.finished;
	btn.classList.toggle("used", !!hintUsed);
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
// auto-advances to the next puzzle — no modal, no blocking action. The
// rating delta lives on the progress bar (floats up next to the rating),
// not in the flash, so the eye is already drawn to the bar as it animates.
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

	// Re-trigger the CSS keyframes by toggling the class.
	flash.classList.remove("playing");
	void flash.offsetWidth;
	flash.classList.add("playing");

	flashPuzzleDelta(result.playerDelta);

	if (puzzleFlashTimer) clearTimeout(puzzleFlashTimer);
	var holdMs = result.solved ? 1200 : 1600;
	puzzleFlashTimer = setTimeout(function() {
		flash.style.display = "none";
		flash.classList.remove("playing");
		if (puzzleSession && puzzleSession.finished) {
			socket.emit("puzzle_next");
		}
	}, holdMs);
}

// Float a "+13" / "-6" badge next to the rating; pairs visually with the
// bar fill sliding to its new width.
function flashPuzzleDelta(delta) {
	var el = document.getElementById("puzzle_rank_delta");
	if (!el) return;
	el.textContent = (delta > 0 ? "+" : "") + delta;
	el.className = "puzzle-rank-delta " + (delta > 0 ? "gain" : delta < 0 ? "loss" : "flat");
	el.classList.remove("playing");
	void el.offsetWidth;
	el.classList.add("playing");
}

function showPuzzleOutcome(result) {
	// A solve auto-advances via the inline flash. A failure swaps the
	// Hint button on the side card for "Try again" / "Next puzzle" — the
	// player picks; the same hint-button slot keeps the actions in a
	// stable location instead of dropping a modal over the board.
	if (!result.solved) {
		flashPuzzleDelta(result.playerDelta);
		setRatedFailActions(true);
		return;
	}
	flashPuzzleResult(result);
}

// Swap the hint button for retry/next buttons (or back). Called with `true`
// after a rated miss, `false` whenever a fresh puzzle_board arrives so the
// hint comes back for the next attempt.
function setRatedFailActions(failed) {
	var hint = document.getElementById("puzzle_hint_btn");
	var actions = document.getElementById("puzzle_fail_actions");
	if (hint) hint.style.display = failed ? "none" : "";
	if (actions) actions.style.display = failed ? "" : "none";
}

// Daily puzzle result panel — shown after the one allowed attempt, or
// when revisiting the daily page after the day's play is done.
function showDailyOutcome(data) {
	stopStormTicker();
	var panel = document.createElement("div");
	panel.className = "result-panel";

	var header = document.createElement("div");
	header.className = "result-header";
	header.textContent = data.solved ? "Daily cleared!" : "Daily missed";
	panel.appendChild(header);

	var line = document.createElement("div");
	line.className = "tournament-place";
	line.style.color = data.solved ? "#4ade80" : "#f87171";
	line.textContent = "Streak · " + data.streak;
	panel.appendChild(line);

	var foot = document.createElement("div");
	foot.className = "result-foot";
	foot.textContent = "Come back tomorrow for a new puzzle.";
	panel.appendChild(foot);

	var actions = document.createElement("div");
	actions.className = "result-actions";
	var back = document.createElement("button");
	back.className = "btn btn-primary";
	back.textContent = "Back to lobby";
	back.addEventListener("click", exitPuzzle);
	actions.appendChild(back);
	panel.appendChild(actions);

	presentPanel(panel, data.solved ? "win" : "lose");
}

// Player visited /puzzles/daily but already played today — show the
// outcome panel without starting a fresh play.
function showDailyAlreadyDone(data) {
	puzzleSession = {
		mode: "daily",
		finished: true,
		run: { mode: "daily", date: data.date, streak: data.streak, lastSolved: data.attempt.solved }
	};
	// Show the side card chrome so the result panel reads naturally.
	hideAllViews();
	if (gameView) {
		gameView.style.display = "";
		gameView.classList.add("puzzle");
	}
	togglePuzzleChrome(true, "daily");
	updatePuzzleHud();
	showDailyOutcome({ date: data.date, solved: data.attempt.solved, streak: data.streak });
}

// Run-end panel (Streak / Storm). Modal-style since the run is done and
// there's no auto-advance to wait for — the player picks retry or back.
function showPuzzleRunOutcome(data) {
	stopStormTicker();
	var panel = document.createElement("div");
	panel.className = "result-panel";

	var header = document.createElement("div");
	header.className = "result-header";
	header.textContent = data.mode === "streak" ? "Streak ended" : "Time's up";
	panel.appendChild(header);

	var scoreLine = document.createElement("div");
	scoreLine.className = "tournament-place";
	scoreLine.style.color = data.score > data.bestBefore ? "#4ade80" : "#cbd5e1";
	scoreLine.textContent = data.mode === "streak"
		? data.score + " peak rating · " + data.solves + " solved"
		: data.solves + " solved";
	panel.appendChild(scoreLine);

	var detail = document.createElement("div");
	detail.className = "result-foot";
	if (data.score > data.bestBefore) {
		detail.textContent = "New personal best!";
		detail.style.color = "#4ade80";
	} else {
		detail.textContent = "Best: " + data.best;
	}
	panel.appendChild(detail);

	var actions = document.createElement("div");
	actions.className = "result-actions";

	var again = document.createElement("button");
	again.className = "btn btn-primary";
	again.textContent = data.mode === "streak" ? "New streak" : "New storm";
	again.addEventListener("click", function() {
		enterGameFullscreen();
		hideOverlay();
		if (data.mode === "streak") socket.emit("puzzle_streak_start");
		else socket.emit("puzzle_storm_start");
	});
	actions.appendChild(again);

	var back = document.createElement("button");
	back.className = "btn btn-secondary";
	back.textContent = "Back to lobby";
	back.addEventListener("click", exitPuzzle);
	actions.appendChild(back);

	panel.appendChild(actions);
	presentPanel(panel, data.score > data.bestBefore ? "win" : "lose");
}
