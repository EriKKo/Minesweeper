// Phase 1 P1-7 (deploy-critical): main routes a new match PAST a game server that's unavailable or
// draining (a deploy in progress) to a healthy one — so a fleet rollover never strands a match. A
// draining game server returns 503 from /internal/allocate; a down one rejects the connection; both
// take the same fall-through path, exercised here with a dead first server.

process.env.MATCH_TOKEN_SECRET = "failover-tok";
const { test } = require("node:test");
const assert = require("node:assert");
const io = require("socket.io-client");
const { startServer } = require("./helpers");

function once(socket, event, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout waiting for '" + event + "'")), ms || 10000);
		socket.once(event, d => { clearTimeout(t); resolve(d); });
	});
}

test("main falls through to a healthy game server when the first is unavailable", async () => {
	const SECRET = "failover-internal";
	const game = await startServer({ port: 13872, env: { ROLE: "game", INTERNAL_SECRET: SECRET, MATCH_TOKEN_SECRET: "failover-tok", MAIN_URL: "http://localhost:13873" } });
	// First server in the list is dead (nothing on :19999); the real game server is second.
	const main = await startServer({ port: 13873, env: { ROLE: "main", INTERNAL_SECRET: SECRET, MATCH_TOKEN_SECRET: "failover-tok", GAME_SERVERS: "http://localhost:19999," + game.base } });

	let lobby;
	try {
		lobby = io(main.base, { transports: ["websocket"], forceNew: true });
		await once(lobby, "connected");
		lobby.emit("guest_session");
		await once(lobby, "authenticated");
		lobby.emit("find_ranked", { mode: "sprint_duo" });
		const handoff = await once(lobby, "match_handoff", 15000);
		assert.strictEqual(handoff.gameUrl, game.base, "main skipped the dead server and used the healthy one");
		assert.ok(handoff.token, "and still issued a join token");
	} finally {
		if (lobby) lobby.close();
		game.stop();
		main.stop();
	}
});
