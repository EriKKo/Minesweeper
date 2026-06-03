// Persistent storage for ranked accounts and sessions, backed by node:sqlite
// (built in, no native compilation). A single file on disk survives restarts.
var sqlite = require("node:sqlite");
var crypto = require("node:crypto");
var path = require("path");

// Bumped any time the puzzle scoring formula changes. Rows stored under an
// older version are re-classified on startup so their score and rating
// match what a freshly-generated puzzle would get.
var CURRENT_SCORING_VERSION = 12;

// Dev: ranked.db lives at the project root (gitignored). Prod: RANKED_DB is
// set to /data/ranked.db on the fly volume.
var DB_PATH = process.env.RANKED_DB || path.join(__dirname, "..", "..", "ranked.db");
var db = new sqlite.DatabaseSync(DB_PATH);

db.exec(
	"CREATE TABLE IF NOT EXISTS users (" +
	"  id INTEGER PRIMARY KEY," +
	"  provider TEXT NOT NULL," +
	"  provider_id TEXT NOT NULL," +
	"  name TEXT NOT NULL," +
	"  avatar_url TEXT," +
	"  rating INTEGER NOT NULL DEFAULT 1000," +
	"  provisional_games INTEGER NOT NULL DEFAULT 0," +
	"  wins INTEGER NOT NULL DEFAULT 0," +
	"  played INTEGER NOT NULL DEFAULT 0," +
	"  created_at INTEGER NOT NULL," +
	"  UNIQUE(provider, provider_id)" +
	");" +
	"CREATE TABLE IF NOT EXISTS sessions (" +
	"  token TEXT PRIMARY KEY," +
	"  user_id INTEGER NOT NULL," +
	"  created_at INTEGER NOT NULL" +
	");" +
	"CREATE TABLE IF NOT EXISTS puzzles (" +
	"  id INTEGER PRIMARY KEY," +
	"  canonical_key TEXT NOT NULL UNIQUE," +
	"  rows INTEGER NOT NULL," +
	"  cols INTEGER NOT NULL," +
	"  mines TEXT NOT NULL," +
	"  revealed TEXT NOT NULL," +
	"  covered_safe INTEGER NOT NULL," +
	"  difficulty INTEGER NOT NULL," +
	"  score REAL NOT NULL," +
	"  rating INTEGER NOT NULL," +
	"  trivial_passes INTEGER NOT NULL DEFAULT 0," +
	"  subset_passes INTEGER NOT NULL DEFAULT 0," +
	"  enum_passes INTEGER NOT NULL DEFAULT 0," +
	"  max_enum_size INTEGER NOT NULL DEFAULT 0," +
	"  attempts INTEGER NOT NULL DEFAULT 0," +
	"  solves INTEGER NOT NULL DEFAULT 0," +
	"  created_at INTEGER NOT NULL" +
	");" +
	"CREATE INDEX IF NOT EXISTS idx_puzzles_difficulty ON puzzles(difficulty);" +
	"CREATE INDEX IF NOT EXISTS idx_puzzles_rating ON puzzles(rating);" +
	"CREATE TABLE IF NOT EXISTS puzzle_attempts (" +
	"  id INTEGER PRIMARY KEY," +
	"  user_id INTEGER NOT NULL," +
	"  puzzle_id INTEGER NOT NULL," +
	"  solved INTEGER NOT NULL," +
	"  player_rating_before INTEGER NOT NULL," +
	"  player_rating_after INTEGER NOT NULL," +
	"  puzzle_rating_before INTEGER NOT NULL," +
	"  puzzle_rating_after INTEGER NOT NULL," +
	"  created_at INTEGER NOT NULL" +
	");" +
	"CREATE INDEX IF NOT EXISTS idx_attempts_user ON puzzle_attempts(user_id, created_at);" +
	"CREATE INDEX IF NOT EXISTS idx_attempts_puzzle ON puzzle_attempts(puzzle_id);"
);

// Schema migration: add per-user puzzle-rating columns if missing. Each
// ALTER TABLE will throw "duplicate column" the second time around — that's
// expected, swallow it.
function addColumnIfMissing(table, column, definition) {
	try { db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition); }
	catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
