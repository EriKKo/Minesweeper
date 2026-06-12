// Socket integration test for the admin bot-demo (now in botDemo.js): an admin (DEV_AUTH
// makes the guest one) starts a demo and gets a board frame then a move frame —
// exercising the board build + the bot tick through the injected isSocketAdmin/RANKED_RULES.

var test = require("node:test");
var assert = require("node:assert");
var io = require("socket.io-client");
var helpers = require("./helpers");

var server;
test.before(async function() { server = await helpers.startServer({ port: 13805 }); });
test.after(function() { if (server) server.stop(); });

function once(socket, event, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { reject(new Error("timeout waiting for '" + event + "'")); }, ms || 6000);
		socket.once(event, function(d) { clearTimeout(t); resolve(d); });
	});
}
function connect() { return io(server.base, { transports: ["websocket"], forceNew: true }); }

test("an admin can start a bot demo and receives board + move frames", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("guest_session");
		await once(c, "authenticated"); // DEV_AUTH=1 → this guest is treated as admin
		c.emit("bot_demo_start", { botIndex: 0, density: 0.10 });
		var board = await once(c, "bot_demo_board");
		assert.ok(board && board.rows > 0 && Array.isArray(board.board), "demo board frame");
		var move = await once(c, "bot_demo_move", 8000);
		assert.ok(move && move.state, "demo move frame (the bot ticked)");
	} finally { c.close(); }
});
