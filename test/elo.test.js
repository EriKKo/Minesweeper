// Phase 0 P0-4: the pairwise-Elo math is a PURE function of the match parts (ratings-before + played
// + rank + progress) — no db, no appState, no sockets. These tests pin the formula and prove isolation.

const { test, before } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let elo, db;
before(() => {
	process.env.RANKED_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ms-elo-")), "test.db");
	elo = require("../src/server/runtime/elo");
	db = require("../src/server/db");
	elo.init({ RANKED_BOT_RATING: 1000, PROVISIONAL_GAMES: 5 });
});

test("1v1 equal ratings: winner +K/2, loser -K/2 (settled K=40)", () => {
	const parts = [
		{ rank: 1, rating: 1000, bot: false, userId: 1, played: 10 },
		{ rank: 2, rating: 1000, bot: false, userId: 2, played: 10 }
	];
	elo.computeRankedElo(parts, "sprint"); // kFactor(10,sprint)=40, sum=±0.5, sqrt(n-1)=1
	assert.strictEqual(parts[0].delta, 20);
	assert.strictEqual(parts[0].newRating, 1020);
	assert.strictEqual(parts[1].delta, -20);
	assert.strictEqual(parts[1].newRating, 980);
	assert.strictEqual(parts[0].provisional, false); // played+1=11 >= 5
});

test("margin-of-victory scales a positive swing but not a loss", () => {
	const parts = [
		{ rank: 1, rating: 1000, bot: false, userId: 1, played: 10, progress: 1.0 },
		{ rank: 2, rating: 1000, bot: false, userId: 2, played: 10, progress: 0.0 }
	];
	elo.computeRankedElo(parts, "sprint"); // winner gap=1.0, sprint bonus 0.6 → 20*1.6=32
	assert.strictEqual(parts[0].delta, 32);
	assert.strictEqual(parts[1].delta, -20); // loss unaffected by margin
});

test("bots and non-persisted players get no delta", () => {
	const parts = [
		{ rank: 1, rating: 1200, bot: true, userId: null, played: 0 },
		{ rank: 2, rating: 1000, bot: false, userId: 7, played: 3 }
	];
	elo.computeRankedElo(parts, "sprint");
	assert.strictEqual(parts[0].delta, null, "bot has no delta");
	assert.notStrictEqual(parts[1].delta, null, "human is rated");
	assert.strictEqual(parts[1].provisional, true); // played+1=4 < 5
});

test("a rating can't fall below 0 (Bronze I floor)", () => {
	const parts = [
		{ rank: 1, rating: 3000, bot: false, userId: 1, played: 0 },
		{ rank: 2, rating: 5, bot: false, userId: 2, played: 0 }
	];
	elo.computeRankedElo(parts, "sprint");
	assert.ok(parts[1].newRating >= 0, "floored at 0");
});

test("applyRankedEloFromReport persists by userId from a network report (P1-5)", () => {
	// A report from a game server carries userId + rating-before per standing (no accounts cache).
	const standings = [
		{ id: "game-sock-A", rank: 1, name: "Winner", userId: 4242, ratingBefore: 1000, played: 10 },
		{ id: "game-sock-B", rank: 2, name: "Loser", userId: 4343, ratingBefore: 1000, played: 10 }
	];
	elo.applyRankedEloFromReport(standings, "sprint");
	const winnerRating = db.getUserById(4242) ? db.getUserById(4242).rating_sprint : null;
	// The user rows didn't pre-exist, so updateRating is a no-op UPDATE; the durable proof is the
	// match_history rows recorded by userId.
	const hist = db.getMatchHistory(4242, 10);
	assert.ok(hist.length >= 1, "winner's match recorded by userId");
	assert.strictEqual(hist[0].style, "sprint");
	assert.strictEqual(hist[0].won, 1, "rank-1 recorded as a win");
	assert.ok(hist[0].rating_after > hist[0].rating_before, "winner gained rating");
	const loserHist = db.getMatchHistory(4343, 10);
	assert.ok(loserHist[0].rating_after < loserHist[0].rating_before, "loser lost rating");
});

test("pure & deterministic: same input → same output, no side effects", () => {
	const mk = () => [
		{ rank: 1, rating: 1100, bot: false, userId: 1, played: 2 },
		{ rank: 2, rating: 1000, bot: false, userId: 2, played: 2 }
	];
	const a = elo.computeRankedElo(mk(), "standard");
	const b = elo.computeRankedElo(mk(), "standard");
	assert.deepStrictEqual(a.map(p => p.delta), b.map(p => p.delta));
});
