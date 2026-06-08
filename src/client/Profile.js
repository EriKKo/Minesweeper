// Profile view: rating + tier + win-rate summary card.
//
// Renders from `account` (populated by the server on sign-in) and the cached
// rating fields the server updates after each ranked match. The rank chips on
// the home page (renderHomeRankChips) read the same data.

// Profile renders from the account cache plus the most recent leaderboard snapshot.
function renderProfile() {
	// Keybindings are local (not tied to an account), so render the Controls section
	// regardless of sign-in state.
	if (typeof renderKeybindings === "function") renderKeybindings();
	var card = document.getElementById("profile_card");
	if (!card) return;
	if (!account) {
		card.innerHTML = "";
		var p = document.createElement("p");
		p.textContent = "Sign in to see your rating, win rate, and recent matches.";
		card.appendChild(p);
		return;
	}
	card.innerHTML = "";
	var summary = document.createElement("div");
	summary.className = "profile-summary";
	summary.appendChild(buildRankBadge(account.rating));
	var text = document.createElement("div");
	text.className = "profile-summary-text";
	var nameLine = document.createElement("div");
	nameLine.className = "profile-summary-name";
	nameLine.textContent = myName || (account.name || "You");
	text.appendChild(nameLine);
	var ratingLine = document.createElement("div");
	ratingLine.className = "profile-summary-rating";
	var t = tierFor(account.rating, account.provisional);
	ratingLine.textContent = t.name + " · " + (account.provisional ? "~" : "") + account.rating + (account.provisional ? " (provisional)" : "");
	ratingLine.style.color = t.color;
	text.appendChild(ratingLine);
	summary.appendChild(text);
	card.appendChild(summary);

	var stats = document.createElement("div");
	stats.className = "profile-stats";
	var played = (account.played != null) ? account.played : 0;
	var wins = (account.wins != null) ? account.wins : 0;
	var winRate = played > 0 ? Math.round((wins / played) * 100) + "%" : "—";
	stats.appendChild(profileStat("Played", String(played)));
	stats.appendChild(profileStat("Wins", String(wins)));
	stats.appendChild(profileStat("Win rate", winRate));
	card.appendChild(stats);

	var note = document.createElement("p");
	note.className = "section-stub-note";
	note.style.marginTop = "1rem";
	note.textContent = "Per-mode breakdown, match history, and rating chart are coming next.";
	card.appendChild(note);
}

function profileStat(label, value) {
	var box = document.createElement("div");
	box.className = "profile-stat";
	var l = document.createElement("div");
	l.className = "profile-stat-label";
	l.textContent = label;
	box.appendChild(l);
	var v = document.createElement("div");
	v.className = "profile-stat-value";
	v.textContent = value;
	box.appendChild(v);
	return box;
}

