// Persistent storage for ranked accounts and sessions, backed by node:sqlite
// (built in, no native compilation). A single file on disk survives restarts.
var sqlite = require("node:sqlite");
var crypto = require("node:crypto");
var path = require("path");
var BoardLogic = require("../common/BoardLogic");

// Bumped any time the puzzle scoring formula changes. Rows stored under an
// older version are re-classified on startup so their score and rating
// match what a freshly-generated puzzle would get.
var CURRENT_SCORING_VERSION = 22;

// Dev: ranked.db lives at the project root (gitignored). Prod: RANKED_DB is
// set to /data/ranked.db on the fly volume.
var DB_PATH = process.env.RANKED_DB || path.join(__dirname, "..", "..", "ranked.db");
var db = new sqlite.DatabaseSync(DB_PATH);
// WAL lets readers and writers proceed concurrently instead of blocking on the single rollback
// journal, and busy_timeout makes a writer that DOES collide with another connection's write retry
// for a few seconds instead of failing instantly with SQLITE_BUSY. Needed now that a spawned
// generator subprocess (marathonGen.js) can hold its own connection to this same file alongside
// the main server process's.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(
	"CREATE TABLE IF NOT EXISTS users (" +
	"  id INTEGER PRIMARY KEY," +
	"  provider TEXT NOT NULL," +
	"  provider_id TEXT NOT NULL," +
	"  name TEXT NOT NULL," +
	"  avatar_url TEXT," +
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
addColumnIfMissing("users", "puzzle_rating", "INTEGER NOT NULL DEFAULT 0");
// Puzzle Ladder points — a monotonic progression currency (never decreases) that drives the puzzle
// tier/level. Separate from puzzle_rating, which stays two-way and only sets puzzle difficulty.
addColumnIfMissing("users", "puzzle_points", "INTEGER NOT NULL DEFAULT 0");
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
// `provider` is the account's ORIGINAL/primary login (never changes once set). `last_provider` is the
// one most recently signed in with — for accounts linked across providers, the topbar shows this.
addColumnIfMissing("users", "last_provider", "TEXT");
// `display_name` is the shown, user-editable name. On first real login it's seeded from the provider's
// name; renames (set_name) touch ONLY display_name, so a later provider login never clobbers a chosen
// name. The shown name is `display_name || name` (legacy `name` is the fallback / guest auto-name).
addColumnIfMissing("users", "display_name", "TEXT");
// Per-provider raw auth fields, stored verbatim in case we want them later. (Account RESOLUTION uses the
// `user_identities` index; these are a convenience copy of each provider's id + name on the user row.)
addColumnIfMissing("users", "google_auth_id", "TEXT");
addColumnIfMissing("users", "google_auth_name", "TEXT");
addColumnIfMissing("users", "discord_auth_id", "TEXT");
addColumnIfMissing("users", "discord_auth_name", "TEXT");
addColumnIfMissing("users", "github_auth_id", "TEXT");
addColumnIfMissing("users", "github_auth_name", "TEXT");
// Backfill existing REAL accounts: their current `name` is already their chosen/shown name, so adopt it
// as display_name. Guests stay NULL so they keep showing their GuestNNNNN name and don't count as "set".
try { db.exec("UPDATE users SET display_name = name WHERE is_guest = 0 AND display_name IS NULL"); }
catch (e) { console.error("display_name backfill failed", e); }
// Backfill the per-provider columns from each row's primary provider (linked providers fill on next login).
["google", "discord", "github"].forEach(function(p) {
	try { db.exec("UPDATE users SET " + p + "_auth_id = provider_id, " + p + "_auth_name = name WHERE provider = '" + p + "' AND " + p + "_auth_id IS NULL"); }
	catch (e) { console.error("auth-field backfill failed for " + p, e); }
});
// `provider_name` was a single-column predecessor of the per-provider auth columns above — drop it.
dropColumnIfExists("users", "provider_name");
// Ranked is split into Sprint / Standard playstyles (and Tournament keeps
// its own pool). Each playstyle carries its own Elo and provisional
// counter so a player can be Bronze at Sprint and Gold at Standard.
addColumnIfMissing("users", "rating_sprint", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "rating_standard", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "rating_tournament", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "rating_territory", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "sprint_provisional", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "standard_provisional", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("users", "tournament_provisional", "INTEGER NOT NULL DEFAULT 0");
// Ladder rework: the tier ladder now runs 0 → 3000 with 200-wide sub-tiers (Bronze I = 0)
// instead of the old 1000-base / 50-wide bands. Every account resets to 0 and re-places from
// Bronze with fresh placement games. One-shot, guarded by ranked_reset_v2 so it runs once per
// row (a player who earns rating after the reset keeps it across reboots).
addColumnIfMissing("users", "ranked_reset_v2", "INTEGER NOT NULL DEFAULT 0");
// Cosmetic identity: avatar is the in-game flag recoloured to `avatar_color` (a #rrggbb cloth colour;
// null → the default red). `country` is an ISO-3166 alpha-2 code (null → none), shown as a flag emoji.
addColumnIfMissing("users", "avatar_color", "TEXT");
addColumnIfMissing("users", "country", "TEXT");
try {
	db.exec(
		"UPDATE users SET rating_sprint = 0, rating_standard = 0, rating_tournament = 0, " +
		"rating_territory = 0, provisional_games = 0, sprint_provisional = 0, standard_provisional = 0, " +
		"tournament_provisional = 0, played = 0, wins = 0, ranked_reset_v2 = 1 WHERE ranked_reset_v2 = 0"
	);
} catch (e) { /* already reset */ }
// The single legacy `rating` column is gone — "overall" rating is now max-across-modes, computed
// on demand (readUserRating with no style / topPlayers). Drop it so it can't be read by accident.
dropColumnIfExists("users", "rating");

// --- Multi-provider identities + email-based account linking -------------------------------------
// One account can be reached through more than one login (Google, Discord, …). Each provider login is
// a row here keyed by (provider, provider_id), all pointing at a single users.id. The verified `email`
// is what unifies them: signing in with a NEW provider whose email matches an existing account links to
// that account instead of creating a duplicate. (`users.provider/provider_id` stays as the account's
// original/primary login for back-compat; additional logins live only here.)
db.exec(
	"CREATE TABLE IF NOT EXISTS user_identities (" +
	"  provider TEXT NOT NULL," +
	"  provider_id TEXT NOT NULL," +
	"  user_id INTEGER NOT NULL," +
	"  email TEXT," +
	"  created_at INTEGER NOT NULL," +
	"  PRIMARY KEY (provider, provider_id)" +
	");" +
	"CREATE INDEX IF NOT EXISTS idx_identities_user ON user_identities(user_id);"
);
// Backfill one identity row per existing real account from its original provider login.
try {
	db.exec(
		"INSERT OR IGNORE INTO user_identities (provider, provider_id, user_id, email, created_at) " +
		"SELECT provider, provider_id, id, email, created_at FROM users WHERE is_guest = 0"
	);
} catch (e) { console.error("identity backfill failed", e); }

// Free-play (solo) best clear times, one row per (user, board size, mine-density%). density is a whole
// percent so the key is stable across the float densities the picker uses (10 / 15 / 20).
db.exec(
	"CREATE TABLE IF NOT EXISTS solo_records (" +
	"  user_id INTEGER NOT NULL," +
	"  size TEXT NOT NULL," +
	"  density INTEGER NOT NULL," +
	"  best_ms INTEGER NOT NULL," +
	"  achieved_at INTEGER NOT NULL," +
	"  PRIMARY KEY (user_id, size, density)" +
	");"
);
// Ranked match history: one row per human player per completed ranked match (written wherever Elo
// is persisted — see elo.js). Powers the profile's rating graph + recent-games list. `rating_before`
// / `rating_after` are the style's rating around this match; `placement`/`players` give the finish
// (1 = won); `opponent` is a short label (the other player in 1v1, else null).
db.exec(
	"CREATE TABLE IF NOT EXISTS match_history (" +
	"  id INTEGER PRIMARY KEY," +
	"  user_id INTEGER NOT NULL," +
	"  style TEXT NOT NULL," +
	"  rating_before INTEGER NOT NULL," +
	"  rating_after INTEGER NOT NULL," +
	"  placement INTEGER NOT NULL," +
	"  players INTEGER NOT NULL," +
	"  won INTEGER NOT NULL," +
	"  opponent TEXT," +
	"  created_at INTEGER NOT NULL" +
	");" +
	"CREATE INDEX IF NOT EXISTS idx_match_user ON match_history(user_id, created_at);"
);
// Stored replays of ranked matches. `data` is a gzipped binary input-log (see runtime/replay.js):
// a header + per-round mine layout bitmask + per-player event tracks (varint dt + cell<<1|button),
// re-simulated at playback time. Participants live in a side table so we can list a user's replays
// without scanning the (compressed) blob column.
db.exec(
	"CREATE TABLE IF NOT EXISTS match_replays (" +
	"  id INTEGER PRIMARY KEY," +
	"  created_at INTEGER NOT NULL," +
	"  style TEXT," +
	"  mode TEXT," +
	"  rows INTEGER NOT NULL," +
	"  cols INTEGER NOT NULL," +
	"  mine_count INTEGER NOT NULL," +
	"  game_count INTEGER NOT NULL," +
	"  winner_id INTEGER," +
	"  players TEXT," +
	"  format INTEGER NOT NULL DEFAULT 1," +
	"  raw_bytes INTEGER NOT NULL," +
	"  data BLOB NOT NULL" +
	");" +
	"CREATE INDEX IF NOT EXISTS idx_replay_created ON match_replays(created_at);" +
	"CREATE TABLE IF NOT EXISTS match_replay_players (" +
	"  replay_id INTEGER NOT NULL," +
	"  user_id INTEGER NOT NULL," +
	"  PRIMARY KEY (replay_id, user_id)" +
	");" +
	"CREATE INDEX IF NOT EXISTS idx_replay_player ON match_replay_players(user_id, replay_id);"
);
// Idempotency ledger for match-result persistence (PHASE0_TICKETS.md P0-5): one row per match whose
// results have been applied, so a retried/duplicated result report can't double-apply Elo/history/replay.
// Survives restarts (it's a table, not in-memory) — which is what makes the future game-server→main
// reportResult boundary safe to retry.
db.exec(
	"CREATE TABLE IF NOT EXISTS processed_matches (" +
	"  match_id TEXT PRIMARY KEY," +
	"  created_at INTEGER NOT NULL" +
	");"
);
// Link each match_history row to its stored replay (set after the replay is saved at series end).
// Null for matches with no replay (pre-feature history, or matches with no recorded moves).
addColumnIfMissing("match_history", "replay_id", "INTEGER");
// Pre-aggregated per-player stats — the achievement/progress metrics, maintained INCREMENTALLY at the
// event seams (match end / puzzle solve / daily) so reading them is a single PK lookup, never a scan.
// `backfilled` gates a one-time migration that seeds the row from existing history the first time it's
// read (so existing players keep their numbers); after that it's pure increments. The *_current / stat_day
// / day_* columns are working state needed to maintain the *_best columns incrementally.
db.exec(
	"CREATE TABLE IF NOT EXISTS player_stats (" +
	"  user_id INTEGER PRIMARY KEY," +
	"  wins_sprint INTEGER NOT NULL DEFAULT 0, wins_standard INTEGER NOT NULL DEFAULT 0," +
	"  wins_tournament INTEGER NOT NULL DEFAULT 0, wins_territory INTEGER NOT NULL DEFAULT 0," +
	"  peak_sprint INTEGER NOT NULL DEFAULT 0, peak_standard INTEGER NOT NULL DEFAULT 0," +
	"  peak_tournament INTEGER NOT NULL DEFAULT 0, peak_territory INTEGER NOT NULL DEFAULT 0," +
	"  win_streak_current INTEGER NOT NULL DEFAULT 0, win_streak_best INTEGER NOT NULL DEFAULT 0," +
	"  stat_day TEXT, day_wins INTEGER NOT NULL DEFAULT 0, best_day_wins INTEGER NOT NULL DEFAULT 0," +
	"  day_gain INTEGER NOT NULL DEFAULT 0, best_day_gain INTEGER NOT NULL DEFAULT 0," +
	"  best_swing INTEGER NOT NULL DEFAULT 0," +
	"  wins_1v1 INTEGER NOT NULL DEFAULT 0, wins_6p INTEGER NOT NULL DEFAULT 0," +
	"  peak_puzzle_rating INTEGER NOT NULL DEFAULT 0," +
	"  dailies_solved INTEGER NOT NULL DEFAULT 0, daily_streak_best INTEGER NOT NULL DEFAULT 0," +
	"  last_active_day TEXT, distinct_days INTEGER NOT NULL DEFAULT 0," +
	"  noflag_clears INTEGER NOT NULL DEFAULT 0, noreveal_clears INTEGER NOT NULL DEFAULT 0," +
	"  backfilled INTEGER NOT NULL DEFAULT 0" +
	");"
);
// Added after the table shipped — present on fresh DBs via the CREATE above, added here for existing ones.
addColumnIfMissing("player_stats", "noflag_clears", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("player_stats", "noreveal_clears", "INTEGER NOT NULL DEFAULT 0");
// Per-technique pass counts (trivial/subset/overlap/chain/enum_passes) were a
// product of the old pass-based PuzzleSolver, which has been removed. The CSP
// analyzer's `csp_method` / `needs_case_split` classification replaced them, so
// drop the legacy columns from any existing DB.
function dropColumnIfExists(table, column) {
	var cols = db.prepare("PRAGMA table_info(" + table + ")").all();
	if (!cols.some(function(c) { return c.name === column; })) return;
	try { db.exec("ALTER TABLE " + table + " DROP COLUMN " + column); }
	catch (e) { /* older SQLite without DROP COLUMN: leave the unused column in place */ }
}
["trivial_passes", "subset_passes", "overlap_passes", "chain_passes", "enum_passes"].forEach(function(col) {
	dropColumnIfExists("puzzles", col);
});
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
// Raw CSP-analyzer complexity floats (nullable — only populated by generators that keep them, e.g.
// scripts/generate-marathon-boards.js; the tier-banded `difficulty` above is derived from max_complexity
// but the exact value isn't otherwise stored). Mirrors the same fields on `starting_positions`.
addColumnIfMissing("puzzles", "max_complexity", "REAL");
addColumnIfMissing("puzzles", "total_complexity", "REAL");
// Generation provenance for script-generated boards (marathon/Nightmare boards): which algorithm
// produced it (e.g. "hillclimb:6x6") and how many accepted improvement passes it took. Null for the
// normal curriculum-puzzle sources (random/inside_out/template:*).
addColumnIfMissing("puzzles", "gen_method", "TEXT");
addColumnIfMissing("puzzles", "gen_iterations", "INTEGER");

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

// Dedicated user-row columns holding each auth provider's raw id + name (dev/guest have none).
var AUTH_PROVIDER_COLUMNS = {
	google:  { id: "google_auth_id",  name: "google_auth_name" },
	discord: { id: "discord_auth_id", name: "discord_auth_name" },
	github:  { id: "github_auth_id",  name: "github_auth_name" }
};
// Stash the provider's raw id + name on the user row (kept verbatim for later use; not the shown name).
function setProviderAuthFields(userId, provider, providerId, providerName) {
	var cols = AUTH_PROVIDER_COLUMNS[provider];
	if (!cols) return;
	db.prepare("UPDATE users SET " + cols.id + " = ?, " + cols.name + " = ? WHERE id = ?")
		.run(String(providerId), providerName || null, userId);
}

// Record a provider login as a route into an account (idempotent on (provider, provider_id)).
function linkIdentity(userId, provider, providerId, emailLower) {
	db.prepare(
		"INSERT OR IGNORE INTO user_identities (provider, provider_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)"
	).run(provider, String(providerId), userId, emailLower || null, Date.now());
}

// Which account a provider login belongs to: first an already-linked identity, then (account
// linking) a real account sharing the same verified email. Null if it's a brand-new login.
function findAccountForLogin(provider, providerId, emailLower) {
	var ident = db.prepare("SELECT user_id FROM user_identities WHERE provider = ? AND provider_id = ?").get(provider, String(providerId));
	if (ident) return db.prepare("SELECT * FROM users WHERE id = ?").get(ident.user_id) || null;
	if (emailLower) {
		var byEmail = db.prepare("SELECT * FROM users WHERE LOWER(email) = ? AND is_guest = 0 ORDER BY id LIMIT 1").get(emailLower);
		if (byEmail) return byEmail;
	}
	return null;
}

function upsertUser(provider, providerId, providerName, avatarUrl, email) {
	providerId = String(providerId);
	var emailLower = email ? String(email).toLowerCase() : null;
	var existing = findAccountForLogin(provider, providerId, emailLower);
	if (existing) {
		// Make sure this provider is recorded as a way into the account (links a new login to an
		// existing email on first use), then refresh the provider-sourced fields. display_name is only
		// SEEDED when missing — a chosen name is never overwritten by a later provider login.
		linkIdentity(existing.id, provider, providerId, emailLower);
		db.prepare("UPDATE users SET display_name = COALESCE(display_name, ?), " +
			"avatar_url = ?, email = COALESCE(?, email), last_provider = ? WHERE id = ?")
			.run(providerName, avatarUrl || null, emailLower, provider, existing.id);
		setProviderAuthFields(existing.id, provider, providerId, providerName);
		var updated = db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
		applyAdminForEmail(updated);
		return updated;
	}
	// New account: display_name starts as the provider name (legacy `name` mirrors it for back-compat).
	// Ranked ratings start at 0 (Bronze I) — set explicitly so a pre-existing DB whose columns
	// still carry the old DEFAULT 1000 doesn't seed new accounts at Silver III.
	var info = db.prepare(
		"INSERT INTO users (provider, provider_id, name, display_name, avatar_url, email, last_provider, created_at, " +
		"rating_sprint, rating_standard, rating_tournament, rating_territory, puzzle_rating) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)"
	).run(provider, providerId, providerName, providerName, avatarUrl || null, emailLower, provider, Date.now());
	linkIdentity(info.lastInsertRowid, provider, providerId, emailLower);
	setProviderAuthFields(info.lastInsertRowid, provider, providerId, providerName);
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
		"INSERT INTO users (provider, provider_id, name, is_guest, created_at, " +
		"rating_sprint, rating_standard, rating_tournament, rating_territory, puzzle_rating) " +
		"VALUES ('guest', ?, ?, 1, ?, 0, 0, 0, 0, 0)"
	).run(providerId, name, Date.now());
	return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
}

// Turn a guest into a real account by attaching a provider identity. If that provider account already
// EXISTS, we log into the existing account and discard the guest (its row + sessions are removed). If it's
// new, we upgrade the guest row IN PLACE — same id, so its rating and stats carry over. Returns
// { user, switched } where switched=true means we fell back to a pre-existing account.
function upgradeGuest(guestUserId, provider, providerId, providerName, avatarUrl, email) {
	providerId = String(providerId);
	var emailLower = email ? String(email).toLowerCase() : null;
	var guest = db.prepare("SELECT * FROM users WHERE id = ?").get(guestUserId);
	if (!guest || !guest.is_guest) {
		// Not actually a guest (e.g. a stale token) — treat as a normal login.
		return { user: upsertUser(provider, providerId, providerName, avatarUrl, email), switched: false };
	}
	var existing = findAccountForLogin(provider, providerId, emailLower);
	if (existing && existing.id !== guestUserId) {
		// The provider — or its verified email — already belongs to a real account → use it, drop the guest.
		db.prepare("DELETE FROM sessions WHERE user_id = ?").run(guestUserId);
		db.prepare("DELETE FROM users WHERE id = ?").run(guestUserId);
		linkIdentity(existing.id, provider, providerId, emailLower);
		db.prepare("UPDATE users SET display_name = COALESCE(display_name, ?), " +
			"avatar_url = ?, email = COALESCE(?, email), last_provider = ? WHERE id = ?")
			.run(providerName, avatarUrl || null, emailLower, provider, existing.id);
		setProviderAuthFields(existing.id, provider, providerId, providerName);
		var ex = db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
		applyAdminForEmail(ex);
		return { user: ex, switched: true };
	}
	// Upgrade in place: the guest becomes a real account. Seed display_name from the provider name ONLY
	// if the guest hadn't chosen one — a guest's auto-name lives in `name`, not display_name, so it
	// doesn't count as "set"; a guest who renamed (set_name → display_name) keeps that name.
	db.prepare("UPDATE users SET provider = ?, provider_id = ?, name = ?, " +
		"display_name = COALESCE(display_name, ?), avatar_url = ?, email = ?, is_guest = 0, last_provider = ? WHERE id = ?")
		.run(provider, providerId, providerName, providerName, avatarUrl || null, emailLower, provider, guestUserId);
	linkIdentity(guestUserId, provider, providerId, emailLower);
	setProviderAuthFields(guestUserId, provider, providerId, providerName);
	var upgraded = db.prepare("SELECT * FROM users WHERE id = ?").get(guestUserId);
	applyAdminForEmail(upgraded);
	return { user: upgraded, switched: false };
}

// The shown name: the user-editable display_name if set, else the legacy / guest `name`.
function displayNameOf(user) {
	return user ? (user.display_name || user.name) : "";
}

// Renames set ONLY the display name (the per-provider *_auth_name columns keep the raw provider values).
function setUserName(userId, name) {
	db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, userId);
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
	var cols = { sprint: "rating_sprint", standard: "rating_standard", tournament: "rating_tournament", territory: "rating_territory" };
	var ratingCol = cols[style];
	if (!ratingCol) return; // unknown style — nothing to persist (there is no legacy overall column)
	// `played` / `wins` stay as overall ranked counts so leaderboards
	// can still show a single record per user.
	db.prepare(
		"UPDATE users SET " + ratingCol + " = ?, played = played + 1, wins = wins + ? WHERE id = ?"
	).run(newRating, won ? 1 : 0, userId);
}

