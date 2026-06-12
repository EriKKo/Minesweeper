// Persistent storage for ranked accounts and sessions, backed by node:sqlite
// (built in, no native compilation). A single file on disk survives restarts.
var sqlite = require("node:sqlite");
var crypto = require("node:crypto");
var path = require("path");

// Bumped any time the puzzle scoring formula changes. Rows stored under an
// older version are re-classified on startup so their score and rating
// match what a freshly-generated puzzle would get.
var CURRENT_SCORING_VERSION = 20;

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
// Guests: a real user row (with ratings/stats) that isn't linked to an auth provider yet.
// provider = "guest", provider_id = a random token. Signing in later upgrades the row in place.
addColumnIfMissing("users", "is_guest", "INTEGER NOT NULL DEFAULT 0");
// Ranked is split into Sprint / Standard playstyles (and Tournament keeps
// its own pool). Each playstyle carries its own Elo and provisional
// counter so a player can be Bronze at Sprint and Gold at Standard.
addColumnIfMissing("users", "rating_sprint", "INTEGER NOT NULL DEFAULT 1000");
addColumnIfMissing("users", "rating_standard", "INTEGER NOT NULL DEFAULT 1000");
addColumnIfMissing("users", "rating_tournament", "INTEGER NOT NULL DEFAULT 1000");
addColumnIfMissing("users", "rating_territory", "INTEGER NOT NULL DEFAULT 1000");
addColumnIfMissing("users", "sprint_provisional", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "standard_provisional", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "tournament_provisional", "INTEGER NOT NULL DEFAULT 0");
// One-shot backfill: seed the per-style columns from the legacy `rating`
// the first time a user is touched after this column is added. Pre-split
// users keep their progress rather than reset to 1000 across the board.
try {
	db.exec(
		"UPDATE users SET rating_sprint = rating, rating_standard = rating, rating_tournament = rating, " +
		"sprint_provisional = provisional_games, standard_provisional = provisional_games, " +
		"tournament_provisional = provisional_games " +
		"WHERE rating_sprint = 1000 AND rating_standard = 1000 AND rating_tournament = 1000 AND rating <> 1000"
	);
} catch (e) { /* columns may already be backfilled */ }
// `overlap_passes` was added later. Default -1 marks rows that pre-date the
// overlap solver — startup re-runs the analyzer on those and stamps a real
// value so their pass counts / difficulty / score reflect the new pass.
addColumnIfMissing("puzzles", "overlap_passes", "INTEGER NOT NULL DEFAULT -1");
addColumnIfMissing("puzzles", "chain_passes", "INTEGER NOT NULL DEFAULT 0");
// Set to 1 when the CSP analyzer fell back to case-split for at least
// one move — used by the All Puzzles "Case" filter.
addColumnIfMissing("puzzles", "needs_case_split", "INTEGER NOT NULL DEFAULT 0");
// The hardest CSP op the analyzer needed for this puzzle. One of:
// "trivial" (no derivation), "subset", "union", "intersect", "case",
// "enum". Drives the method filter; reset on every (re)classification.
addColumnIfMissing("puzzles", "csp_method", "TEXT NOT NULL DEFAULT 'trivial'");
// Which generator produced the puzzle — "random" for the original
// random-mine generate-and-test pipeline, "inside_out" for the
// new constructive generator (and any future variants we add).
addColumnIfMissing("puzzles", "source", "TEXT NOT NULL DEFAULT 'random'");
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
	");" +
	// Starting positions: enumerated cascade patterns with at least one
	// forced-safe outside cell. `pattern` is the 8-tuple of boundary
	// clue values (clockwise from top-left) joined with dots, e.g.
	// "1.1.1.1.1.1.1.1". `size` is the cascade dimension (3 = 3x3
	// cascade in a 5x5 board); future bigger cascades can live in
	// the same table with size>3.
	"CREATE TABLE IF NOT EXISTS starting_positions (" +
	"  id INTEGER PRIMARY KEY AUTOINCREMENT," +
	"  size INTEGER NOT NULL," +
	"  pattern TEXT NOT NULL," +
	"  solutions INTEGER NOT NULL," +
	"  forced_safe INTEGER NOT NULL," +
	"  forced_mine INTEGER NOT NULL," +
	"  first_action TEXT NOT NULL," +
	"  first_complexity REAL NOT NULL," +
	"  rating INTEGER NOT NULL," +
	"  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))," +
	"  UNIQUE(size, pattern)" +
	");"
);

