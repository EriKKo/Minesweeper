// Phase 1 P1-5/P1-6 (server side): a human plays a match ON A GAME SERVER. The client connects with a
// join token, is bound to its reserved seat by playerKey, the series starts, and the result is reported
// back to main — the human-match analogue of split.test.js. Proves a real player can run a match in a
// process separate from the control plane (the whole point of no-downtime deploys).

process.env.MATCH_TOKEN_SECRET = "humanattach-tok"; // must be set before requiring matchToken
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const io = require("socket.io-client");
const { startServer } = require("./helpers");
const matchToken = require("../src/server/runtime/matchToken");

function once(socket, event, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout waiting for '" + event + "'")), ms || 8000);
		socket.once(event, d => { clearTimeout(t); resolve(d); });
	});
}
function botCfg() { return { speedMs: 15, difficultyMs: 3, distanceMult: 0, maxDifficulty: 8, mistakeRate: 0, chordRate: 0, rating: 1000 }; }

test("a human attaches to a game server with a token and plays a reported match", async () => {
	const reports = [];
	const capture = http.createServer((req, res) => {
		if (req.url === "/internal/report" && req.method === "POST") {
			let b = ""; req.on("data", c => b += c);
			req.on("end", () => { try { reports.push(JSON.parse(b)); } catch (e) {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"applied":true}'); });
			return;
		}
		res.writeHead(404); res.end();
	});
	await new Promise(r => capture.listen(13851, r));

	const game = await startServer({ port: 13852, env: {
		ROLE: "game", INTERNAL_SECRET: "s", MAIN_URL: "http://localhost:13851", MATCH_TOKEN_SECRET: "humanattach-tok"
	} });

	let client;
	try {
		const spec = {
			matchId: "hm:1", roomId: 90100, ownerPid: "system", size: 2,
			ranked: true, mode: "sprint_duo", style: "sprint", gameMode: "race", boardSize: "small",
			rules: { mineDensity: 0.1, roundSeconds: 120, deathPenalty: 0, gameCount: 1, modifier: null },
			humanRoster: [{ playerKey: "u:5", name: "Tester", avatar: null, country: null, skin: null, userId: 5, rating: 1000, played: 10 }],
			bots: [{ config: botCfg() }]
		};
		const alloc = await fetch(game.base + "/internal/allocate", {
			method: "POST", headers: { "content-type": "application/json", "x-internal-secret": "s" }, body: JSON.stringify(spec)
		});
		assert.strictEqual(alloc.status, 200, "allocate accepted");

		// The human connects directly to the game server with its join token.
		const token = matchToken.issueMatchToken({ matchId: "hm:1", playerKey: "u:5", userId: 5 });
		client = io(game.base, { transports: ["websocket"], forceNew: true, auth: { token } });

		const joined = await once(client, "joined_room", 8000);
		assert.strictEqual(joined.roomId, 90100, "client attached to its match");
		// The series starts once the human is present — the client should start receiving board frames.
		await once(client, "draw_board", 10000);

		// The bot clears its board and wins; the match ends and reports back to main.
		const deadline = Date.now() + 25000;
		while (reports.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
		assert.ok(reports.length >= 1, "match reported back to main");
		const rep = reports[0];
		assert.strictEqual(rep.matchId, "hm:1");
		assert.ok(Array.isArray(rep.standings) && rep.standings.length === 2, "report carries both players");
	} finally {
		if (client) client.close();
		game.stop();
		await new Promise(r => capture.close(r));
	}
});

test("a connection with no/invalid token is rejected by the game server", async () => {
	const game = await startServer({ port: 13853, env: { ROLE: "game", INTERNAL_SECRET: "s", MATCH_TOKEN_SECRET: "humanattach-tok" } });
	let client;
	try {
		client = io(game.base, { transports: ["websocket"], forceNew: true, auth: { token: "garbage" } });
		await assert.rejects(once(client, "joined_room", 1500), "no seat without a valid token");
	} finally { if (client) client.close(); game.stop(); }
});
