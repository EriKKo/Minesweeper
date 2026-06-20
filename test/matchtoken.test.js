// Phase 0 P0-8: the match-join token primitive. Sign at allocation, verify on connect (shared secret,
// no DB). Tested here; wired into the client→game-server join in Phase 1 when that connection exists.

const { test } = require("node:test");
const assert = require("node:assert");
const mt = require("../src/server/runtime/matchToken");

test("a freshly issued token verifies and carries its claims", () => {
	const token = mt.issueMatchToken({ matchId: "boot:room:5", userId: 42, gameServerAddr: "gs-1:9000" });
	const payload = mt.verifyMatchToken(token);
	assert.ok(payload, "valid token verifies");
	assert.strictEqual(payload.matchId, "boot:room:5");
	assert.strictEqual(payload.userId, 42);
	assert.strictEqual(payload.addr, "gs-1:9000");
});

test("a tampered payload or signature is rejected", () => {
	const token = mt.issueMatchToken({ matchId: "m", userId: 1 });
	const [body, sig] = token.split(".");
	assert.strictEqual(mt.verifyMatchToken(body + ".AAAA" + sig.slice(4)), null, "bad signature");
	// flip a byte in the payload but keep the original signature
	const tweaked = Buffer.from('{"matchId":"m","userId":999,"addr":null,"exp":' + (Date.now() + 60000) + "}").toString("base64url");
	assert.strictEqual(mt.verifyMatchToken(tweaked + "." + sig), null, "payload doesn't match signature");
});

test("an expired token is rejected", () => {
	const token = mt.issueMatchToken({ matchId: "m", userId: 1 }, 1000); // exp = now+1s
	assert.ok(mt.verifyMatchToken(token, Date.now()), "valid before expiry");
	assert.strictEqual(mt.verifyMatchToken(token, Date.now() + 2000), null, "rejected after expiry");
});

test("malformed tokens return null, never throw", () => {
	for (const bad of [null, undefined, "", "nodot", "a.b.c", "....", 123]) {
		assert.strictEqual(mt.verifyMatchToken(bad), null);
	}
});
