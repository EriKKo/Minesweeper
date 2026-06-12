// Socket integration test for Territory (versus) mode: a guest creates a 2-player
// territory room, adds a bot, readies up, and the shared-board game starts
// (territory_start), then the periodic territory_board broadcast arrives. This is the
// net for pulling the territory socket wiring out of minesweeperServer into its own
// module — it exercises startTerritoryGame, the bot/world ticks, and broadcastTerritory.

var test = require("node:test");
var assert = require("node:assert");
var io = require("socket.io-client");
var helpers = require("./helpers");

var server;
test.before(async function() { server = await helpers.startServer({ port: 13802 }); });
test.after(function() { if (server) server.stop(); });

function once(socket, event, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { reject(new Error("timeout waiting for '" + event + "'")); }, ms || 5000);
		socket.once(event, function(d) { clearTimeout(t); resolve(d); });
	});
}
function connect() { return io(server.base, { transports: ["websocket"], forceNew: true }); }

test("a territory game starts and broadcasts its board", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("guest_session");
		await once(c, "authenticated");
		c.emit("create_room", { mode: "territory", players: 2 });
		await once(c, "joined_room");
		c.emit("add_bot");
		await once(c, "room_state");
		var startP = once(c, "territory_start", 10000);
		c.emit("player_ready");
		var start = await startP;
		assert.ok(start && start.rows > 0 && start.cols > 0, "territory_start carries board dims");
		assert.ok(Array.isArray(start.players) && start.players.length === 2, "two players");
		assert.ok(start.you, "identifies the receiving player");
		// After the countdown the world tick broadcasts the live board.
		var board = await once(c, "territory_board", 12000);
		assert.ok(board && board.owner && board.scores, "territory_board carries owner + scores");
	} finally { c.close(); }
});
