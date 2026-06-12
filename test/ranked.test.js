// Socket integration test for ranked matchmaking: a guest queues for ranked, sees the
// searching broadcast, and gets matched into a room (filled by a bot) — exercising
// enqueueRanked, the bot-arrival scheduler, and formRankedMatch. The net for pulling
// the ranked queue/matchmaking out of minesweeperServer into its own module.

var test = require("node:test");
var assert = require("node:assert");
var io = require("socket.io-client");
var helpers = require("./helpers");

var server;
test.before(async function() { server = await helpers.startServer({ port: 13803 }); });
test.after(function() { if (server) server.stop(); });

function once(socket, event, ms) {
	return new Promise(function(resolve, reject) {
		var t = setTimeout(function() { reject(new Error("timeout waiting for '" + event + "'")); }, ms || 5000);
		socket.once(event, function(d) { clearTimeout(t); resolve(d); });
	});
}
function connect() { return io(server.base, { transports: ["websocket"], forceNew: true }); }

test("queueing for ranked broadcasts a search then forms a match", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		c.emit("guest_session");
		await once(c, "authenticated");
		c.emit("find_ranked", { mode: "sprint_duo" });
		var searching = await once(c, "ranked_searching", 6000);
		assert.ok(searching, "ranked_searching broadcast");
		// A bot trickles into the 2-seat queue, then the match forms.
		var joined = await once(c, "joined_room", 12000);
		assert.ok(joined && joined.roomId, "joined a room");
		assert.strictEqual(joined.ranked, true, "it's a ranked room");
		assert.strictEqual(joined.mode, "sprint_duo");
	} finally { c.close(); }
});

test("an unauthenticated socket is rejected from ranked", async function() {
	var c = connect();
	try {
		await once(c, "connected");
		// No guest_session → no account → ranked should reject.
		c.emit("find_ranked", { mode: "sprint_duo" });
		var rej = await once(c, "ranked_rejected", 6000);
		assert.ok(rej && rej.reason, "rejected with a reason");
	} finally { c.close(); }
});