addColumnIfMissing("users", "puzzle_rating", "INTEGER NOT NULL DEFAULT 800");
addColumnIfMissing("users", "puzzles_solved", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "puzzles_attempted", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "current_puzzle_id", "INTEGER");
addColumnIfMissing("users", "streak_best", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "storm_best", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "daily_streak", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "daily_last_solved", "TEXT");
addColumnIfMissing("users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "email", "TEXT");
// `overlap_passes` was added later. Default -1 marks rows that pre-date the
// overlap solver — startup re-runs the analyzer on those and stamps a real
// value so their pass counts / difficulty / score reflect the new pass.
addColumnIfMissing("puzzles", "overlap_passes", "INTEGER NOT NULL DEFAULT -1");
addColumnIfMissing("puzzles", "chain_passes", "INTEGER NOT NULL DEFAULT 0");
// Bumped whenever the scoring formula changes. The startup backfill picks
// up rows whose stored version is below CURRENT_SCORING_VERSION and
// re-analyzes them.
addColumnIfMissing("puzzles", "scoring_version", "INTEGER NOT NULL DEFAULT 0");

db.exec(
	"CREATE TABLE IF NOT EXISTS daily_puzzles (" +
	"  date TEXT PRIMARY KEY," +
	"  puzzle_id INTEGER NOT NULL," +
	"  picked_at INTEGER NOT NULL" +
	");" +
	"CREATE TABLE IF NOT EXISTS daily_attempts (" +
	"  user_id INTEGER NOT NULL," +
	"  date TEXT NOT NULL," +
	"  solved INTEGER NOT NULL," +
	"  attempted_at INTEGER NOT NULL," +
	"  PRIMARY KEY (user_id, date)" +
	");"
);

function upsertUser(provider, providerId, name, avatarUrl, email) {
	providerId = String(providerId);
	var emailLower = email ? String(email).toLowerCase() : null;
	var existing = db.prepare("SELECT * FROM users WHERE provider = ? AND provider_id = ?").get(provider, providerId);
	if (existing) {
		db.prepare("UPDATE users SET name = ?, avatar_url = ?, email = COALESCE(?, email) WHERE id = ?")
			.run(name, avatarUrl || null, emailLower, existing.id);
		var updated = db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
		applyAdminForEmail(updated);
		return updated;
	}
	var info = db.prepare(
		"INSERT INTO users (provider, provider_id, name, avatar_url, email, created_at) VALUES (?, ?, ?, ?, ?, ?)"
	).run(provider, providerId, name, avatarUrl || null, emailLower, Date.now());
	var created = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
	applyAdminForEmail(created);
	return created;
}

// Default admin email is hard-coded so the project owner is always admin
// without any env-var setup. ADMIN_EMAILS extends the list with extra
// addresses (comma-separated, case-insensitive). On upsert, if the user's
// stored email matches the list, they get is_admin = 1.
var HARDCODED_ADMIN_EMAILS = ["erik.odenman@gmail.com"];

function getAdminEmails() {
	var fromEnv = (process.env.ADMIN_EMAILS || "")
		.split(",")
		.map(function(s) { return s.trim().toLowerCase(); })
		.filter(Boolean);
	var combined = HARDCODED_ADMIN_EMAILS.concat(fromEnv);
	var dedup = {};
	combined.forEach(function(e) { dedup[e] = true; });
	return Object.keys(dedup);
}

function applyAdminForEmail(user) {
	if (!user || !user.email) return;
	var admins = getAdminEmails();
	if (admins.indexOf(user.email.toLowerCase()) >= 0 && !user.is_admin) {
		db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(user.id);
		user.is_admin = 1;
		console.log("[admin] marked " + user.email + " as admin (user " + user.id + ")");
	}
}

function createSession(userId) {
	var token = crypto.randomBytes(32).toString("hex");
	db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, Date.now());
	return token;
}

function getUserByToken(token) {
	if (!token) return null;
	return db.prepare(
		"SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
	).get(token) || null;
}

function getUserById(id) {
	return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

function setUserAdmin(userId, isAdmin) {
	db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, userId);
}

