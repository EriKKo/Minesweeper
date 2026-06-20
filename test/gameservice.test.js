// Phase 1 P1-1: the game-service boundary. allocate runs a match; reportResult hands the outcome to
// the registered persist handler. In-process today; the same contract gets a network transport in P1-5.

const { test, before } = require("node:test");
const assert = require("node:assert");

const gs = require("../src/server/runtime/gameService");

let started = null, persisted = null;
before(() => {
	gs.init({
		startMatch: (room) => { started = room; },
		onResult: (report) => { persisted = report; }
	});
});

test("allocate runs the match and returns its matchId", () => {
	const room = { matchConfig: { matchId: "boot:room:3" } };
	const handle = gs.allocate(room);
	assert.strictEqual(started, room, "startMatch was invoked with the room");
	assert.strictEqual(handle.matchId, "boot:room:3");
});

test("allocate tolerates a room with no config", () => {
	const handle = gs.allocate({});
	assert.strictEqual(handle.matchId, null);
});

test("reportResult hands the report to the registered handler", () => {
	const report = { matchId: "x", ranked: true };
	gs.reportResult(report);
	assert.strictEqual(persisted, report);
});

test("setResultHandler swaps the persist handler", () => {
	let alt = null;
	gs.setResultHandler((r) => { alt = r; });
	gs.reportResult({ matchId: "y" });
	assert.deepStrictEqual(alt, { matchId: "y" });
});
