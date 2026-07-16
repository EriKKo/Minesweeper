// Coverage for the move-history reconciliation protocol (MoveHash, src/common; GameCreator.js's
// seq/hash tracking; the move_sync/move_resync_needed/resync_moves socket handlers in
// minesweeperServer.js). This is the safety net for a left_click/right_click dropped in transit —
// without it, a player who genuinely cleared their board locally could have the server silently
// fall one move behind and time the round out as a loss.
//
// Each test plays the role of BOTH sides: it drives a real socket connection through a real room
// (so the SERVER side — GameCreator's seq/hash tracking, hasSeqGap, checkMoveSync — is exercised
// for real), while locally mirroring what Main.js's recordLocalMove/attachMoveSync would do using
// the same shared MoveHash module the real client uses, so "what the client would have sent" can
// never silently drift from what this test computes.
//
// A "dropped in transit" move is simulated by tracking it locally (as if performAction had applied
// it and called recordLocalMove) but never actually emitting it — precisely what a real client's
// state looks like right after a packet genuinely vanishes, or a server-side handler exception
// silently swallowed its effect (every socket handler is wrapped in try/catch — see
// minesweeperServer.js's connection handler).

var test = require("node:test");
var assert = require("node:assert");
var io = require("socket.io-client");
var helpers = require("./helpers");
var MoveHash = require("../src/common/MoveHash");

var server;
test.before(async function() { server = await helpers.startServer({ port: 13890 }); });
test.after(function() { if (server) server.stop(); });

function once(socket, event, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { reject(new Error("timeout waiting for '" + event + "'")); }, ms || 5000);
		socket.once(event, function(d) { clearTimeout(t); resolve(d); });
	});
}
function connect() { return io(server.base, { transports: ["websocket"], forceNew: true }); }

function decodeBoard(dataB64, maskB64, rows, cols) {
	var data = Buffer.from(dataB64, "base64");
	var mask = Buffer.from(maskB64, "base64");
	var board = [];
	for (var r = 0; r < rows; r++) {
		var row = [];
		for (var c = 0; c < cols; c++) {
			var v = data[r * cols + c] ^ mask[(r * cols + c) % mask.length];
			row.push(v === 9 ? -1 : v);
		}
		board.push(row);
	}
	return board;
}

// Sets up a fresh 1-human + 1-bot casual room and plays it up to the point the round is live.
async function enterLiveRound() {
	var c = connect();
	await once(c, "connected");
	c.emit("guest_session");
	await once(c, "authenticated");
	c.emit("create_room", { players: 2, boardSize: "small" });
	await once(c, "joined_room");
	c.emit("add_bot");
	await once(c, "room_state");
	var startedP = once(c, "start_game", 10000);
	c.emit("player_ready");
	var start = await startedP;
	var board = decodeBoard(start.boardData, start.boardMask, start.rows, start.cols);
	await new Promise(function(r) { setTimeout(r, (start.startDelayMs || 0) + 300); }); // past the round-start delay
	return { c: c, board: board, rows: start.rows, cols: start.cols };
}

function findSafeCells(board, rows, cols, count) {
	var out = [];
	for (var r = 0; r < rows && out.length < count; r++) {
		for (var cc = 0; cc < cols && out.length < count; cc++) {
			if (board[r][cc] !== -1) out.push({ r: r, c: cc });
		}
	}
	return out;
}

// Waits for a draw_board whose slot-0 state satisfies `pred(state)`, or times out. Own-slot state
// is games[0] for this test's socket (it's the only human, seated first).
function waitForOwnState(c, pred, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { c.off("draw_board", onFrame); reject(new Error("timeout waiting for own board state")); }, ms || 5000);
		function onFrame(d) {
			var me = d && d.games && d.games[0];
			if (me && pred(me.state)) { clearTimeout(t); c.off("draw_board", onFrame); resolve(me.state); }
		}
		c.on("draw_board", onFrame);
	});
}

var KNOWN = -4, FLAGGED = -2;

test("a left_click dropped in transit is detected via the next move's piggybacked seq/hash and healed", async function() {
	var ctx = await enterLiveRound();
	var c = ctx.c;
	try {
		var cells = findSafeCells(ctx.board, ctx.rows, ctx.cols, 2);
		assert.strictEqual(cells.length, 2, "board has at least two safe cells to click");
		var cellA = cells[0], cellB = cells[1];

		// Mirrors Main.js's recordLocalMove/attachMoveSync using the real shared MoveHash module.
		var seq = 0, hash = MoveHash.SEED, log = [];
		function trackAndMaybeEmit(cell, emit) {
			seq++;
			hash = MoveHash.next(hash, cell.r, cell.c, false);
			log.push({ seq: seq, r: cell.r, c: cell.c, flag: false });
			if (emit) c.emit("left_click", { r: cell.r, c: cell.c, id: c.id, seq: seq, hash: hash });
		}

		trackAndMaybeEmit(cellA, false); // "sent" but dropped — never actually emitted
		var resyncNeededP = once(c, "move_resync_needed", 3000);
		trackAndMaybeEmit(cellB, true); // a real, delivered click, seq now ahead of what the server has

		// The server must NOT silently apply cellB on top of its (cellA-missing) board — it should
		// hold it and ask for the gap instead (see hasSeqGap, minesweeperServer.js).
		var resyncNeeded = await resyncNeededP;
		assert.strictEqual(resyncNeeded.fromSeq, 0, "server reports itself still at seq 0 (cellB was held, not applied out of order)");

		// Client's reply: resend every move after the server's own seq (0) — cellA AND cellB, in order.
		var missing = log.filter(function(m) { return m.seq > resyncNeeded.fromSeq; });
		assert.strictEqual(missing.length, 2, "both moves need replaying — the dropped one and the one that was held");
		c.emit("resync_moves", {
			id: c.id, seq: seq, hash: hash,
			moves: missing.map(function(m) { return { r: m.r, c: m.c, flag: m.flag }; })
		});

		var healed = await waitForOwnState(c, function(s) { return s[cellA.r][cellA.c] === KNOWN && s[cellB.r][cellB.c] === KNOWN; }, 3000);
		assert.strictEqual(healed[cellA.r][cellA.c], KNOWN, "the dropped move (cellA) is healed");
		assert.strictEqual(healed[cellB.r][cellB.c], KNOWN, "the move that arrived while a gap existed (cellB) is also applied, in order");
	} finally { c.close(); }
});