// Bitmasks over the 16 outer-ring cells (3x3 cascade context). Each
// bit set marks an outer cell that is safe / a mine across every
// consistent mine arrangement. Drives the 5x5 visualization in the
// admin browse view.
addColumnIfMissing("starting_positions", "forced_safe_mask", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("starting_positions", "forced_mine_mask", "INTEGER NOT NULL DEFAULT 0");
// Primality: a pattern is "prime" when no single boundary clue can be
// removed without shrinking the deduction set. removable_mask is an
// 8-bit field flagging which specific clues are individually
// removable (1 = redundant, 0 = essential).
addColumnIfMissing("starting_positions", "is_prime", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("starting_positions", "removable_mask", "INTEGER NOT NULL DEFAULT 0");
// Variant tag (NULL = the original plain cascade enumeration; "corner4" = the 4x4 opening-with-corner-mine
// family) plus the full-solve difficulty: total_complexity = sum of every static deduction's complexity,
// max_complexity = the hardest single deduction. Lets the admin filter variants and rank by full difficulty.
addColumnIfMissing("starting_positions", "variant", "TEXT");
addColumnIfMissing("starting_positions", "total_complexity", "REAL");
addColumnIfMissing("starting_positions", "max_complexity", "REAL");

// Patterns table: each row is a unique "first deduction" template —
// the minimal set of clue cells (with values) that fed into the
// analyzer's first move on some starting position, plus the cells
// that move deduced. Canonicalized by translation + dihedral
// symmetry, so any starting position whose first deduction matches
// the pattern up to position/rotation/mirror points at the same row.
// `method` is the derivation operation (trivial / subset / intersect
// / union / case) — not the reveal/flag/mixed distinction, since that
// just falls out of whatever cells the operation happens to force.
db.exec(
	"CREATE TABLE IF NOT EXISTS patterns (" +
	"  id INTEGER PRIMARY KEY AUTOINCREMENT," +
	"  key TEXT NOT NULL UNIQUE," +
	"  cells_json TEXT NOT NULL," +
	"  width INTEGER NOT NULL," +
	"  height INTEGER NOT NULL," +
	"  clue_count INTEGER NOT NULL," +
	"  safe_count INTEGER NOT NULL," +
	"  mine_count INTEGER NOT NULL," +
	"  method TEXT NOT NULL," +
	"  complexity REAL NOT NULL," +
	"  rating INTEGER NOT NULL," +
	"  occurrence_count INTEGER NOT NULL DEFAULT 0," +
	"  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))" +
	");"
);
// Rename action → method on any earlier-schema rows.
try { db.exec("ALTER TABLE patterns RENAME COLUMN action TO method"); } catch (e) {}
addColumnIfMissing("starting_positions", "pattern_id", "INTEGER");

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

// Create a fresh guest user: a normal row (default rating/stats) flagged is_guest, not yet auth-linked.
// The display name is a random "GuestNNNNN".
function createGuest() {
	var name = "Guest" + (10000 + Math.floor(Math.random() * 90000));
	var providerId = crypto.randomBytes(12).toString("hex");
	var info = db.prepare(
		"INSERT INTO users (provider, provider_id, name, is_guest, created_at) VALUES ('guest', ?, ?, 1, ?)"
	).run(providerId, name, Date.now());
	return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

// Turn a guest into a real account by attaching a provider identity. If that provider account already
// EXISTS, we log into the existing account and discard the guest (its row + sessions are removed). If it's
// new, we upgrade the guest row IN PLACE — same id, so its rating and stats carry over. Returns
// { user, switched } where switched=true means we fell back to a pre-existing account.
function upgradeGuest(guestUserId, provider, providerId, name, avatarUrl, email) {
	providerId = String(providerId);
	var emailLower = email ? String(email).toLowerCase() : null;
	var guest = db.prepare("SELECT * FROM users WHERE id = ?").get(guestUserId);
	if (!guest || !guest.is_guest) {
		// Not actually a guest (e.g. a stale token) — treat as a normal login.
		return { user: upsertUser(provider, providerId, name, avatarUrl, email), switched: false };
	}
	var existing = db.prepare("SELECT * FROM users WHERE provider = ? AND provider_id = ?").get(provider, providerId);
	if (existing) {
		// Collision: that account already exists → use it, drop the guest.
		db.prepare("DELETE FROM sessions WHERE user_id = ?").run(guestUserId);
		db.prepare("DELETE FROM users WHERE id = ?").run(guestUserId);
		db.prepare("UPDATE users SET name = ?, avatar_url = ?, email = COALESCE(?, email) WHERE id = ?")
			.run(name, avatarUrl || null, emailLower, existing.id);
		var ex = db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
		applyAdminForEmail(ex);
		return { user: ex, switched: true };
	}
	db.prepare("UPDATE users SET provider = ?, provider_id = ?, name = ?, avatar_url = ?, email = ?, is_guest = 0 WHERE id = ?")
		.run(provider, providerId, name, avatarUrl || null, emailLower, guestUserId);
	var upgraded = db.prepare("SELECT * FROM users WHERE id = ?").get(guestUserId);
	applyAdminForEmail(upgraded);
	return { user: upgraded, switched: false };
}

function setUserName(userId, name) {
	db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, userId);
}

// Drive-by guests pile up — every tokenless visit makes a guest row. Periodically delete guests that
// never engaged (no ranked games, no puzzle attempts) and are older than maxAgeMs, along with their
// sessions. Guests who actually played something are kept (they may return via their stored token).
// Uses a subquery (not an IN-list of ids) so it scales past SQLite's bound-parameter limit. Returns
// the number of guests removed.
function pruneStaleGuests(maxAgeMs) {
	var cutoff = Date.now() - Math.max(0, maxAgeMs || 0);
	var sel = "SELECT id FROM users WHERE is_guest = 1 AND played = 0 AND puzzles_attempted = 0 AND created_at < " + cutoff;
	var n = db.prepare("SELECT COUNT(*) AS c FROM (" + sel + ")").get().c;
	if (!n) return 0;
	db.exec("BEGIN");
	try {
		db.exec("DELETE FROM sessions WHERE user_id IN (" + sel + ")");
		db.exec("DELETE FROM puzzle_attempts WHERE user_id IN (" + sel + ")");
		db.exec("DELETE FROM daily_attempts WHERE user_id IN (" + sel + ")");
		db.exec("DELETE FROM users WHERE id IN (" + sel + ")"); // users last — the child deletes still need it
		db.exec("COMMIT");
	} catch (e) { db.exec("ROLLBACK"); throw e; }
	return n;
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

// Write a fresh rating to the column for the playstyle this match
// belonged to. `style` is one of "sprint" | "standard" | "tournament";
// anything else falls back to the legacy `rating` column so old
// callers keep working.
function updateRating(userId, newRating, won, style) {
	var ratingCol = "rating";
	if (style === "sprint")       ratingCol = "rating_sprint";
	else if (style === "standard")   ratingCol = "rating_standard";
	else if (style === "tournament") ratingCol = "rating_tournament";
	else if (style === "territory")  ratingCol = "rating_territory";
	// `played` / `wins` stay as overall ranked counts so leaderboards
	// can still show a single record per user.
	db.prepare(
		"UPDATE users SET " + ratingCol + " = ?, played = played + 1, wins = wins + ? WHERE id = ?"
	).run(newRating, won ? 1 : 0, userId);
}

function deleteSession(token) {
	if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function topPlayers(limit) {
	return db.prepare("SELECT name, rating, wins, played FROM users WHERE is_guest = 0 ORDER BY rating DESC LIMIT ?").all(limit || 20);
}

// Map the CSP-driven score (max complexity + small total bonus) to a
// chess-style puzzle rating. Linear `240·(score − 0.5)`, clamped at 0,
// so the easiest possible puzzle (a single trivial cascade reveal,
// score ≈ 0.5) lands right at 0 and the deepest current puzzles
// (score ≈ 13) reach ~3000.
function scoreToRating(score) {
	if (!score || score <= 0) return 0;
	return Math.max(0, Math.round(240 * (score - 0.5)));
}

function insertPuzzle(p) {
	var info = db.prepare(
		"INSERT OR IGNORE INTO puzzles " +
		"(canonical_key, rows, cols, mines, revealed, covered_safe, difficulty, score, rating, " +
		" trivial_passes, subset_passes, overlap_passes, chain_passes, enum_passes, max_enum_size, " +
		" needs_case_split, csp_method, source, scoring_version, created_at) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
		p.needsCaseSplit ? 1 : 0,
		p.cspMethod || "trivial",
		p.source || "random",
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
		cspMethod: row.csp_method || "trivial",
		needsCaseSplit: !!row.needs_case_split,
		source: row.source || "random",
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
	// Filter on the CSP analyzer's hardest-op tag. Old pass-tag columns
	// (subset_passes / overlap_passes / chain_passes / enum_passes) are
	// retained but no longer drive the filter, since they reflected the
	// pre-CSP pass-based analyzer's path through a puzzle, not the proof
	// the current solver actually constructs.
	if (method === "trivial")   return "csp_method = 'trivial'";
	if (method === "subset")    return "csp_method = 'subset'";
	if (method === "union")     return "csp_method = 'union'";
	if (method === "intersect") return "csp_method = 'intersect'";
	if (method === "case")      return "csp_method = 'case'";
	if (method === "enum")      return "csp_method = 'enum'";
	return null;
}

function sourceClause(source) {
	if (source) return { sql: "source = ?", param: source }; // any source (random, inside_out, template:<id>, …)
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
	var src = sourceClause(opts.source);
	if (src) { clauses.push(src.sql); params.push(src.param); }
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

// Distinct puzzle sources present in the pool, with counts — drives the All-Puzzles source filter so
// dynamic sources (e.g. "template:<id>") show up automatically.
function puzzleSources() {
	return db.prepare("SELECT source, COUNT(*) AS count FROM puzzles GROUP BY source ORDER BY count DESC, source").all();
}

// Remove all puzzles from one source — lets a template scout re-run replace its stored puzzles.
function clearPuzzlesBySource(source) {
	db.prepare("DELETE FROM puzzles WHERE source = ?").run(source);
}

function puzzleCount(difficulty, method, scoreBand, source) {
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
	var src = sourceClause(source);
	if (src) { clauses.push(src.sql); params.push(src.param); }
	var sql = "SELECT COUNT(*) AS n FROM puzzles";
	if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
	var stmt = db.prepare(sql);
	return stmt.get.apply(stmt, params).n;
}

// Aggregate stats for the All-Puzzles dashboard. Single query per metric
// keeps it cheap even on big pools.
function puzzleStats() {
	var total = db.prepare("SELECT COUNT(*) AS n FROM puzzles").get().n;
	if (!total) return { total: 0 };
	var ratingRows = db.prepare(
		"SELECT (rating / 200) * 200 AS bucket, COUNT(*) AS n FROM puzzles GROUP BY bucket ORDER BY bucket"
	).all();
	var tierRows = db.prepare(
		"SELECT difficulty AS tier, " +
		"  SUM(CASE WHEN csp_method = 'trivial'   THEN 1 ELSE 0 END) AS trivial, " +
		"  SUM(CASE WHEN csp_method = 'subset'    THEN 1 ELSE 0 END) AS subset, " +
		"  SUM(CASE WHEN csp_method = 'union'     THEN 1 ELSE 0 END) AS union_, " +
		"  SUM(CASE WHEN csp_method = 'intersect' THEN 1 ELSE 0 END) AS intersect_, " +
		"  SUM(CASE WHEN csp_method = 'case'      THEN 1 ELSE 0 END) AS case_, " +
		"  SUM(CASE WHEN csp_method = 'enum'      THEN 1 ELSE 0 END) AS enum_, " +
		"  COUNT(*) AS n " +
		"FROM puzzles GROUP BY difficulty ORDER BY difficulty"
	).all();
	var sizeRows = db.prepare(
		"SELECT rows || 'x' || cols AS size, COUNT(*) AS n FROM puzzles GROUP BY size ORDER BY rows, cols"
	).all();
	// Density bucketed at 5% intervals.
	var densityRows = db.prepare(
		"SELECT (CAST(json_array_length(mines) * 100 / (rows * cols) AS INTEGER) / 5) * 5 AS bucket, COUNT(*) AS n FROM puzzles GROUP BY bucket ORDER BY bucket"
	).all();
	var caseCount = db.prepare("SELECT COUNT(*) AS n FROM puzzles WHERE needs_case_split = 1").get().n;
	return {
		total: total,
		ratingHistogram: ratingRows.map(function(r) { return { bucket: r.bucket, n: r.n }; }),
		tierBreakdown: tierRows.map(function(r) {
			return { tier: r.tier, n: r.n,
				trivial: r.trivial, subset: r.subset, union: r.union_,
				intersect: r.intersect_, case: r.case_, enum: r.enum_ };
		}),
		sizeMix: sizeRows.map(function(r) { return { size: r.size, n: r.n }; }),
		densityMix: densityRows.map(function(r) { return { bucket: r.bucket, n: r.n }; }),
		needsCaseSplit: caseCount
	};
}

function clearPuzzles() {
	db.exec("DELETE FROM puzzles");
}

function insertStartingPosition(p) {
	try {
		var info = db.prepare(
			"INSERT INTO starting_positions " +
			"(size, pattern, solutions, forced_safe, forced_mine, forced_safe_mask, forced_mine_mask, is_prime, removable_mask, first_action, first_complexity, rating, variant, total_complexity, max_complexity) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		).run(p.size, p.pattern, p.solutions, p.forcedSafe, p.forcedMine, p.forcedSafeMask || 0, p.forcedMineMask || 0, p.isPrime ? 1 : 0, p.removableMask || 0, p.firstAction, p.firstComplexity, p.rating, p.variant || null, p.totalComplexity != null ? p.totalComplexity : null, p.maxComplexity != null ? p.maxComplexity : null);
		return info.lastInsertRowid;
	} catch (e) {
		// UNIQUE constraint — pattern already exists for this size.
		if (/UNIQUE/.test(e.message)) return null;
		throw e;
	}
}

function clearStartingPositions(size) {
	if (size != null) db.prepare("DELETE FROM starting_positions WHERE size = ?").run(size);
	else db.exec("DELETE FROM starting_positions");
}

function clearStartingPositionsVariant(variant) {
	db.prepare("DELETE FROM starting_positions WHERE variant = ?").run(variant);
}

function getStartingPositionById(id) {
	return db.prepare("SELECT * FROM starting_positions WHERE id = ?").get(id);
}

function startingPositionFilterClauses(opts) {
	var clauses = [];
	var params = [];
	if (opts.size != null) { clauses.push("size = ?"); params.push(opts.size); }
	if (opts.firstAction) { clauses.push("first_action = ?"); params.push(opts.firstAction); }
	if (opts.minRating != null) { clauses.push("rating >= ?"); params.push(opts.minRating); }
	if (opts.maxRating != null) { clauses.push("rating <= ?"); params.push(opts.maxRating); }
	if (opts.uniqueSolution === true) { clauses.push("solutions = 1"); }
	else if (opts.uniqueSolution === false) { clauses.push("solutions > 1"); }
	if (opts.prime === true) { clauses.push("is_prime = 1"); }
	else if (opts.prime === false) { clauses.push("is_prime = 0"); }
	return { clauses: clauses, params: params };
}

function listStartingPositions(opts) {
	opts = opts || {};
	var f = startingPositionFilterClauses(opts);
	var sortDir = opts.sort === "desc" ? "DESC" : "ASC";
	var pageSize = Math.max(1, Math.min(500, opts.pageSize || 100));
	var page = Math.max(0, opts.page || 0);
	var sql = "SELECT * FROM starting_positions";
	if (f.clauses.length) sql += " WHERE " + f.clauses.join(" AND ");
	sql += " ORDER BY rating " + sortDir + ", id " + sortDir + " LIMIT ? OFFSET ?";
	var params = f.params.concat([pageSize, page * pageSize]);
	var stmt = db.prepare(sql);
	return stmt.all.apply(stmt, params);
}

// Upsert a deduction pattern. If the key already exists, increment
// occurrence_count and leave other fields alone. Returns the row id.
function upsertPattern(p) {
	var existing = db.prepare("SELECT id FROM patterns WHERE key = ?").get(p.key);
	if (existing) {
		db.prepare("UPDATE patterns SET occurrence_count = occurrence_count + 1 WHERE id = ?").run(existing.id);
		return existing.id;
	}
	var info = db.prepare(
		"INSERT INTO patterns (key, cells_json, width, height, clue_count, safe_count, mine_count, method, complexity, rating, occurrence_count) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)"
	).run(p.key, p.cellsJson, p.width, p.height, p.clueCount, p.safeCount, p.mineCount, p.method, p.complexity, p.rating);
	return info.lastInsertRowid;
}

function clearPatterns() {
	db.exec("DELETE FROM patterns");
	db.prepare("UPDATE starting_positions SET pattern_id = NULL").run();
}

function setStartingPositionPattern(startingPositionId, patternId) {
	db.prepare("UPDATE starting_positions SET pattern_id = ? WHERE id = ?").run(patternId, startingPositionId);
}

function listPatterns(opts) {
	opts = opts || {};
	var clauses = [];
	var params = [];
	if (opts.minRating != null) { clauses.push("rating >= ?"); params.push(opts.minRating); }
	if (opts.maxRating != null) { clauses.push("rating <= ?"); params.push(opts.maxRating); }
	if (opts.method) { clauses.push("method = ?"); params.push(opts.method); }
	var sortDir = opts.sort === "asc" ? "ASC" : "DESC";
	var sortBy = opts.orderBy === "occurrences" ? "occurrence_count" : "rating";
	var pageSize = Math.max(1, Math.min(500, opts.pageSize || 100));
	var page = Math.max(0, opts.page || 0);
	var sql = "SELECT * FROM patterns";
	if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
	sql += " ORDER BY " + sortBy + " " + sortDir + ", id ASC LIMIT ? OFFSET ?";
	var stmt = db.prepare(sql);
	return stmt.all.apply(stmt, params.concat([pageSize, page * pageSize]));
}

function patternCount(opts) {
	opts = opts || {};
	var clauses = [];
	var params = [];
	if (opts.minRating != null) { clauses.push("rating >= ?"); params.push(opts.minRating); }
	if (opts.maxRating != null) { clauses.push("rating <= ?"); params.push(opts.maxRating); }
	if (opts.method) { clauses.push("method = ?"); params.push(opts.method); }
	var sql = "SELECT COUNT(*) AS n FROM patterns";
	if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
	var stmt = db.prepare(sql);
	return stmt.get.apply(stmt, params).n;
}

function startingPositionCount(opts) {
	// Backwards-compatible: passing a number is treated as `size`.
	if (typeof opts === "number") opts = { size: opts };
	opts = opts || {};
	var f = startingPositionFilterClauses(opts);
	var sql = "SELECT COUNT(*) AS n FROM starting_positions";
	if (f.clauses.length) sql += " WHERE " + f.clauses.join(" AND ");
	var stmt = db.prepare(sql);
	return stmt.get.apply(stmt, f.params).n;
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
	// Never serve a case-analysis puzzle as the daily — those need reasoning beyond the in-game
	// (pass-based) solver and aren't accessible to casual players.
	var row = db.prepare("SELECT * FROM puzzles WHERE needs_case_split = 0 AND rating BETWEEN 1400 AND 1700 ORDER BY RANDOM() LIMIT 1").get();
	if (row) return deserializePuzzle(row);
	row = db.prepare("SELECT * FROM puzzles WHERE needs_case_split = 0 AND rating BETWEEN 1100 AND 2000 ORDER BY RANDOM() LIMIT 1").get();
	if (row) return deserializePuzzle(row);
	row = db.prepare("SELECT * FROM puzzles WHERE needs_case_split = 0 ORDER BY RANDOM() LIMIT 1").get();
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
		"max_enum_size = ?, needs_case_split = ?, csp_method = ?, scoring_version = ? " +
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
		analysis.needsCaseSplit ? 1 : 0,
		analysis.cspMethod || "trivial",
		CURRENT_SCORING_VERSION,
		id
	);
}

module.exports = {
	upsertUser: upsertUser,
	createGuest: createGuest,
	upgradeGuest: upgradeGuest,
	setUserName: setUserName,
	pruneStaleGuests: pruneStaleGuests,
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
	puzzleSources: puzzleSources,
	clearPuzzlesBySource: clearPuzzlesBySource,
	puzzleStats: puzzleStats,
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
	applyPuzzleClassification: applyPuzzleClassification,
	// Starting positions
	insertStartingPosition: insertStartingPosition,
	clearStartingPositions: clearStartingPositions,
	clearStartingPositionsVariant: clearStartingPositionsVariant,
	getStartingPositionById: getStartingPositionById,
	listStartingPositions: listStartingPositions,
	startingPositionCount: startingPositionCount,
	// Patterns
	upsertPattern: upsertPattern,
	clearPatterns: clearPatterns,
	setStartingPositionPattern: setStartingPositionPattern,
	listPatterns: listPatterns,
	patternCount: patternCount
};
