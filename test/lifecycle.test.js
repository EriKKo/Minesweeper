// Phase 0 P0-7: game-runtime draining. An instance stops accepting new matches when draining and only
// signals "empty" once no match is active — so a deploy/shutdown never cuts a live match.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const lifecycle = require("../src/server/runtime/lifecycle");
const appState = require("../src/server/runtime/appState");

beforeEach(() => {
	lifecycle._reset();
	for (const id of Object.keys(appState.rooms)) delete appState.rooms[id];
});

test("activeMatchCount counts only rooms in the playing phase", () => {
	assert.strictEqual(lifecycle.activeMatchCount(), 0);
	appState.rooms[1] = { phase: "playing" };
	appState.rooms[2] = { phase: "planning" };
	appState.rooms[3] = { phase: "playing" };
	assert.strictEqual(lifecycle.activeMatchCount(), 2);
});

test("draining flips acceptance", () => {
	assert.strictEqual(lifecycle.canAcceptNewMatch(), true);
	assert.strictEqual(lifecycle.isDraining(), false);
	lifecycle.beginDrain(() => {});
	assert.strictEqual(lifecycle.isDraining(), true);
	assert.strictEqual(lifecycle.canAcceptNewMatch(), false);
});

test("beginDrain signals empty immediately when idle", () => {
	let drained = false;
	lifecycle.beginDrain(() => { drained = true; });
	assert.strictEqual(drained, true, "no active matches → onEmpty runs at once");
});

test("beginDrain waits for an active match to finish before signalling empty", async () => {
	appState.rooms[1] = { phase: "playing" };
	let drained = false;
	lifecycle.beginDrain(() => { drained = true; }, { pollMs: 10 });
	assert.strictEqual(drained, false, "active match → not yet drained");
	appState.rooms[1].phase = "planning"; // match ends
	await new Promise(r => setTimeout(r, 40));
	assert.strictEqual(drained, true, "drains once the match is no longer playing");
});

test("beginDrain gives up after maxWaitMs even if a match is stuck", async () => {
	appState.rooms[1] = { phase: "playing" };
	let drained = false;
	lifecycle.beginDrain(() => { drained = true; }, { pollMs: 10, maxWaitMs: 20 });
	await new Promise(r => setTimeout(r, 60));
	assert.strictEqual(drained, true, "bounded wait — never blocks shutdown forever");
});
