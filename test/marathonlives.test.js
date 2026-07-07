// Integration test for the marathon-board "3 lives" mechanic (src/server/runtime/puzzlePlay.js):
// a marathon-sourced puzzle survives up to 2 mine hits — each one emits a live puzzle_mine_hit with
// the remaining count instead of ending the run — and a clean solve afterward reports
// stars = 3 - livesLost. The 3rd hit (0 lives left) ends the run with solved:false, no more
// puzzle_mine_hit. A non-marathon puzzle keeps the original one-hit-and-done behavior for free,
// since it starts with 1 life instead of 3 (see game.mineHit in puzzlePlay.js).

var test = require("node:test");
var assert = require("node:assert");
var io = require("socket.io-client");
var path = require("node:path");
var os = require("node:os");
var helpers = require("./helpers");

// 4x4, 2 mines at opposite corners, the interior 2x2 pre-revealed — 10 covered safe cells outside
// the mines (mirrors test/puzzle.test.js's SEED shape).
var MARATHON_2MINE = {
	key: "test:marathon-2mine", rows: 4, cols: 4,
	mines: [[0, 0], [3, 3]],
	revealed: [[1, 1], [1, 2], [2, 1], [2, 2]],
	coveredSafe: 10, difficulty: 2, score: 1.0,
	maxEnumSize: 0, cspMethod: "trivial", needsCaseSplit: false, source: "marathon"
};
var SAFE_CELLS_4X4 = [[0, 1], [0, 2], [0, 3], [1, 0], [1, 3], [2, 0], [2, 3], [3, 0], [3, 1], [3, 2]];

// 5x5, 3 mines at three corners, a 3x3 center block pre-revealed — enough mines to reach the "out
// of lives" path.
var MARATHON_3MINE = {
	key: "test:marathon-3mine", rows: 5, cols: 5,
	mines: [[0, 0], [0, 4], [4, 0]],
	revealed: [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3]],
	coveredSafe: 13, difficulty: 2, score: 1.0,
	maxEnumSize: 0, cspMethod: "trivial", needsCaseSplit: false, source: "marathon"
};

var CURRICULUM_SEED = {
	key: "test:curriculum-lives", rows: 4, cols: 4,
	mines: [[0, 0], [3, 3]],
	revealed: [[1, 1], [1, 2], [2, 1], [2, 2]],
	coveredSafe: 10, difficulty: 2, score: 1.0,
	maxEnumSize: 0, cspMethod: "trivial", needsCaseSplit: false, source: "random"
};

var PORT = 13806;
var server;
var ids = {};

test.before(async function() {
	server = await helpers.startServer({ port: PORT, seedPuzzle: MARATHON_2MINE });
	// Seed the other two directly into the same (now-running) DB — a separate process writing
	// concurrently with the live server is exactly the scenario db.js's WAL + busy_timeout (added
	// alongside marathonGen.js) exists for.
	var dbPath = path.join(os.tmpdir(), "ms-test-" + process.pid + "-" + PORT + ".db");
	var script = "var db=require('./src/server/db');" +
		"db.insertPuzzle(" + JSON.stringify(MARATHON_3MINE) + ");" +
		"db.insertPuzzle(" + JSON.stringify(CURRICULUM_SEED) + ");";
	require("node:child_process").execFileSync("node", ["-e", script], {
		cwd: helpers.ROOT, env: Object.assign({}, process.env, { RANKED_DB: dbPath })
	});

	var listed = await helpers.getJson(server.base, "/api/puzzles?pageSize=50");
	var rows = listed.puzzles || [];
	[MARATHON_2MINE, MARATHON_3MINE, CURRICULUM_SEED].forEach(function(seed) {
		var row = rows.filter(function(p) { return p.key === seed.key; })[0];
		assert.ok(row, "seed " + seed.key + " should be listed");
		ids[seed.key] = row.id;
	});
});
test.after(function() { if (server) server.stop(); });

function once(socket, event, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { reject(new Error("timeout waiting for '" + event + "'")); }, ms || 5000);
		socket.once(event, function(d) { clearTimeout(t); resolve(d); });
	});
}
function connect() { return io(server.base, { transports: ["websocket"], forceNew: true }); }
async function startPuzzle(c, puzzleId) {
	await once(c, "connected");
	c.emit("guest_session");
	await once(c, "authenticated");
	c.emit("puzzle_retry", { puzzleId: puzzleId });
	return once(c, "puzzle_board", 6000);
}

test("marathon board: 2 mine hits still solves, reports 1 star", async function() {
	var c = connect();
	try {
		var board = await startPuzzle(c, ids[MARATHON_2MINE.key]);
		assert.strictEqual(board.marathon, true);

		c.emit("left_click", { r: 0, c: 0, id: "1" });
		assert.deepStrictEqual(await once(c, "puzzle_mine_hit", 3000), { livesLeft: 2, livesLost: 1 });

		c.emit("left_click", { r: 3, c: 3, id: "1" });
		assert.deepStrictEqual(await once(c, "puzzle_mine_hit", 3000), { livesLeft: 1, livesLost: 2 });

		SAFE_CELLS_4X4.forEach(function(rc) { c.emit("left_click", { r: rc[0], c: rc[1], id: "1" }); });
		var result = await once(c, "puzzle_result", 6000);
		assert.strictEqual(result.solved, true);
		assert.strictEqual(result.marathon, true);
		assert.strictEqual(result.livesLost, 2);
		assert.strictEqual(result.stars, 1);
	} finally { c.close(); }
});

test("marathon board: a flawless clear (0 hits) reports 3 stars", async function() {
	var c = connect();
	try {
		await startPuzzle(c, ids[MARATHON_2MINE.key]);
		SAFE_CELLS_4X4.forEach(function(rc) { c.emit("left_click", { r: rc[0], c: rc[1], id: "1" }); });
		var result = await once(c, "puzzle_result", 6000);
		assert.strictEqual(result.solved, true);
		assert.strictEqual(result.livesLost, 0);
		assert.strictEqual(result.stars, 3);
	} finally { c.close(); }
});

test("marathon board: the 3rd mine hit ends the run (no 3rd puzzle_mine_hit, straight to puzzle_result)", async function() {
	var c = connect();
	try {
		await startPuzzle(c, ids[MARATHON_3MINE.key]);
		var mineHits = 0;
		c.on("puzzle_mine_hit", function() { mineHits++; });

		c.emit("left_click", { r: 0, c: 0, id: "1" });
		c.emit("left_click", { r: 0, c: 4, id: "1" });
		c.emit("left_click", { r: 4, c: 0, id: "1" });
		var result = await once(c, "puzzle_result", 6000);
		assert.strictEqual(result.solved, false);
		assert.strictEqual(result.marathon, true);
		assert.strictEqual(result.livesLost, 3);
		assert.strictEqual(result.stars, null);
		assert.strictEqual(mineHits, 2, "only the first two hits are non-terminal");
	} finally { c.close(); }
});

test("non-marathon puzzle: first mine hit ends the run immediately (unchanged behavior)", async function() {
	var c = connect();
	try {
		var board = await startPuzzle(c, ids[CURRICULUM_SEED.key]);
		assert.strictEqual(board.marathon, false);
		var mineHitFired = false;
		c.on("puzzle_mine_hit", function() { mineHitFired = true; });

		c.emit("left_click", { r: 0, c: 0, id: "1" });
		var result = await once(c, "puzzle_result", 6000);
		assert.strictEqual(result.solved, false);
		assert.strictEqual(mineHitFired, false, "non-marathon puzzles never get a non-terminal mine hit");
	} finally { c.close(); }
});
