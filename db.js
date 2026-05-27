// Persistent storage for ranked accounts and sessions, backed by node:sqlite
// (built in, no native compilation). A single file on disk survives restarts.
var sqlite = require("node:sqlite");
var crypto = require("node:crypto");
var path = require("path");

var DB_PATH = process.env.RANKED_DB || path.join(__dirname, "ranked.db");
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
	");"
);

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

module.exports = {
	upsertUser: upsertUser,
	createSession: createSession,
	getUserByToken: getUserByToken,
	getUserById: getUserById,
	updateRating: updateRating,
	deleteSession: deleteSession,
	topPlayers: topPlayers
};