function renderHomeRankChips() {
	function applyTo(tierEl, ratingEl, rating) {
		if (!tierEl || !ratingEl) return;
		if (!account) { tierEl.textContent = "—"; tierEl.style.color = ""; ratingEl.textContent = ""; return; }
		var t = tierFor(rating, account.provisional);
		tierEl.textContent = t.name;
		tierEl.style.color = t.color;
		ratingEl.textContent = (account.provisional ? "~" : "") + rating;
	}
	var sprint = account ? (account.ratingSprint != null ? account.ratingSprint : account.rating) : null;
	var standard = account ? (account.ratingStandard != null ? account.ratingStandard : account.rating) : null;
	var tournament = account ? (account.ratingTournament != null ? account.ratingTournament : account.rating) : null;
	// Each playstyle has a single rating; both 1v1 and 6P tiles show the
	// same value so a Sprint player tracks one ladder regardless of size.
	applyTo(rankTierSprint, rankRatingSprint, sprint);
	applyTo(rankTierSprintSix, rankRatingSprintSix, sprint);
	applyTo(rankTierStandard, rankRatingStandard, standard);
	applyTo(rankTierStandardSix, rankRatingStandardSix, standard);
	applyTo(rankTierTournament, rankRatingTournament, tournament);

	var puzzleRatingEl = document.getElementById("puzzle_rating_value");
	var puzzleSolvedEl = document.getElementById("puzzle_solved_count");
	if (puzzleRatingEl) {
		puzzleRatingEl.textContent = account ? (account.puzzleRating || 800) : "—";
	}
	if (puzzleSolvedEl) {
		puzzleSolvedEl.textContent = account
			? (account.puzzlesSolved || 0) + " / " + (account.puzzlesAttempted || 0)
			: "";
	}
	var streakBestEl = document.getElementById("puzzle_streak_best");
	var stormBestEl = document.getElementById("puzzle_storm_best");
	if (streakBestEl) streakBestEl.textContent = account ? (account.streakBest || 0) : "—";
	if (stormBestEl) stormBestEl.textContent = account ? (account.stormBest || 0) : "—";
	var dailyStreakEl = document.getElementById("puzzle_daily_streak");
	var dailyStatusEl = document.getElementById("puzzle_daily_status");
	if (dailyStreakEl) dailyStreakEl.textContent = account ? (account.dailyStreak || 0) : "—";
	if (dailyStatusEl) {
		if (!account) { dailyStatusEl.textContent = ""; }
		else if (!account.dailyAttempt) { dailyStatusEl.textContent = "Not played"; }
		else if (account.dailyAttempt.solved) { dailyStatusEl.textContent = "Solved today"; }
		else { dailyStatusEl.textContent = "Missed today"; }
	}
	renderLobbyDailyBoard();
	renderLobbyDailyState();
}

// Drives state-aware styling on the daily hero (solved / missed / new),
// the button text, and the corner badge over the board preview.
function renderLobbyDailyState() {
	var hero = document.querySelector(".lobby-daily-hero");
	if (!hero) return;
	hero.classList.remove("daily-solved", "daily-missed", "daily-fresh");
	var btn = document.getElementById("open_daily_button");
	var attempt = account && account.dailyAttempt;
	if (!account) {
		if (btn) { btn.textContent = "Sign in to play"; btn.disabled = true; }
		return;
	}
	if (!attempt) {
		hero.classList.add("daily-fresh");
		if (btn) { btn.textContent = "Play today's puzzle"; btn.disabled = false; }
	} else if (attempt.solved) {
		hero.classList.add("daily-solved");
		if (btn) { btn.textContent = "Solved — back tomorrow"; btn.disabled = true; }
	} else {
		hero.classList.add("daily-missed");
		if (btn) { btn.textContent = "Missed — back tomorrow"; btn.disabled = true; }
	}
}

// Paints the daily puzzle's starting position into the lobby hero card.
// Read-only — clicks fall through to the "Play today's puzzle" button.
function renderLobbyDailyBoard() {
	var container = document.getElementById("lobby_daily_board");
	if (!container) return;
	var dateEl = document.getElementById("lobby_daily_date");
	var board = account && account.dailyBoard;
	if (!board) {
		container.innerHTML = '<div class="lobby-daily-board-empty">Sign in to see today’s puzzle.</div>';
		if (dateEl) dateEl.textContent = "";
		return;
	}
	if (dateEl) dateEl.textContent = account.dailyDate || "";
	if (container.dataset.boardKey === board.rows + "x" + board.cols + "@" + account.dailyDate) return;
	container.dataset.boardKey = board.rows + "x" + board.cols + "@" + account.dailyDate;
	container.innerHTML = "";
	var pseudo = {
		title: "",
		rows: board.rows,
		cols: board.cols,
		mines: board.mines,
		revealed: board.revealed
	};
	var puzzleEl = buildLearnPuzzle(pseudo, false, function() {});
	puzzleEl.classList.add("lobby-daily-preview");
	container.appendChild(puzzleEl);
}
