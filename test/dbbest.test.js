// Direct db.js unit coverage for the two "best score" additions that don't need a running server:
// marathon_best (per-user-per-puzzle stars/attempts, see recordMarathonAttempt) and
// dailyStreakBestForUser (a guarded read of player_stats.daily_streak_best, already maintained by
// bumpDailyStats/recordDailyAttempt — this only pins down that the read survives a subsequent miss
// without the stored best dropping). Mirrors test/puzzlesource.test.js's temp-DB pattern.

const { test, before } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let db;
before(() => {
	process.env.RANKED_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ms-dbbest-")));
	process.env.RANKED_DB = path.join(process.env.RANKED_DB, "test.db");
	db = require("../src/server/db");
});

test("recordMarathonAttempt: an unsolved attempt counts toward attempts but earns no star", () => {
	const u = db.createGuest();
	const r = db.recordMarathonAttempt(u.id, 1, false, 3);
	assert.deepStrictEqual(r, { bestStars: 0, isNewBest: false, attempts: 1 });
	assert.deepStrictEqual(db.getMarathonBest(u.id, 1), { bestStars: 0, attempts: 1 });
});

test("recordMarathonAttempt: a solve sets the best, and a strictly better solve raises it", () => {
	const u = db.createGuest();
	let r = db.recordMarathonAttempt(u.id, 2, true, 2); // 1 star
	assert.strictEqual(r.bestStars, 1);
	assert.strictEqual(r.isNewBest, true);
	assert.strictEqual(r.attempts, 1);

	r = db.recordMarathonAttempt(u.id, 2, true, 0); // flawless -> 3 stars, strictly better
	assert.strictEqual(r.bestStars, 3);
	assert.strictEqual(r.isNewBest, true);
	assert.strictEqual(r.attempts, 2);
});

test("recordMarathonAttempt: a worse or tied solve never regresses the stored best", () => {
	const u = db.createGuest();
	db.recordMarathonAttempt(u.id, 3, true, 0); // 3 stars

	let r = db.recordMarathonAttempt(u.id, 3, true, 2); // worse: 1 star
	assert.strictEqual(r.bestStars, 3, "stored best must stay at 3");
	assert.strictEqual(r.isNewBest, false);
	assert.strictEqual(r.attempts, 2);

	r = db.recordMarathonAttempt(u.id, 3, true, 0); // tied: 3 stars again, not a NEW best
	assert.strictEqual(r.bestStars, 3);
	assert.strictEqual(r.isNewBest, false);
	assert.strictEqual(r.attempts, 3);

	r = db.recordMarathonAttempt(u.id, 3, false, 3); // a later failure still just counts as an attempt
	assert.strictEqual(r.bestStars, 3);
	assert.strictEqual(r.isNewBest, false);
	assert.strictEqual(r.attempts, 4);

	assert.deepStrictEqual(db.getMarathonBest(u.id, 3), { bestStars: 3, attempts: 4 });
});

test("getMarathonBest / getMarathonBests: null for a puzzle never attempted, batch reads match single reads", () => {
	const u = db.createGuest();
	assert.strictEqual(db.getMarathonBest(u.id, 999), null);

	db.recordMarathonAttempt(u.id, 10, true, 1); // 2 stars
	db.recordMarathonAttempt(u.id, 11, true, 2); // 1 star
	const batch = db.getMarathonBests(u.id, [10, 11, 999]);
	assert.deepStrictEqual(batch[10], { bestStars: 2, attempts: 1 });
	assert.deepStrictEqual(batch[11], { bestStars: 1, attempts: 1 });
	assert.strictEqual(batch[999], undefined);
	assert.deepStrictEqual(db.getMarathonBests(u.id, []), {}, "empty id list short-circuits to an empty map");
});

test("getMarathonBests: never leaks another user's bests", () => {
	const a = db.createGuest();
	const b = db.createGuest();
	db.recordMarathonAttempt(a.id, 20, true, 0); // 3 stars
	const bBatch = db.getMarathonBests(b.id, [20]);
	assert.strictEqual(bBatch[20], undefined, "b never played puzzle 20");
});

test("dailyStreakBestForUser: reflects a solved streak and survives a later miss (best never drops)", () => {
	const u = db.createGuest();
	assert.strictEqual(db.dailyStreakBestForUser(u.id), 0, "fresh user has no daily history");

	// Two real UTC dates so recordDailyAttempt's yesterday-check chains the streak to 2.
	const day1 = "2026-01-01", day2 = "2026-01-02", day3 = "2026-01-03";
	db.recordDailyAttempt(u.id, day1, true);
	db.recordDailyAttempt(u.id, day2, true);
	assert.strictEqual(db.dailyStreakBestForUser(u.id), 2);

	// A miss the next day breaks the CURRENT streak but must not lower the recorded best.
	db.recordDailyAttempt(u.id, day3, false);
	assert.strictEqual(db.dailyStreakBestForUser(u.id), 2, "best streak must not regress on a miss");
});