// On startup we honor ADMIN_USERS (comma-separated provider:provider_id)
// and the email list from getAdminEmails — hardcoded address + ADMIN_EMAILS.
// Any matching existing user gets is_admin = 1 idempotently.
function applyAdminBootstrap() {
	var spec = process.env.ADMIN_USERS;
	if (spec) {
		spec.split(",").map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(pair) {
			var idx = pair.indexOf(":");
			if (idx < 0) return;
			var provider = pair.slice(0, idx);
			var providerId = pair.slice(idx + 1);
			var u = db.prepare("SELECT id, is_admin FROM users WHERE provider = ? AND provider_id = ?").get(provider, providerId);
			if (u && !u.is_admin) {
				db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(u.id);
				console.log("[admin] marked " + provider + ":" + providerId + " as admin (user " + u.id + ")");
			}
		});
	}
	var adminEmails = getAdminEmails();
	if (adminEmails.length) {
		// LOWER() is portable across sqlite; emails are already stored lowercase
		// but defensive in case any pre-existing row wasn't normalized.
		var placeholders = adminEmails.map(function() { return "?"; }).join(",");
		var stmt = db.prepare("SELECT id, email, is_admin FROM users WHERE LOWER(email) IN (" + placeholders + ")");
		var rows = stmt.all.apply(stmt, adminEmails);
		rows.forEach(function(u) {
			if (!u.is_admin) {
				db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(u.id);
				console.log("[admin] marked " + u.email + " as admin (user " + u.id + ")");
			}
		});
	}
}
applyAdminBootstrap();

function updateRating(userId, newRating, won) {
	db.prepare("UPDATE users SET rating = ?, played = played + 1, wins = wins + ? WHERE id = ?")
		.run(newRating, won ? 1 : 0, userId);
}

