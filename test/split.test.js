// Phase 1 P1-5: the two-process round trip. A `game` server, handed a match over /internal/allocate,
// builds it from the spec, runs it to completion, and reports the result back to main — proving matches
// run in a separate process from the control plane (the foundation of no-downtime deploys). We use a
// bot-only match so no client connection is needed, and a tiny in-test HTTP server stands in for main
// to capture the report.

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { startServer } = require("./helpers");

const SECRET = "split-secret";

function botCfg() {
	return { speedMs: 15, difficultyMs: 3, distanceMult: 0, maxDifficulty: 8, mistakeRate: 0, chordRate: 0, rating: 1000 };
}

test("a game server runs an allocated match and reports the result to main", async () => {
	// Stand-in "main": capture any /internal/report the game server posts back.
	const reports = [];
	const capture = http.createServer((req, res) => {
		if (req.url === "/internal/report" && req.method === "POST") {
			let body = "";
			req.on("data", c => body += c);
			req.on("end", () => { try { reports.push(JSON.parse(body)); } catch (e) {} res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"applied":true}'); });
			return;
		}
		res.writeHead(404); res.end();
	});
	await new Promise(r => capture.listen(13841, r));
	const mainUrl = "http://localhost:13841";

	const game = await startServer({ port: 13842, env: { ROLE: "game", INTERNAL_SECRET: SECRET, MAIN_URL: mainUrl } });
	try {
		const spec = {
			matchId: "split:match:1", roomId: 90001, ownerPid: "system", size: 2,
			ranked: true, mode: "sprint_duo", style: "sprint", gameMode: "race", boardSize: "small",
			rules: { mineDensity: 0.1, roundSeconds: 120, deathPenalty: 0, gameCount: 1, modifier: null },
			humans: [],
			bots: [{ config: botCfg() }, { config: botCfg() }]
		};
		const alloc = await fetch(game.base + "/internal/allocate", {
			method: "POST",
			headers: { "content-type": "application/json", "x-internal-secret": SECRET },
			body: JSON.stringify(spec)
		});
		assert.strictEqual(alloc.status, 200, "allocate accepted");
		assert.strictEqual((await alloc.json()).matchId, "split:match:1");

		// Wait for the bot match to play out and the report to arrive.
		const deadline = Date.now() + 25000;
		while (reports.length === 0 && Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 250));
		}
		assert.strictEqual(reports.length >= 1, true, "the game server reported a result back to main");
		const rep = reports[0];
		assert.strictEqual(rep.matchId, "split:match:1");
		assert.strictEqual(rep.ranked, true);
		assert.ok(Array.isArray(rep.standings) && rep.standings.length === 2, "report carries the final standings");
		// The replay captured on the game process must travel over the wire too (it used to be dropped
		// at this exact hop — reportResultToMain built a slimmed wire object that never included it, so
		// every match run on a game server ended up with no watchable replay). The gzip blob arrives
		// base64-encoded since JSON has no binary type.
		assert.ok(rep.replayPayload, "the report carries a replay payload over the wire");
		assert.strictEqual(typeof rep.replayPayload.blob, "string", "the gzip blob is base64-encoded for JSON transport");
		assert.ok(rep.replayPayload.blob.length > 0, "the blob is non-empty");
		assert.ok(Array.isArray(rep.replayPayload.participants), "participants list travels alongside the blob");
		assert.strictEqual(rep.replayPayload.meta.mode, "sprint_duo");
	} finally {
		game.stop();
		await new Promise(r => capture.close(r));
	}
});
