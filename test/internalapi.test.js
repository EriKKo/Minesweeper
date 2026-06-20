// Phase 1 P1-5: the main↔game internal API. Reports posted from a game server to main are persisted
// idempotently; the endpoint is secret-guarded and only exists in split roles.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { startServer } = require("./helpers");

const SECRET = "test-internal-secret";
let server;
before(async () => {
	server = await startServer({ port: 13830, env: { ROLE: "main", INTERNAL_SECRET: SECRET } });
});
after(() => { if (server) server.stop(); });

function postReport(body, secret) {
	return fetch(server.base + "/internal/report", {
		method: "POST",
		headers: { "content-type": "application/json", "x-internal-secret": secret || SECRET },
		body: JSON.stringify(body)
	});
}

test("health probe reports the role", async () => {
	const r = await fetch(server.base + "/internal/health", { headers: { "x-internal-secret": SECRET } });
	assert.strictEqual(r.status, 200);
	const j = await r.json();
	assert.strictEqual(j.role, "main");
	assert.strictEqual(typeof j.activeMatches, "number");
});

test("the internal API rejects a wrong/missing secret", async () => {
	assert.strictEqual((await fetch(server.base + "/internal/health")).status, 403);
	assert.strictEqual((await postReport({ matchId: "x" }, "nope")).status, 403);
});

test("a reported result persists idempotently", async () => {
	const report = {
		matchId: "split-test:1", ranked: true, mode: "sprint", style: "sprint",
		standings: [{ id: "bot:a", rank: 1 }, { id: "bot:b", rank: 2 }] // bots only → no Elo writes, just dedupe
	};
	const first = await (await postReport(report)).json();
	assert.strictEqual(first.applied, true, "first report is applied");
	const second = await (await postReport(report)).json();
	assert.strictEqual(second.applied, false, "duplicate report is a no-op (idempotent across the API)");
});

test("the internal API is absent in the monolith role", async () => {
	const mono = await startServer({ port: 13831, env: { ROLE: "both" } });
	try {
		// In ROLE=both the /internal/* surface isn't mounted, so it falls through to the SPA fallback (200 html),
		// never the secret-guarded JSON handler.
		const r = await fetch(mono.base + "/internal/health", { headers: { "x-internal-secret": SECRET } });
		const ct = r.headers.get("content-type") || "";
		assert.ok(!ct.includes("application/json"), "monolith does not expose the internal JSON API");
	} finally { mono.stop(); }
});
