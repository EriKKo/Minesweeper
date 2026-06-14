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

// Mode previews are rendered with the REAL game board renderer (buildLearnPuzzle — the same one
// the daily puzzle uses), so each mode shows an authentic board at its own mine density: Sprint's
// sparse 10% (wide cascades) vs Standard's dense 20% (lots of numbers), etc. Uniform dimensions so
// no mode looks bigger than another. Generated once per load and frozen (pointer-events: none).
// Mode previews are FIXED (deterministic) boards rendered by the real game renderer. The racing
// modes use a wider board (zoomed out) so you see the open field; Puzzles uses a small, denser grid
// (zoomed in) so it reads as a tight deduction. Boards are pinned to a per-mode seed so they don't
// change between loads; flags are only placed on the deducible frontier (mines next to a revealed
// cell), never randomly. Tune a board by changing its `seed`.
var DASH_MODE_PREVIEW = {
	// Each board is a REAL, legal mid-game position: we flood-reveal from a start cell (exactly like a
	// real cascade), so every covered region is bounded by numbered frontier cells — never a bare 0 next
	// to a covered cell (which would look like a missing number). Modes read differently via where the
	// opening starts, the mine density, and how many deduced mines are flagged. Puzzle is a fresh tight
	// cascade (zoomed in, no flags). Tune a board by changing its `seed`.
	sprint:   { rows: 6, cols: 10, density: 0.10, start: "c", seed: 2 },  // fast: sparse opening
	standard: { rows: 6, cols: 9,  density: 0.20, start: "c", seed: 14 }, // methodical: same kind of opening, denser minefield
	custom:   { rows: 6, cols: 9,  density: 0.15, start: "c", seed: 9 },  // casual: medium density
	puzzles:  { rows: 5, cols: 6,  density: 0.22, puzzle: true, seed: 4 }
};
function dashRng(seed) {
	return function() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function genModeBoard(cfg) {
	var R = cfg.rows, C = cfg.cols, rand = dashRng(cfg.seed);
	// Start pocket location: a mine-free 3x3 around the seed guarantees a 0-cell to flood from. The
	// opening grows from here, so placing it centrally vs. in a corner shifts where the explored area sits.
	var start = cfg.start || "c";
	var sr = start.indexOf("t") >= 0 ? 1 : start.indexOf("b") >= 0 ? R - 2 : R >> 1;
	var sc = start.indexOf("l") >= 0 ? 1 : start.indexOf("r") >= 0 ? C - 2 : C >> 1;
	var mineSet = {}, mines = [], target = Math.round(R * C * cfg.density), guard = 0;
	while (mines.length < target && guard++ < 6000) {
		var r = (rand() * R) | 0, c = (rand() * C) | 0, k = r + "," + c;
		if (Math.abs(r - sr) <= 1 && Math.abs(c - sc) <= 1) continue;
		if (mineSet[k]) continue;
		mineSet[k] = true; mines.push([r, c]);
	}
	function clue(r, c) { var n = 0; for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) { var nr = r + dr, nc = c + dc; if (nr >= 0 && nr < R && nc >= 0 && nc < C && mineSet[nr + "," + nc]) n++; } return n; }
	// Flood-reveal from the start cell — a real cascade. A 0-cell pulls in all 8 neighbours; a numbered
	// cell is revealed but stops the spread (it's the frontier). Mines are never reached. The result is
	// always a LEGAL position: the boundary of the covered area is numbered cells, never a bare 0.
	var rev = {};
	function flood(r0, c0) {
		var q = [[r0, c0]];
		while (q.length) {
			var p = q.shift(), pk = p[0] + "," + p[1];
			if (rev[pk] || mineSet[pk]) continue;
			rev[pk] = true;
			if (clue(p[0], p[1]) === 0) for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
				var nr = p[0] + dr, nc = p[1] + dc; if (nr >= 0 && nr < R && nc >= 0 && nc < C) q.push([nr, nc]);
			}
		}
	}
	flood(sr, sc);
	var revealed = Object.keys(rev).map(function(k) { return k.split(",").map(Number); });
	// Flags only where they're logically FORCED — a revealed clue whose value equals its number of
	// covered neighbours, so every one of them must be a mine (the basic human deduction: a "1"
	// bordering a single covered cell, common at corners). Never a guessed/decorative flag.
	var flagged = [], flagKey = {};
	if (!cfg.puzzle) for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
		if (!rev[r + "," + c]) continue;
		var v = clue(r, c); if (v === 0) continue;
		var covered = [];
		for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
			if (dr === 0 && dc === 0) continue;
			var nr = r + dr, nc = c + dc; if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
			if (!rev[nr + "," + nc]) covered.push([nr, nc]);
		}
		if (covered.length === v) covered.forEach(function(p) {
			var k = p[0] + "," + p[1]; if (!flagKey[k]) { flagKey[k] = true; flagged.push(p); }
		});
	}
	return { title: "", rows: R, cols: C, mines: mines, revealed: revealed, flagged: flagged };
}
function renderModeBoardPreviews() {
	if (typeof buildLearnPuzzle !== "function") return;
	Object.keys(DASH_MODE_PREVIEW).forEach(function(key) {
		var slot = document.getElementById("dash_board_" + key);
		if (!slot || slot.firstChild) return;
		var el = buildLearnPuzzle(genModeBoard(DASH_MODE_PREVIEW[key]), false, function() {});
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