function deleteSession(token) {
	if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function topPlayers(limit) {
	return db.prepare("SELECT name, rating, wins, played FROM users ORDER BY rating DESC LIMIT ?").all(limit || 20);
}

// Map the CSP-driven score (max complexity + small total bonus) to a
// chess-style puzzle rating. Linear scaling — `score` already comes from
// a continuous human-effort proxy, so we don't need an extra curve. The
// constants put a default player (rating 800) above the "trivial cascade"
// puzzles (~640) and the curve climbs through ~1100 (subset), ~1500
// (single overlap), ~2000 (deep overlap), to ~2800+ (case-split / enum).
function scoreToRating(score) {
	if (!score || score <= 0) return 500;
	return Math.round(500 + 200 * score);
}

function insertPuzzle(p) {
	var info = db.prepare(
		"INSERT OR IGNORE INTO puzzles " +
		"(canonical_key, rows, cols, mines, revealed, covered_safe, difficulty, score, rating, " +
		" trivial_passes, subset_passes, overlap_passes, chain_passes, enum_passes, max_enum_size, scoring_version, created_at) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	).run(
		p.key, p.rows, p.cols,
		JSON.stringify(p.mines), JSON.stringify(p.revealed),
		p.coveredSafe, p.difficulty, p.score, scoreToRating(p.score),
		(p.passes && p.passes.trivial) || 0,
		(p.passes && p.passes.subset) || 0,
		(p.passes && p.passes.overlap) || 0,
		(p.passes && p.passes.chain) || 0,
		(p.passes && p.passes.enum) || 0,
		p.maxEnumSize || 0,
		CURRENT_SCORING_VERSION,
		Date.now()
	);
	return info.changes > 0;
}

function deserializePuzzle(row) {
	return {
		id: row.id,
		key: row.canonical_key,
		rows: row.rows,
		cols: row.cols,
		mines: JSON.parse(row.mines),
		revealed: JSON.parse(row.revealed),
		coveredSafe: row.covered_safe,
		difficulty: row.difficulty,
		score: row.score,
		rating: row.rating,
		passes: {
			trivial: row.trivial_passes,
			subset: row.subset_passes,
			overlap: row.overlap_passes > 0 ? row.overlap_passes : 0,
			chain: row.chain_passes || 0,
			enum: row.enum_passes
		},
		maxEnumSize: row.max_enum_size,
		attempts: row.attempts,
		solves: row.solves
	};
}

// Score band like "0-1", "5-7", or "10+". Returns SQL fragment + params,
// or null for unknown bands.
function scoreBandClause(band) {
	if (!band) return null;
	var m = band.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
	if (m) {
		var lo = parseFloat(m[1]);
		var hi = parseFloat(m[2]);
		return { sql: "(score >= ? AND score < ?)", params: [lo, hi] };
	}
	var open = band.match(/^(\d+(?:\.\d+)?)\+$/);
	if (open) {
		return { sql: "score >= ?", params: [parseFloat(open[1])] };
	}
	return null;
}

function methodClause(method) {
	// "trivial" — only the trivial pass made progress
	// "subset"  — subset rule used, no overlap or enum
	// "overlap" — generalized constraint subtraction used, no enum
	// "enum"    — enum pass involved
	// overlap_passes can be 0 (no overlap deductions) or -1 (legacy row,
	// pre-overlap classification — treat as "we don't know", so include it
	// in any non-overlap-specific bucket).
	if (method === "trivial") return "subset_passes = 0 AND (overlap_passes <= 0) AND chain_passes = 0 AND enum_passes = 0";
	if (method === "subset")  return "subset_passes > 0 AND (overlap_passes <= 0) AND chain_passes = 0 AND enum_passes = 0";
	if (method === "overlap") return "overlap_passes > 0 AND chain_passes = 0 AND enum_passes = 0";
	if (method === "chain")   return "chain_passes > 0 AND enum_passes = 0";
	if (method === "enum")    return "enum_passes > 0";
	return null;
}

function listPuzzles(opts) {
	opts = opts || {};
	var clauses = [];
	var params = [];
	if (opts.difficulty >= 1 && opts.difficulty <= 6) {
		clauses.push("difficulty = ?");
		params.push(opts.difficulty);
	}
	var method = methodClause(opts.method);
	if (method) clauses.push(method);
	var band = scoreBandClause(opts.scoreBand);
	if (band) {
		clauses.push(band.sql);
		band.params.forEach(function(p) { params.push(p); });
	}
	var sortDir = opts.sort === "desc" ? "DESC" : "ASC";
	var pageSize = Math.max(1, Math.min(200, opts.pageSize || 50));
	var page = Math.max(0, opts.page || 0);
	var sql = "SELECT * FROM puzzles";
	if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
	sql += " ORDER BY rating " + sortDir + " LIMIT ? OFFSET ?";
	params.push(pageSize, page * pageSize);
	var stmt = db.prepare(sql);
	return stmt.all.apply(stmt, params).map(deserializePuzzle);
}

function puzzleCount(difficulty, method, scoreBand) {
	var clauses = [];
	var params = [];
	if (difficulty >= 1 && difficulty <= 6) {
		clauses.push("difficulty = ?");
		params.push(difficulty);
	}
	var m = methodClause(method);
	if (m) clauses.push(m);
	var b = scoreBandClause(scoreBand);
	if (b) {
		clauses.push(b.sql);
		b.params.forEach(function(p) { params.push(p); });
	}
	var sql = "SELECT COUNT(*) AS n FROM puzzles";
	if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
	var stmt = db.prepare(sql);
	return stmt.get.apply(stmt, params).n;
}

function clearPuzzles() {
	db.exec("DELETE FROM puzzles");
}

function getPuzzleById(id) {
	var row = db.prepare("SELECT * FROM puzzles WHERE id = ?").get(id);
	return row ? deserializePuzzle(row) : null;
}

function updatePuzzleRating(puzzleId, newRating, solved) {
	db.prepare(
		"UPDATE puzzles SET rating = ?, attempts = attempts + 1, solves = solves + ? WHERE id = ?"
	).run(newRating, solved ? 1 : 0, puzzleId);
}

function updateUserPuzzleRating(userId, newRating, solved) {
	db.prepare(
		"UPDATE users SET puzzle_rating = ?, puzzles_attempted = puzzles_attempted + 1, puzzles_solved = puzzles_solved + ? WHERE id = ?"
	).run(newRating, solved ? 1 : 0, userId);
}

function setCurrentPuzzle(userId, puzzleId) {
	db.prepare("UPDATE users SET current_puzzle_id = ? WHERE id = ?").run(puzzleId, userId);
}

// ISO YYYY-MM-DD for "today" in UTC. Single global clock so everyone
// sees the same puzzle at the same time regardless of timezone.
function todayUtc() {
	return new Date().toISOString().slice(0, 10);
}

function yesterdayOf(date) {
	var d = new Date(date + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}

// Stable per-day assignment: pick the first time anyone asks, remember
// it forever. Aim for the Advanced rating band (1400–1700) — challenging
// but accessible. Falls back to a wider band if nothing's in range.
function getOrPickDailyPuzzle(date) {
	var existing = db.prepare("SELECT puzzle_id FROM daily_puzzles WHERE date = ?").get(date);
	if (existing) {
		var p = getPuzzleById(existing.puzzle_id);
		if (p) return p;
		// The assigned puzzle was deleted (lab cleared?) — re-pick.
	}
	var picked = pickDailyCandidate();
	if (!picked) return null;
	db.prepare("INSERT OR REPLACE INTO daily_puzzles (date, puzzle_id, picked_at) VALUES (?, ?, ?)").run(date, picked.id, Date.now());
	return picked;
}

function pickDailyCandidate() {
	var row = db.prepare("SELECT * FROM puzzles WHERE rating BETWEEN 1400 AND 1700 ORDER BY RANDOM() LIMIT 1").get();
	if (row) return deserializePuzzle(row);
	row = db.prepare("SELECT * FROM puzzles WHERE rating BETWEEN 1100 AND 2000 ORDER BY RANDOM() LIMIT 1").get();
	if (row) return deserializePuzzle(row);
	row = db.prepare("SELECT * FROM puzzles ORDER BY RANDOM() LIMIT 1").get();
	return row ? deserializePuzzle(row) : null;
}

function getDailyAttempt(userId, date) {
	return db.prepare("SELECT * FROM daily_attempts WHERE user_id = ? AND date = ?").get(userId, date) || null;
}

function recordDailyAttempt(userId, date, solved) {
	db.prepare(
		"INSERT OR REPLACE INTO daily_attempts (user_id, date, solved, attempted_at) VALUES (?, ?, ?, ?)"
	).run(userId, date, solved ? 1 : 0, Date.now());
	if (solved) {
		var u = getUserById(userId);
		var streak = (u && u.daily_last_solved === yesterdayOf(date)) ? (u.daily_streak || 0) + 1 : 1;
		db.prepare("UPDATE users SET daily_streak = ?, daily_last_solved = ? WHERE id = ?").run(streak, date, userId);
	}
}

function dailyStreakForUser(userId) {
	var u = getUserById(userId);
	if (!u) return 0;
	// If they missed yesterday, the streak is broken — show 0.
	var today = todayUtc();
	if (u.daily_last_solved === today) return u.daily_streak;
	if (u.daily_last_solved === yesterdayOf(today)) return u.daily_streak;
	return 0;
}

function getRunBest(userId, mode) {
	var col = mode === "streak" ? "streak_best" : "storm_best";
	var row = db.prepare("SELECT " + col + " AS v FROM users WHERE id = ?").get(userId);
	return row ? row.v : 0;
}

function setRunBest(userId, mode, score) {
	var col = mode === "streak" ? "streak_best" : "storm_best";
	db.prepare("UPDATE users SET " + col + " = ? WHERE id = ?").run(score, userId);
}

// Standard Elo: expected score against an opponent of `opponentRating`,
// then new = old + K * (actual - expected). Caller picks K — we use 20
// for player ratings (snappy enough to converge in ~50 attempts) and 10
// for per-puzzle ratings (puzzles move slower since they get many plays).
function eloUpdate(playerRating, opponentRating, K, actual) {
	var expected = 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
	return Math.round(playerRating + K * (actual - expected));
}

function recordAttempt(row) {
	db.prepare(
		"INSERT INTO puzzle_attempts " +
		"(user_id, puzzle_id, solved, player_rating_before, player_rating_after, puzzle_rating_before, puzzle_rating_after, created_at) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
	).run(
		row.userId, row.puzzleId, row.solved ? 1 : 0,
		row.playerBefore, row.playerAfter,
		row.puzzleBefore, row.puzzleAfter,
		Date.now()
	);
}

// Puzzles attempted by this user in the last `windowMs` — used to avoid
// handing back a puzzle they just played. Default window: 1 hour.
function recentlyAttemptedPuzzleIds(userId, windowMs) {
	var cutoff = Date.now() - (windowMs || (60 * 60 * 1000));
	var rows = db.prepare(
		"SELECT DISTINCT puzzle_id FROM puzzle_attempts WHERE user_id = ? AND created_at >= ?"
	).all(userId, cutoff);
	return rows.map(function(r) { return r.puzzle_id; });
}

// Find a puzzle near `targetRating` (±window) that the user hasn't recently
// played. Widens the window in steps if no candidates exist at the initial
// range. Returns null only if the table is empty for this user.
function pickPuzzleNearRating(targetRating, excludeIds, windows) {
	windows = windows || [200, 400, 800, 2000];
	var excludeClause = "";
	var params = [];
	if (excludeIds && excludeIds.length) {
		excludeClause = " AND id NOT IN (" + excludeIds.map(function() { return "?"; }).join(",") + ")";
		params = excludeIds.slice();
	}
	for (var i = 0; i < windows.length; i++) {
		var w = windows[i];
		var sql = "SELECT * FROM puzzles WHERE rating BETWEEN ? AND ?" + excludeClause +
			" ORDER BY RANDOM() LIMIT 1";
		var p = [targetRating - w, targetRating + w].concat(params);
		var stmt = db.prepare(sql);
		var row = stmt.get.apply(stmt, p);
		if (row) return deserializePuzzle(row);
	}
	// Last resort: any puzzle they haven't recently played.
	if (excludeIds && excludeIds.length) {
		var sql2 = "SELECT * FROM puzzles WHERE 1=1" + excludeClause + " ORDER BY RANDOM() LIMIT 1";
		var stmt2 = db.prepare(sql2);
		var row2 = stmt2.get.apply(stmt2, params);
		if (row2) return deserializePuzzle(row2);
	}
	return null;
}

// Startup backfill: pick up rows that pre-date the current solver / scoring
// version and re-run the analyzer so pass counts, difficulty, score, and
// rating all reflect the latest code.
function legacyPuzzleRows() {
	return db.prepare(
		"SELECT id, rows, cols, mines, revealed FROM puzzles " +
		"WHERE overlap_passes < 0 OR scoring_version < ?"
	).all(CURRENT_SCORING_VERSION);
}

function applyPuzzleClassification(id, analysis) {
	db.prepare(
		"UPDATE puzzles SET difficulty = ?, score = ?, rating = ?, " +
		"trivial_passes = ?, subset_passes = ?, overlap_passes = ?, chain_passes = ?, enum_passes = ?, " +
		"max_enum_size = ?, scoring_version = ? " +
		"WHERE id = ?"
	).run(
		analysis.difficulty,
		analysis.score,
		scoreToRating(analysis.score),
		analysis.passes.trivial || 0,
		analysis.passes.subset || 0,
		analysis.passes.overlap || 0,
		analysis.passes.chain || 0,
		analysis.passes.enum || 0,
		analysis.maxEnumSize || 0,
		CURRENT_SCORING_VERSION,
		id
	);
}

module.exports = {
	upsertUser: upsertUser,
	createSession: createSession,
	getUserByToken: getUserByToken,
	getUserById: getUserById,
	setUserAdmin: setUserAdmin,
	applyAdminBootstrap: applyAdminBootstrap,
	updateRating: updateRating,
	deleteSession: deleteSession,
	topPlayers: topPlayers,
	// Puzzles
	scoreToRating: scoreToRating,
	insertPuzzle: insertPuzzle,
	listPuzzles: listPuzzles,
	puzzleCount: puzzleCount,
	clearPuzzles: clearPuzzles,
	getPuzzleById: getPuzzleById,
	updatePuzzleRating: updatePuzzleRating,
	updateUserPuzzleRating: updateUserPuzzleRating,
	setCurrentPuzzle: setCurrentPuzzle,
	eloUpdate: eloUpdate,
	recordAttempt: recordAttempt,
	recentlyAttemptedPuzzleIds: recentlyAttemptedPuzzleIds,
	pickPuzzleNearRating: pickPuzzleNearRating,
	getRunBest: getRunBest,
	setRunBest: setRunBest,
	todayUtc: todayUtc,
	getOrPickDailyPuzzle: getOrPickDailyPuzzle,
	getDailyAttempt: getDailyAttempt,
	recordDailyAttempt: recordDailyAttempt,
	dailyStreakForUser: dailyStreakForUser,
	legacyPuzzleRows: legacyPuzzleRows,
	applyPuzzleClassification: applyPuzzleClassification
};
