// Persistent storage for ranked accounts and sessions, backed by node:sqlite
// (built in, no native compilation). A single file on disk survives restarts.
var sqlite = require("node:sqlite");
var crypto = require("node:crypto");
var path = require("path");

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
	"CREATE INDEX IF NOT EXISTS idx_puzzles_rating ON puzzles(rating);"
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

function upsertUser(provider, providerId, name, avatarUrl) {
	providerId = String(providerId);
	var existing = db.prepare("SELECT * FROM users WHERE provider = ? AND provider_id = ?").get(provider, providerId);
	if (existing) {
		db.prepare("UPDATE users SET name = ?, avatar_url = ? WHERE id = ?").run(name, avatarUrl || null, existing.id);
		return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
	}
	var info = db.prepare(
		"INSERT INTO users (provider, provider_id, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)"
	).run(provider, providerId, name, avatarUrl || null, Date.now());
	return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
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

// Map our continuous solver score (1.0 .. ~30) to a chess-style puzzle
// rating. Power curve gives diminishing rating gain at high score (going
// from 20 → 21 should feel like a small bump; going from 1 → 2 is a real
// step up). The constants put a default player (rating 800) just above the
// "single trivial click" puzzle (~750) so a fresh account is matched to
// easy puzzles, and the curve climbs through ~1300 (subset), ~1800 (light
// enum), to ~3000+ (deep case analysis).
function scoreToRating(score) {
	if (!score || score <= 0) return 500;
	return Math.round(400 + 350 * Math.pow(score, 0.6));
}

function insertPuzzle(p) {
	var info = db.prepare(
		"INSERT OR IGNORE INTO puzzles " +
		"(canonical_key, rows, cols, mines, revealed, covered_safe, difficulty, score, rating, " +
		" trivial_passes, subset_passes, enum_passes, max_enum_size, created_at) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	).run(
		p.key, p.rows, p.cols,
		JSON.stringify(p.mines), JSON.stringify(p.revealed),
		p.coveredSafe, p.difficulty, p.score, scoreToRating(p.score),
		(p.passes && p.passes.trivial) || 0,
		(p.passes && p.passes.subset) || 0,
		(p.passes && p.passes.enum) || 0,
		p.maxEnumSize || 0,
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
			enum: row.enum_passes
		},
		maxEnumSize: row.max_enum_size,
		attempts: row.attempts,
		solves: row.solves
	};
}

function listPuzzles(opts) {
	opts = opts || {};
	var clauses = [];
	var params = [];
	if (opts.difficulty >= 1 && opts.difficulty <= 6) {
		clauses.push("difficulty = ?");
		params.push(opts.difficulty);
	}
	var sql = "SELECT * FROM puzzles";
	if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
	sql += " ORDER BY score ASC LIMIT ?";
	params.push(opts.limit || 1000);
	var stmt = db.prepare(sql);
	return stmt.all.apply(stmt, params).map(deserializePuzzle);
}

function puzzleCount() {
	return db.prepare("SELECT COUNT(*) AS n FROM puzzles").get().n;
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

module.exports = {
	upsertUser: upsertUser,
	createSession: createSession,
	getUserByToken: getUserByToken,
	getUserById: getUserById,
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
	updateUserPuzzleRating: updateUserPuzzleRating
};
