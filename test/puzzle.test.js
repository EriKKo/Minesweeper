// Socket integration test for single-player puzzle play (now in puzzlePlay.js): an
// authenticated guest requests a puzzle and is served a board (puzzle_next ->
// startPuzzlePlay -> obfuscateBoard -> puzzle_board), and the unauthenticated +
// empty-pool paths reject cleanly. The net for extracting puzzle play out of the server.

var test = require("node:test");
var assert = require("node:assert");
var io = require("socket.io-client");
var helpers = require("./helpers");

// A minimal valid puzzle row so puzzle_next has something to serve.
var SEED = {
	key: "test:4x4-seed", rows: 4, cols: 4,
	mines: [[0, 0], [3, 3]],
	revealed: [[1, 1], [1, 2], [2, 1], [2, 2]],
	coveredSafe: 10, difficulty: 2, score: 1.0,
	maxEnumSize: 0, cspMethod: "trivial", needsCaseSplit: false, source: "test"
};

var server;
test.before(async function() { server = await helpers.startServer({ port: 13804, seedPuzzle: SEED }); });
test.after(function() { if (server) server.stop(); });

function once(socket, event, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { reject(new Error("timeout waiting for '" + event + "'")); }, ms || 5000);
		socket.once(event, function(d) { clearTimeout(t); resolve(d); });
	});
}
function connect() { return io(server.base, { transports: ["websocket"], forceNew: true }); }

test("an authenticated player is served a puzzle board", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("guest_session");
		await once(c, "authenticated");
		c.emit("puzzle_next");
		var board = await once(c, "puzzle_board", 6000);
		assert.ok(board, "puzzle_board arrived (startPuzzlePlay + obfuscateBoard ran)");
		assert.strictEqual(board.rows, 4);
		assert.strictEqual(board.cols, 4);
		assert.ok(board.boardData && board.boardMask, "carries the obfuscated board blob");
		assert.ok(Array.isArray(board.knownCells), "carries the seed cascade");
	} finally { c.close(); }
});

test("puzzle_next without auth is rejected", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("puzzle_next"); // no guest_session → no account
		var err = await once(c, "puzzle_error", 6000);
		assert.strictEqual(err.reason, "auth_required");
	} finally { c.close(); }
});