// Set a per-style rating outright (admin testing tool) — no played/wins change, unlike updateRating.
function setRating(userId, rating, style) {
	var cols = { sprint: "rating_sprint", standard: "rating_standard", tournament: "rating_tournament", territory: "rating_territory" };
	var ratingCol = cols[style];
	if (!ratingCol) return;
	db.prepare("UPDATE users SET " + ratingCol + " = ? WHERE id = ?").run(rating, userId);
}

function deleteSession(token) {
	if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// Top players for a leaderboard. `mode` picks the ranked style to rank by; anything else
// (incl. "overall"/undefined) ranks by the player's best across modes. The mode→column map is
// a whitelist, so the interpolated column name can never be attacker-controlled SQL.
var LEADERBOARD_COLUMNS = {
	sprint: "rating_sprint",
	standard: "rating_standard",
	tournament: "rating_tournament",
	territory: "rating_territory"
};
function topPlayers(limit, mode) {
	var col = LEADERBOARD_COLUMNS[mode];
	var ratingExpr = col || "MAX(rating_sprint, rating_standard, rating_tournament, rating_territory)";
	return db.prepare(
		"SELECT COALESCE(display_name, name) AS name, " + ratingExpr + " AS rating, " +
		"wins, played, avatar_color, country FROM users WHERE is_guest = 0 ORDER BY rating DESC LIMIT ?"
	).all(limit || 20);
}
// Cosmetic identity setters (avatar cloth colour + country code). Null clears.
function setAvatarColor(userId, color) { db.prepare("UPDATE users SET avatar_color = ? WHERE id = ?").run(color || null, userId); }
function setCountry(userId, country) { db.prepare("UPDATE users SET country = ? WHERE id = ?").run(country || null, userId); }

// --- Ranked match history + incremental player stats ---------------------------------------------
// Both writes are non-critical — never let them break rating application / match-end, so each
// swallows its own errors. recordMatch appends the history row AND bumps the player_stats counters.
var STAT_WIN_COL = { sprint: "wins_sprint", standard: "wins_standard", tournament: "wins_tournament", territory: "wins_territory" };
var STAT_PEAK_COL = { sprint: "peak_sprint", standard: "peak_standard", tournament: "peak_tournament", territory: "peak_territory" };
var ISO_DAY = function(ms) { return new Date(ms).toISOString().slice(0, 10); };
function longestDailyRun(dates) { // dates: sorted unique "YYYY-MM-DD"
	if (!dates.length) return 0;
	var best = 1, run = 1;
	for (var i = 1; i < dates.length; i++) {
		var prev = Date.parse(dates[i - 1] + "T00:00:00Z"), cur = Date.parse(dates[i] + "T00:00:00Z");
		if (cur - prev === 86400000) { run++; if (run > best) best = run; } else { run = 1; }
	}
	return best;
}
function ensurePlayerStats(userId) { db.prepare("INSERT OR IGNORE INTO player_stats (user_id) VALUES (?)").run(userId); }
// Count today as an active day if it's new since the last recorded activity (any mode).
function touchActiveDay(userId, day) {
	day = day || todayUtc();
	ensurePlayerStats(userId);
	db.prepare("UPDATE player_stats SET distinct_days = distinct_days + (CASE WHEN last_active_day = ? THEN 0 ELSE 1 END), last_active_day = ? WHERE user_id = ?").run(day, day, userId);
}
// Fold one finished match into the player's counters (read-modify-write; cheap, runs at match end).
function bumpMatchStats(m) {
	try {
		if (!m.userId) return;
		var winCol = STAT_WIN_COL[m.style], peakCol = STAT_PEAK_COL[m.style];
		if (!winCol || !peakCol) return; // unknown style
		ensurePlayerStats(m.userId);
		var s = db.prepare("SELECT win_streak_current, win_streak_best, stat_day, day_wins, day_gain FROM player_stats WHERE user_id = ?").get(m.userId);
		var today = todayUtc(), won = m.won ? 1 : 0, swing = (m.ratingAfter || 0) - (m.ratingBefore || 0);
		var newCur = won ? (s.win_streak_current || 0) + 1 : 0;
		var newBest = Math.max(s.win_streak_best || 0, newCur);
		var sameDay = s.stat_day === today;
		var dayWins = (sameDay ? (s.day_wins || 0) : 0) + won;
		var dayGain = (sameDay ? (s.day_gain || 0) : 0) + swing;
		db.prepare(
			"UPDATE player_stats SET " +
			winCol + " = " + winCol + " + ?, " + peakCol + " = MAX(" + peakCol + ", ?), " +
			"wins_1v1 = wins_1v1 + ?, wins_6p = wins_6p + ?, best_swing = MAX(best_swing, ?), " +
			"win_streak_current = ?, win_streak_best = ?, " +
			"stat_day = ?, day_wins = ?, best_day_wins = MAX(best_day_wins, ?), day_gain = ?, best_day_gain = MAX(best_day_gain, ?) " +
			"WHERE user_id = ?"
		).run(won, m.ratingAfter || 0, (m.players === 2 ? won : 0), (m.players >= 5 ? won : 0), swing,
			newCur, newBest, today, dayWins, dayWins, dayGain, dayGain, m.userId);
		touchActiveDay(m.userId, today);
	} catch (e) { console.error("bumpMatchStats failed", e); }
}
function recordMatch(m) {
	try {
		db.prepare(
			"INSERT INTO match_history (user_id, style, rating_before, rating_after, placement, players, won, opponent, created_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
		).run(m.userId, m.style, m.ratingBefore, m.ratingAfter, m.placement, m.players, m.won ? 1 : 0, m.opponent || null, Date.now());
	} catch (e) { console.error("recordMatch failed", e); }
	bumpMatchStats(m);
}
// Idempotency guard for match-result persistence (P0-5). Returns true the FIRST time a matchId is seen
// (the caller should then apply Elo/replay), false if it was already persisted — so a retried/duplicate
// result report can't double-apply. Fails OPEN (returns true) on a missing id or DB error: better to risk
// a rare duplicate than to silently drop a real result.
function markMatchPersisted(matchId) {
	if (!matchId) return true;
	try {
		var info = db.prepare("INSERT OR IGNORE INTO processed_matches (match_id, created_at) VALUES (?, ?)")
			.run(String(matchId), Date.now());
		return info.changes > 0; // 1 = newly inserted (first time); 0 = already present
	} catch (e) { console.error("markMatchPersisted failed", e); return true; }
}
// Puzzle solve/attempt: keep the peak puzzle rating + an active day. (Called from updateUserPuzzleRating.)
function bumpPuzzleStats(userId, newRating) {
	try {
		ensurePlayerStats(userId);
		db.prepare("UPDATE player_stats SET peak_puzzle_rating = MAX(peak_puzzle_rating, ?) WHERE user_id = ?").run(newRating || 0, userId);
		touchActiveDay(userId, todayUtc());
	} catch (e) { console.error("bumpPuzzleStats failed", e); }
}
// Daily attempt: active day always; on a solve bump the count + best streak. (Called from recordDailyAttempt.)
function bumpDailyStats(userId, streak, solved) {
	try {
		touchActiveDay(userId, todayUtc());
		if (solved) db.prepare("UPDATE player_stats SET dailies_solved = dailies_solved + 1, daily_streak_best = MAX(daily_streak_best, ?) WHERE user_id = ?").run(streak || 0, userId);
	} catch (e) { console.error("bumpDailyStats failed", e); }
}
// A finished board (solo/racing, never puzzles) cleared without a flag and/or without a direct reveal.
function recordClear(userId, noFlag, noReveal) {
	try {
		ensurePlayerStats(userId);
		db.prepare("UPDATE player_stats SET noflag_clears = noflag_clears + ?, noreveal_clears = noreveal_clears + ? WHERE user_id = ?")
			.run(noFlag ? 1 : 0, noReveal ? 1 : 0, userId);
	} catch (e) { console.error("recordClear failed", e); }
}
// Recent matches across all styles (newest first) — the "recent games" list. `replay_id` is non-null
// when a stored replay exists for that match (drives the inline "Watch" link).
function getMatchHistory(userId, limit) {
	return db.prepare(
		"SELECT style, rating_before, rating_after, placement, players, won, opponent, created_at, replay_id " +
		"FROM match_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
	).all(userId, limit || 50);
}
// Oldest-first rating points across all styles — the client buckets per style for the graph.
function getRatingHistory(userId, limit) {
	return db.prepare(
		"SELECT style, rating_before, rating_after, created_at " +
		"FROM match_history WHERE user_id = ? ORDER BY created_at ASC LIMIT ?"
	).all(userId, limit || 1000);
}

// --- Match replays --------------------------------------------------------------------------------
// Persist one finished ranked match. `meta` carries the summary columns; `blob` is the gzipped
// input-log (a Buffer). `participants` is the list of real (non-bot) user ids in the match, used to
// populate the side table so a user's replays are listable without touching the blob.
function saveReplay(meta, blob, participants) {
	try {
		var info = db.prepare(
			"INSERT INTO match_replays (created_at, style, mode, rows, cols, mine_count, game_count, winner_id, players, format, raw_bytes, data) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		).run(
			meta.createdAt || Date.now(), meta.style || null, meta.mode || null,
			meta.rows, meta.cols, meta.mineCount, meta.gameCount,
			meta.winnerId || null, meta.players ? JSON.stringify(meta.players) : null,
			meta.format || 1, meta.rawBytes || blob.length, blob
		);
		var id = info.lastInsertRowid;
		if (participants && participants.length) {
			var stmt = db.prepare("INSERT OR IGNORE INTO match_replay_players (replay_id, user_id) VALUES (?, ?)");
			for (var i = 0; i < participants.length; i++) stmt.run(id, participants[i]);
		}
		return id;
	} catch (e) { console.error("saveReplay failed", e); return null; }
}
// Replay metadata for a user (newest first), no blob — for a "your matches" list.
function listReplaysForUser(userId, limit) {
	return db.prepare(
		"SELECT r.id, r.created_at, r.style, r.mode, r.rows, r.cols, r.mine_count, r.game_count, r.winner_id, r.players " +
		"FROM match_replays r JOIN match_replay_players p ON p.replay_id = r.id " +
		"WHERE p.user_id = ? ORDER BY r.created_at DESC LIMIT ?"
	).all(userId, limit || 50);
}
// Full replay row incl. the gzipped blob, for playback.
function getReplay(id) {
	return db.prepare("SELECT * FROM match_replays WHERE id = ?").get(id);
}
// Stamp the just-saved replay id onto this match's history rows. Scoped by user + created_at >= the
// match's start so it touches only this match's rows (a user is in one match at a time, so their
// earlier matches all have created_at < sinceTs); `replay_id IS NULL` keeps it idempotent.
function linkReplayToMatches(replayId, userIds, sinceTs) {
	if (!replayId || !userIds || !userIds.length) return;
	try {
		var stmt = db.prepare("UPDATE match_history SET replay_id = ? WHERE user_id = ? AND replay_id IS NULL AND created_at >= ?");
		for (var i = 0; i < userIds.length; i++) stmt.run(replayId, userIds[i], sinceTs || 0);
	} catch (e) { console.error("linkReplayToMatches failed", e); }
}

// --- Achievement metrics --------------------------------------------------------------------------
// Steady state: a single PK read of player_stats (no scans). The first read for a user with no
// player_stats row yet runs a ONE-TIME backfill from existing history, then sets `backfilled`.
// computeStatsFromHistory produces the full column set (incl. the working state the incremental
// updates need) so post-backfill increments stay correct.
function computeStatsFromHistory(userId) {
	var c = {
		wins_sprint: 0, wins_standard: 0, wins_tournament: 0, wins_territory: 0,
		peak_sprint: 0, peak_standard: 0, peak_tournament: 0, peak_territory: 0,
		win_streak_current: 0, win_streak_best: 0,
		stat_day: null, day_wins: 0, best_day_wins: 0, day_gain: 0, best_day_gain: 0,
		best_swing: 0, wins_1v1: 0, wins_6p: 0,
		peak_puzzle_rating: 0, dailies_solved: 0, daily_streak_best: 0,
		last_active_day: null, distinct_days: 0
	};
	var rows = db.prepare("SELECT style, rating_before, rating_after, players, won, created_at FROM match_history WHERE user_id = ? ORDER BY created_at ASC").all(userId);
	var streak = 0, dayWins = {}, dayGain = {}, lastDay = null;
	rows.forEach(function(r) {
		var day = ISO_DAY(r.created_at); lastDay = day;
		if (r.won) {
			var wc = STAT_WIN_COL[r.style]; if (wc) c[wc]++;
			if (r.players === 2) c.wins_1v1++;
			if (r.players >= 5) c.wins_6p++;
			dayWins[day] = (dayWins[day] || 0) + 1;
			streak++; if (streak > c.win_streak_best) c.win_streak_best = streak;
		} else { streak = 0; }
		var pc = STAT_PEAK_COL[r.style]; if (pc && r.rating_after > c[pc]) c[pc] = r.rating_after;
		var swing = r.rating_after - r.rating_before;
		if (swing > c.best_swing) c.best_swing = swing;
		dayGain[day] = (dayGain[day] || 0) + swing;
	});
	c.win_streak_current = streak;
	Object.keys(dayWins).forEach(function(d) { if (dayWins[d] > c.best_day_wins) c.best_day_wins = dayWins[d]; });
	Object.keys(dayGain).forEach(function(d) { if (dayGain[d] > c.best_day_gain) c.best_day_gain = dayGain[d]; });
	if (lastDay) { c.stat_day = lastDay; c.day_wins = dayWins[lastDay] || 0; c.day_gain = dayGain[lastDay] || 0; }
	var pr = db.prepare("SELECT MAX(player_rating_after) AS m FROM puzzle_attempts WHERE user_id = ?").get(userId);
	c.peak_puzzle_rating = (pr && pr.m) || 0;
	var ds = db.prepare("SELECT COUNT(*) AS c FROM daily_attempts WHERE user_id = ? AND solved = 1").get(userId);
	c.dailies_solved = (ds && ds.c) || 0;
	var dailyDates = db.prepare("SELECT date FROM daily_attempts WHERE user_id = ? AND solved = 1 ORDER BY date ASC").all(userId).map(function(x) { return x.date; });
	c.daily_streak_best = longestDailyRun(dailyDates);
	var dayset = {};
	db.prepare("SELECT DISTINCT date(created_at/1000,'unixepoch') AS d FROM match_history WHERE user_id = ?").all(userId).forEach(function(x) { if (x.d) dayset[x.d] = 1; });
	db.prepare("SELECT DISTINCT date(created_at/1000,'unixepoch') AS d FROM puzzle_attempts WHERE user_id = ?").all(userId).forEach(function(x) { if (x.d) dayset[x.d] = 1; });
	db.prepare("SELECT DISTINCT date FROM daily_attempts WHERE user_id = ?").all(userId).forEach(function(x) { if (x.date) dayset[x.date] = 1; });
	var days = Object.keys(dayset).sort();
	c.distinct_days = days.length;
	c.last_active_day = days.length ? days[days.length - 1] : null;
	return c;
}
function backfillPlayerStats(userId) {
	var c = computeStatsFromHistory(userId);
	ensurePlayerStats(userId);
	db.prepare(
		"UPDATE player_stats SET wins_sprint=?, wins_standard=?, wins_tournament=?, wins_territory=?, " +
		"peak_sprint=?, peak_standard=?, peak_tournament=?, peak_territory=?, " +
		"win_streak_current=?, win_streak_best=?, stat_day=?, day_wins=?, best_day_wins=?, day_gain=?, best_day_gain=?, " +
		"best_swing=?, wins_1v1=?, wins_6p=?, peak_puzzle_rating=?, dailies_solved=?, daily_streak_best=?, " +
		"last_active_day=?, distinct_days=?, backfilled=1 WHERE user_id=?"
	).run(c.wins_sprint, c.wins_standard, c.wins_tournament, c.wins_territory,
		c.peak_sprint, c.peak_standard, c.peak_tournament, c.peak_territory,
		c.win_streak_current, c.win_streak_best, c.stat_day, c.day_wins, c.best_day_wins, c.day_gain, c.best_day_gain,
		c.best_swing, c.wins_1v1, c.wins_6p, c.peak_puzzle_rating, c.dailies_solved, c.daily_streak_best,
		c.last_active_day, c.distinct_days, userId);
}
function achievementStats(userId) {
	try {
		ensurePlayerStats(userId);
		var row = db.prepare("SELECT * FROM player_stats WHERE user_id = ?").get(userId);
		if (!row.backfilled) { backfillPlayerStats(userId); row = db.prepare("SELECT * FROM player_stats WHERE user_id = ?").get(userId); }
		var perMode = { sprint: row.wins_sprint, standard: row.wins_standard, tournament: row.wins_tournament, territory: row.wins_territory };
		var peak = { sprint: row.peak_sprint, standard: row.peak_standard, tournament: row.peak_tournament, territory: row.peak_territory };
		peak.overall = Math.max(peak.sprint, peak.standard, peak.tournament, peak.territory);
		return {
			perModeWins: perMode,
			maxModeWins: Math.max(perMode.sprint, perMode.standard, perMode.tournament, perMode.territory),
			peak: peak,
			winStreakBest: row.win_streak_best, bestDayWins: row.best_day_wins, bestDayGain: row.best_day_gain,
			bigSwing: row.best_swing, wins1v1: row.wins_1v1, wins6p: row.wins_6p,
			peakPuzzleRating: row.peak_puzzle_rating, dailiesSolved: row.dailies_solved,
			dailyStreakBest: row.daily_streak_best, distinctDays: row.distinct_days,
			noFlagClears: row.noflag_clears, noRevealClears: row.noreveal_clears
		};
	} catch (e) { console.error("achievementStats failed", e); return {}; }
}

// Map the CSP-driven score (max complexity + small total bonus) to a
// chess-style puzzle rating. Linear `240·(score − 0.5)`, clamped at 0,
// so the easiest possible puzzle (a single trivial cascade reveal,
// score ≈ 0.5) lands right at 0 and the deepest current puzzles
// (score ≈ 13) reach ~3000. Shared formula lives in BoardLogic.scoreToRating.
var scoreToRating = BoardLogic.scoreToRating;

function insertPuzzle(p) {
	var info = db.prepare(
		"INSERT OR IGNORE INTO puzzles " +
		"(canonical_key, rows, cols, mines, revealed, covered_safe, difficulty, score, rating, " +
		" max_enum_size, needs_case_split, csp_method, source, scoring_version, created_at, " +
		" max_complexity, total_complexity, gen_method, gen_iterations) " +
		"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	).run(
		p.key, p.rows, p.cols,
		JSON.stringify(p.mines), JSON.stringify(p.revealed),
		p.coveredSafe, p.difficulty, p.score, scoreToRating(p.score),
		p.maxEnumSize || 0,
		p.needsCaseSplit ? 1 : 0,
		p.cspMethod || "trivial",
		p.source || "random",
		CURRENT_SCORING_VERSION,
		Date.now(),
		typeof p.maxComplexity === "number" ? p.maxComplexity : null,
		typeof p.totalComplexity === "number" ? p.totalComplexity : null,
		p.genMethod || null,
		typeof p.genIterations === "number" ? p.genIterations : null
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
		maxEnumSize: row.max_enum_size,
		cspMethod: row.csp_method || "trivial",
		needsCaseSplit: !!row.needs_case_split,
		source: row.source || "random",
		attempts: row.attempts,
		solves: row.solves,
		maxComplexity: row.max_complexity,
		totalComplexity: row.total_complexity,
		genMethod: row.gen_method,
		genIterations: row.gen_iterations,
		createdAt: row.created_at
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
	// Filter on the CSP analyzer's hardest-op tag (`csp_method`): the single
	// most expensive deduction the solver needed to crack the puzzle.
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

// Marathon boards (source="marathon", scripts/generate-marathon-boards.js) live in this same table
// deliberately — the admin Marathon boards page and the puzzle_retry "Play" flow both work by
// treating them as ordinary puzzles.puzzles rows. But they're long, dense, "lots of medium moves"
// boards for the solo campaign, not curriculum material, so any query that RANDOMLY serves a puzzle
// for actual play (daily, rated ladder, streak, storm) must exclude them — only direct by-id lookups
// (getPuzzleById, used by puzzle_retry and the Analyze modal) are meant to reach a marathon row.
var CURRICULUM_ONLY_CLAUSE = "source != 'marathon'";

// Columns `listPuzzles`'s `opts.orderBy` is allowed to sort by (never interpolate the raw param into SQL).
var ORDER_BY_COLUMNS = ["rating", "max_complexity", "total_complexity", "created_at"];

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
	// Whitelisted sort column — defaults to the pool's usual `rating` metric; the marathon-boards
	// admin page sorts by the raw complexity floats instead (rating isn't meaningful for those).
	var orderCol = ORDER_BY_COLUMNS.indexOf(opts.orderBy) >= 0 ? opts.orderBy : "rating";
	var sql = "SELECT * FROM puzzles";
	if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
	sql += " ORDER BY " + orderCol + " " + sortDir + " LIMIT ? OFFSET ?";
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

// Size of the servable curriculum pool (excludes marathon boards) — what the background pool
// top-up job should compare against PUZZLE_POOL_TARGET, so a batch of marathon boards doesn't read
// as "the pool is full enough" and starve real curriculum generation.
function curriculumPuzzleCount() {
	return db.prepare("SELECT COUNT(*) AS n FROM puzzles WHERE " + CURRICULUM_ONLY_CLAUSE).get().n;
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

// Record a Free-play clear; updates the (user, size, density%) best only when it's faster.
// Returns { best, isNewBest } so the client can celebrate a new record.
function recordSoloBest(userId, size, densityPct, ms) {
	var row = db.prepare("SELECT best_ms FROM solo_records WHERE user_id = ? AND size = ? AND density = ?").get(userId, size, densityPct);
	var isNewBest = !row || ms < row.best_ms;
	if (isNewBest) {
		db.prepare("INSERT OR REPLACE INTO solo_records (user_id, size, density, best_ms, achieved_at) VALUES (?, ?, ?, ?, ?)")
			.run(userId, size, densityPct, ms, Date.now());
	}
	return { best: isNewBest ? ms : row.best_ms, isNewBest: isNewBest };
}

// All of a user's Free-play bests as a { "<size>_<density%>": ms } map (for the solo card + result panel).
function getSoloBests(userId) {
	var map = {};
	db.prepare("SELECT size, density, best_ms FROM solo_records WHERE user_id = ?").all(userId)
		.forEach(function(r) { map[r.size + "_" + r.density] = r.best_ms; });
	return map;
}

function getPuzzleById(id) {
	var row = db.prepare("SELECT * FROM puzzles WHERE id = ?").get(id);
	return row ? deserializePuzzle(row) : null;
}

// Remove a single puzzle by id. Used by generators (e.g. generate-marathon-boards.js) that replace
// their own in-progress row in place as a board improves — canonical_key changes every time the mine
// layout does, so a plain re-insert can't UPDATE it; delete-then-insert keeps one row per run instead
// of accumulating an intermediate row per accepted improvement.
function deletePuzzleById(id) {
	db.prepare("DELETE FROM puzzles WHERE id = ?").run(id);
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
	bumpPuzzleStats(userId, newRating); // keep peak puzzle rating + active day for achievements
}

// Add Puzzle Ladder points (never negative) and return the new total. Points only ever go up.
function addPuzzlePoints(userId, points) {
	points = Math.max(0, Math.round(points || 0));
	if (points > 0) db.prepare("UPDATE users SET puzzle_points = puzzle_points + ? WHERE id = ?").run(points, userId);
	var row = db.prepare("SELECT puzzle_points FROM users WHERE id = ?").get(userId);
	return row ? row.puzzle_points : 0;
}

// Admin/testing: wipe a user's puzzle progress back to a fresh account — rating to 0 (the new-player
// baseline), Ladder points to 0, no current puzzle, and clear the peak-rating achievement metric.
function resetPuzzleProgress(userId) {
	db.prepare("UPDATE users SET puzzle_rating = 0, puzzle_points = 0, current_puzzle_id = NULL WHERE id = ?").run(userId);
	try { db.prepare("UPDATE player_stats SET peak_puzzle_rating = 0 WHERE user_id = ?").run(userId); } catch (e) {}
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
	// (pass-based) solver and aren't accessible to casual players. Never serve a marathon board
	// either — see CURRICULUM_ONLY_CLAUSE.
	var row = db.prepare("SELECT * FROM puzzles WHERE needs_case_split = 0 AND " + CURRICULUM_ONLY_CLAUSE + " AND rating BETWEEN 1400 AND 1700 ORDER BY RANDOM() LIMIT 1").get();
	if (row) return deserializePuzzle(row);
	row = db.prepare("SELECT * FROM puzzles WHERE needs_case_split = 0 AND " + CURRICULUM_ONLY_CLAUSE + " AND rating BETWEEN 1100 AND 2000 ORDER BY RANDOM() LIMIT 1").get();
	if (row) return deserializePuzzle(row);
	row = db.prepare("SELECT * FROM puzzles WHERE needs_case_split = 0 AND " + CURRICULUM_ONLY_CLAUSE + " ORDER BY RANDOM() LIMIT 1").get();
	return row ? deserializePuzzle(row) : null;
}

function getDailyAttempt(userId, date) {
	return db.prepare("SELECT * FROM daily_attempts WHERE user_id = ? AND date = ?").get(userId, date) || null;
}

function recordDailyAttempt(userId, date, solved) {
	db.prepare(
		"INSERT OR REPLACE INTO daily_attempts (user_id, date, solved, attempted_at) VALUES (?, ?, ?, ?)"
	).run(userId, date, solved ? 1 : 0, Date.now());
	var streak = 0;
	if (solved) {
		var u = getUserById(userId);
		streak = (u && u.daily_last_solved === yesterdayOf(date)) ? (u.daily_streak || 0) + 1 : 1;
		db.prepare("UPDATE users SET daily_streak = ?, daily_last_solved = ? WHERE id = ?").run(streak, date, userId);
	}
	bumpDailyStats(userId, streak, !!solved); // active day + (on solve) dailies count & best streak
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
		var sql = "SELECT * FROM puzzles WHERE " + CURRICULUM_ONLY_CLAUSE + " AND rating BETWEEN ? AND ?" + excludeClause +
			" ORDER BY RANDOM() LIMIT 1";
		var p = [targetRating - w, targetRating + w].concat(params);
		var stmt = db.prepare(sql);
		var row = stmt.get.apply(stmt, p);
		if (row) return deserializePuzzle(row);
	}
	// Last resort: any puzzle they haven't recently played.
	if (excludeIds && excludeIds.length) {
		var sql2 = "SELECT * FROM puzzles WHERE " + CURRICULUM_ONLY_CLAUSE + excludeClause + " ORDER BY RANDOM() LIMIT 1";
		var stmt2 = db.prepare(sql2);
		var row2 = stmt2.get.apply(stmt2, params);
		if (row2) return deserializePuzzle(row2);
	}
	return null;
}

// Startup backfill: pick up rows that pre-date the current solver / scoring
// version and re-run the analyzer so difficulty, score, rating, and the CSP
// method classification all reflect the latest code.
function legacyPuzzleRows() {
	return db.prepare(
		"SELECT id, rows, cols, mines, revealed FROM puzzles " +
		"WHERE scoring_version < ?"
	).all(CURRENT_SCORING_VERSION);
}

function applyPuzzleClassification(id, analysis) {
	db.prepare(
		"UPDATE puzzles SET difficulty = ?, score = ?, rating = ?, " +
		"max_enum_size = ?, needs_case_split = ?, csp_method = ?, scoring_version = ? " +
		"WHERE id = ?"
	).run(
		analysis.difficulty,
		analysis.score,
		scoreToRating(analysis.score),
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
	displayNameOf: displayNameOf,
	recordSoloBest: recordSoloBest,
	getSoloBests: getSoloBests,
	pruneStaleGuests: pruneStaleGuests,
	createSession: createSession,
	getUserByToken: getUserByToken,
	getUserById: getUserById,
	setUserAdmin: setUserAdmin,
	applyAdminBootstrap: applyAdminBootstrap,
	updateRating: updateRating,
	setRating: setRating,
	deleteSession: deleteSession,
	topPlayers: topPlayers,
	setAvatarColor: setAvatarColor,
	setCountry: setCountry,
	recordMatch: recordMatch,
	markMatchPersisted: markMatchPersisted,
	recordClear: recordClear,
	getMatchHistory: getMatchHistory,
	getRatingHistory: getRatingHistory,
	saveReplay: saveReplay,
	listReplaysForUser: listReplaysForUser,
	getReplay: getReplay,
	linkReplayToMatches: linkReplayToMatches,
	achievementStats: achievementStats,
	// Puzzles
	scoreToRating: scoreToRating,
	insertPuzzle: insertPuzzle,
	listPuzzles: listPuzzles,
	puzzleCount: puzzleCount,
	curriculumPuzzleCount: curriculumPuzzleCount,
	puzzleSources: puzzleSources,
	clearPuzzlesBySource: clearPuzzlesBySource,
	puzzleStats: puzzleStats,
	clearPuzzles: clearPuzzles,
	getPuzzleById: getPuzzleById,
	deletePuzzleById: deletePuzzleById,
	updatePuzzleRating: updatePuzzleRating,
	updateUserPuzzleRating: updateUserPuzzleRating,
	addPuzzlePoints: addPuzzlePoints,
	resetPuzzleProgress: resetPuzzleProgress,
	setCurrentPuzzle: setCurrentPuzzle,
	eloUpdate: eloUpdate,
	recordAttempt: recordAttempt,
	recentlyAttemptedPuzzleIds: recentlyAttemptedPuzzleIds,
	pickPuzzleNearRating: pickPuzzleNearRating,
	getRunBest: getRunBest,
	setRunBest: setRunBest,
	todayUtc: todayUtc,
	getOrPickDailyPuzzle: getOrPickDailyPuzzle,
	pickDailyCandidate: pickDailyCandidate,
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