test("a dropped move with no further clicks is still caught by the move_sync heartbeat", async function() {
	var ctx = await enterLiveRound();
	var c = ctx.c;
	try {
		var cells = findSafeCells(ctx.board, ctx.rows, ctx.cols, 2);
		assert.strictEqual(cells.length, 2, "board has at least two safe cells");
		var cellA = cells[0], cellB = cells[1];

		var seq = 0, hash = MoveHash.SEED, log = [];
		function trackAndMaybeEmit(cell, emit) {
			seq++;
			hash = MoveHash.next(hash, cell.r, cell.c, false);
			log.push({ seq: seq, r: cell.r, c: cell.c, flag: false });
			if (emit) c.emit("left_click", { r: cell.r, c: cell.c, id: c.id, seq: seq, hash: hash });
		}

		trackAndMaybeEmit(cellA, true); // delivered normally — server is now at seq 1
		trackAndMaybeEmit(cellB, false); // dropped — never emitted, no further click follows it

		// Simulates Main.js's 1s setInterval heartbeat: just the client's current (seq, hash), no move.
		var resyncNeededP = once(c, "move_resync_needed", 3000);
		c.emit("move_sync", { id: c.id, seq: seq, hash: hash });
		var resyncNeeded = await resyncNeededP;
		assert.strictEqual(resyncNeeded.fromSeq, 1, "server is missing exactly the one move after its real seq 1");

		var missing = log.filter(function(m) { return m.seq > resyncNeeded.fromSeq; });
		assert.strictEqual(missing.length, 1);
		c.emit("resync_moves", {
			id: c.id, seq: seq, hash: hash,
			moves: missing.map(function(m) { return { r: m.r, c: m.c, flag: m.flag }; })
		});

		var healed = await waitForOwnState(c, function(s) { return s[cellB.r][cellB.c] === KNOWN; }, 3000);
		assert.strictEqual(healed[cellB.r][cellB.c], KNOWN, "the dropped move is healed purely via the heartbeat, with no further click ever following it");
	} finally { c.close(); }
});

test("a dropped flag (right_click) is tracked and healed the same way", async function() {
	var ctx = await enterLiveRound();
	var c = ctx.c;
	try {
		var cells = findSafeCells(ctx.board, ctx.rows, ctx.cols, 2);
		var flagCell = cells[0], nextCell = cells[1];

		var seq = 0, hash = MoveHash.SEED, log = [];
		function trackFlag(cell, emit) {
			seq++;
			hash = MoveHash.next(hash, cell.r, cell.c, true);
			log.push({ seq: seq, r: cell.r, c: cell.c, flag: true });
			if (emit) c.emit("right_click", { r: cell.r, c: cell.c, id: c.id, seq: seq, hash: hash });
		}
		function trackReveal(cell, emit) {
			seq++;
			hash = MoveHash.next(hash, cell.r, cell.c, false);
			log.push({ seq: seq, r: cell.r, c: cell.c, flag: false });
			if (emit) c.emit("left_click", { r: cell.r, c: cell.c, id: c.id, seq: seq, hash: hash });
		}

		trackFlag(flagCell, false); // the flag itself is dropped
		var resyncNeededP = once(c, "move_resync_needed", 3000);
		trackReveal(nextCell, true); // a real, delivered reveal elsewhere — triggers gap detection

		var resyncNeeded = await resyncNeededP;
		var missing = log.filter(function(m) { return m.seq > resyncNeeded.fromSeq; });
		c.emit("resync_moves", {
			id: c.id, seq: seq, hash: hash,
			moves: missing.map(function(m) { return { r: m.r, c: m.c, flag: m.flag }; })
		});

		var healed = await waitForOwnState(c, function(s) { return s[flagCell.r][flagCell.c] === FLAGGED; }, 3000);
		assert.strictEqual(healed[flagCell.r][flagCell.c], FLAGGED, "the dropped flag is healed");
	} finally { c.close(); }
});

test("normal play with zero packet loss never triggers a resync", async function() {
	var ctx = await enterLiveRound();
	var c = ctx.c;
	try {
		var cells = findSafeCells(ctx.board, ctx.rows, ctx.cols, 4);
		var seq = 0, hash = MoveHash.SEED;
		var sawResyncRequest = false;
		c.on("move_resync_needed", function() { sawResyncRequest = true; });

		for (var i = 0; i < cells.length; i++) {
			seq++;
			hash = MoveHash.next(hash, cells[i].r, cells[i].c, false);
			c.emit("left_click", { r: cells[i].r, c: cells[i].c, id: c.id, seq: seq, hash: hash });
			await new Promise(function(r) { setTimeout(r, 150); });
		}
		await new Promise(function(r) { setTimeout(r, 300); });
		assert.strictEqual(sawResyncRequest, false, "fully-delivered moves never trigger a resync request");
	} finally { c.close(); }
});
