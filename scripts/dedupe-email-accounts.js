// One-off maintenance: collapse duplicate accounts that share an email down to one.
//
// Pre-dating email-based account linking, the same person could end up with two `users` rows for
// one email (e.g. signed in with Google once and another provider another time). This keeps the
// strongest account (highest overall rating, then most games played, then oldest) and removes the
// rest — re-pointing their login identities to the keeper so every provider you used still signs
// you into the surviving account.
//
// SAFE BY DEFAULT: prints what it WOULD do and changes nothing. Pass --apply to actually delete.
//
//   node scripts/dedupe-email-accounts.js erik.odenman@gmail.com           # dry run
//   node scripts/dedupe-email-accounts.js erik.odenman@gmail.com --apply   # do it
//
// Uses RANKED_DB if set (prod = /data/ranked.db), else the project-root ranked.db.

var sqlite = require("node:sqlite");
var path = require("path");

var email = (process.argv[2] || "").toLowerCase().trim();
var apply = process.argv.indexOf("--apply") !== -1;
if (!email) {
	console.error("usage: node scripts/dedupe-email-accounts.js <email> [--apply]");
	process.exit(1);
}

var DB_PATH = process.env.RANKED_DB || path.join(__dirname, "..", "ranked.db");
var db = new sqlite.DatabaseSync(DB_PATH);
console.log("DB:", DB_PATH);
console.log("email:", email, apply ? "(APPLY)" : "(dry run — nothing will change)");

function hasTable(name) {
	return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

var rows = db.prepare(
	"SELECT id, provider, provider_id, name, is_admin, played, wins, " +
	"MAX(rating_sprint, rating_standard, rating_tournament, rating_territory) AS overall, created_at " +
	"FROM users WHERE LOWER(email) = ? AND is_guest = 0 " +
	"ORDER BY overall DESC, played DESC, id ASC"
).all(email);

console.log("\nFound " + rows.length + " account(s):");
rows.forEach(function(u, i) {
	console.log("  " + (i === 0 ? "KEEP  " : "REMOVE") + " #" + u.id +
		"  overall=" + u.overall + "  played=" + u.played + "  wins=" + u.wins +
		"  provider=" + u.provider + ":" + u.provider_id + "  name=" + u.name + (u.is_admin ? "  [admin]" : ""));
});

if (rows.length < 2) { console.log("\nNothing to do — need at least two accounts to dedupe."); process.exit(0); }

var keeper = rows[0];
var losers = rows.slice(1);
console.log("\nWill keep #" + keeper.id + " and remove " + losers.map(function(l) { return "#" + l.id; }).join(", ") + ".");

if (!apply) { console.log("\nDry run only. Re-run with --apply to perform the removal."); process.exit(0); }

var identities = hasTable("user_identities");
db.exec("BEGIN");
try {
	losers.forEach(function(l) {
		if (identities) {
			// Keep the deleted account's login methods working by moving them to the keeper
			// (drop any that collide with one the keeper already has), then clear the rest.
			db.prepare("UPDATE OR IGNORE user_identities SET user_id = ? WHERE user_id = ?").run(keeper.id, l.id);
			db.prepare("DELETE FROM user_identities WHERE user_id = ?").run(l.id);
		}
		db.prepare("DELETE FROM sessions WHERE user_id = ?").run(l.id);
		if (hasTable("puzzle_attempts")) db.prepare("DELETE FROM puzzle_attempts WHERE user_id = ?").run(l.id);
		if (hasTable("daily_attempts")) db.prepare("DELETE FROM daily_attempts WHERE user_id = ?").run(l.id);
		db.prepare("DELETE FROM users WHERE id = ?").run(l.id);
		console.log("  removed #" + l.id);
	});
	db.exec("COMMIT");
	console.log("\nDone. #" + keeper.id + " is now the sole account for " + email + ".");
} catch (e) {
	db.exec("ROLLBACK");
	console.error("\nRolled back — no changes made:", e.message);
	process.exit(1);
}
