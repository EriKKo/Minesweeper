// Socket integration test for the core game plumbing: a guest connects, gets a
// session, creates a casual room, and starts a game. This exercises the shared
// server state the socket handlers operate on (rooms / sockets / names / accounts /
// roomMapping / games) — the safety net for gathering that state into appState and
// later splitting the socket handlers into modules.

var test = require("node:test");
var assert = require("node:assert");
var io = require("socket.io-client");
var helpers = require("./helpers");

var server;
test.before(async function() { server = await helpers.startServer({ port: 13801 }); });
test.after(function() { if (server) server.stop(); });

// Resolve with the next `event` payload, or reject after `ms`.
function once(socket, event, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { reject(new Error("timeout waiting for '" + event + "'")); }, ms || 5000);
		socket.once(event, function(d) { clearTimeout(t); resolve(d); });
	});
}

function connect() { return io(server.base, { transports: ["websocket"], forceNew: true }); }

test("a fresh socket gets a guest session on connect", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("guest_session");
		var auth = await once(c, "authenticated");
		assert.ok(auth, "authenticated payload");
		assert.match(auth.name, /^Guest/, "guest name");
		assert.ok(auth.token, "guest gets a session token");
	} finally { c.close(); }
});

test("an authenticated guest can create a casual room", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("guest_session");
		await once(c, "authenticated");
		c.emit("create_room", {});
		var joined = await once(c, "joined_room");
		assert.ok(joined && joined.roomId, "joined_room carries a roomId");
	} finally { c.close(); }
});

test("adding a bot and readying starts a game", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("guest_session");
		await once(c, "authenticated");
		c.emit("create_room", {});
		await once(c, "joined_room");
		// A room needs >1 player to start; add a (auto-ready) bot, then ready up.
		c.emit("add_bot");
		await once(c, "room_state");
		var started = once(c, "start_game", 10000); // listen before triggering the start
		c.emit("player_ready");
		var payload = await started;
		assert.ok(payload, "start_game payload arrived (game state created)");

		// The bot should actually play: within a few seconds a draw_board carries a
		// bot game (id "bot:…") with revealed cells — exercising the bot tick + move path.
		var botProgressed = await new Promise(function(resolve) {
			var done = false;
			var timer = setTimeout(function() { if (!done) { done = true; resolve(false); } }, 8000);
			c.on("draw_board", function(d) {
				var gs = (d && d.games) || [];
				for (var i = 0; i < gs.length; i++) {
					if (/^bot:/.test(gs[i].id) && gs[i].safeCount > 0) {
						if (!done) { done = true; clearTimeout(timer); resolve(true); }
						return;
					}
				}
			});
		});
		assert.ok(botProgressed, "a bot revealed cells (bot tick + move ran)");
	} finally { c.close(); }
});
