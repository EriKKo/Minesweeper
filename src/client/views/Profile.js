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
	var overall = overallRating(account); // best across modes — the headline rank
	summary.appendChild(buildRankBadge(overall));
	var text = document.createElement("div");
	text.className = "profile-summary-text";
	var nameLine = document.createElement("div");
	nameLine.className = "profile-summary-name";
	nameLine.textContent = myName || (account.name || "You");
	text.appendChild(nameLine);
	var ratingLine = document.createElement("div");
	ratingLine.className = "profile-summary-rating";
	var t = tierFor(overall, account.provisional);
	ratingLine.textContent = t.name + " · " + overall;
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
	function applyTo(tierEl, ratingEl, rating, badgeId) {
		var badgeEl = badgeId ? document.getElementById(badgeId) : null;
		if (badgeEl) {
			badgeEl.innerHTML = "";
			if (account && typeof rating === "number") badgeEl.appendChild(buildRankBadge(rating));
		}
		if (!tierEl || !ratingEl) return;
		if (!account) { tierEl.textContent = "—"; tierEl.style.color = ""; ratingEl.textContent = ""; return; }
		var t = tierFor(rating, account.provisional);
		tierEl.textContent = t.name;
		tierEl.style.color = t.color;
		ratingEl.textContent = rating;
	}
	var sprint = account ? account.ratingSprint : null;
	var standard = account ? account.ratingStandard : null;
	// Only Sprint + Standard are surfaced on the home page now; Tournament/Territory live under Admin.
	applyTo(rankTierSprint, rankRatingSprint, sprint, "rank_badge_sprint");
	applyTo(rankTierStandard, rankRatingStandard, standard, "rank_badge_standard");

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
	renderDashIdentity();
	renderModeBoardPreviews();
}

// ---- Home dashboard: the "you" banner + the per-mode board previews ----

// The "you" banner: rank badge (overall = best across modes), name, overall tier/rating, and a
// few real lifetime stats. No fabricated "this week" trend — we don't track it yet.
function renderDashIdentity() {
	var nameEl = document.getElementById("dash_you_name");
	if (!nameEl) return; // dashboard markup not present
	var badgeEl = document.getElementById("dash_you_badge");
	var lineEl = document.getElementById("dash_you_line");
	var statsEl = document.getElementById("dash_you_stats");
	nameEl.textContent = (typeof myName !== "undefined" && myName) || (account && account.name) || "Player";
	if (!account) {
		if (badgeEl) badgeEl.innerHTML = "";
		if (lineEl) lineEl.textContent = "Sign in to track your rank.";
		if (statsEl) statsEl.innerHTML = "";
		return;
	}
	var overall = overallRating(account);
	var t = tierFor(overall, account.provisional);
	if (badgeEl) { badgeEl.innerHTML = ""; badgeEl.appendChild(buildRankBadge(overall)); }
	if (lineEl) lineEl.innerHTML = "Overall <b style=\"color:" + t.color + "\">" + t.name + "</b> · " + overall;
	if (statsEl) {
		var played = account.played || 0, wins = account.wins || 0;
		var wr = played ? Math.round(wins / played * 100) + "%" : "—";
		function cell(label, val) { return "<span class=\"dash-stat\"><b>" + val + "</b><span>" + label + "</span></span>"; }
		statsEl.innerHTML = cell("Played", played) + cell("Win rate", wr) + cell("Daily streak", "🔥 " + (account.dailyStreak || 0));
	}
}

// Fixed board previews for each mode, in the standard board format the game renderer
// (buildLearnPuzzle) consumes: { rows, cols, mines, revealed, flagged } as lists of [row, col], with
// flags pre-placed. Sprint is a sparse, wide-open field; Standard a tight opening in a denser
// minefield; Custom a medium board; Puzzles a small, tight cascade (no flags). Rendered once per load
// and frozen (pointer-events: none). Edit a board's cells directly to retune it.
var DASH_MODE_BOARDS = {
	sprint: {
		rows: 6, cols: 10,
		mines: [[0,0],[0,3],[1,1],[3,3],[3,7],[3,8]],
		revealed: [[0,4],[0,5],[0,6],[0,7],[0,8],[0,9],[1,4],[1,5],[1,6],[1,7],[1,8],[1,9],[2,0],[2,1],[2,2],[2,4],[2,5],[2,6],[2,7],[2,8],[2,9],[3,0],[3,1],[3,2],[3,4],[3,5],[3,6],[4,0],[4,1],[4,2],[4,3],[4,4],[4,5],[4,6],[4,7],[4,8],[4,9],[5,0],[5,1],[5,2],[5,3],[5,4],[5,5],[5,6],[5,7],[5,8],[5,9]],
		flagged: [[3,3],[3,7],[3,8]]
	},
	standard: {
		rows: 6, cols: 9,
		mines: [[0,2],[0,3],[1,1],[1,6],[2,0],[2,6],[2,8],[3,0],[3,6],[3,7],[3,8],[4,1],[4,8],[5,2]],
		revealed: [[1,2],[1,3],[1,4],[1,5],[2,2],[2,3],[2,4],[2,5],[3,2],[3,3],[3,4],[3,5],[4,2],[4,3],[4,4],[4,5],[4,6],[4,7],[5,3],[5,4],[5,5],[5,6],[5,7]],
		flagged: [[1,6],[2,6],[3,6],[3,7],[5,2]]
	},
	custom: {
		rows: 6, cols: 9,
		mines: [[0,5],[0,7],[1,6],[1,7],[1,8],[3,8],[4,6],[5,4]],
		revealed: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],[3,0],[3,1],[3,2],[3,3],[3,4],[3,5],[4,0],[4,1],[4,2],[4,3],[4,4],[4,5],[5,0],[5,1],[5,2],[5,3]],
		flagged: [[0,5],[5,4]]
	},
	puzzles: {
		rows: 5, cols: 6,
		mines: [[0,5],[1,0],[2,0],[3,0],[3,5],[4,1],[4,2]],
		revealed: [[0,1],[0,2],[0,3],[0,4],[1,1],[1,2],[1,3],[1,4],[2,1],[2,2],[2,3],[2,4],[3,1],[3,2],[3,3],[3,4]],
		flagged: []
	}
};
function renderModeBoardPreviews() {
	if (typeof buildLearnPuzzle !== "function") return;
	Object.keys(DASH_MODE_BOARDS).forEach(function(key) {
		var slot = document.getElementById("dash_board_" + key);
		if (!slot || slot.firstChild) return;
		var b = DASH_MODE_BOARDS[key];
		var el = buildLearnPuzzle({ title: "", rows: b.rows, cols: b.cols, mines: b.mines, revealed: b.revealed, flagged: b.flagged }, false, function() {});
		el.classList.add("dash-board-preview");
		slot.appendChild(el);
	});
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
