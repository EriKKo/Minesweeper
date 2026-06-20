// Phase 1 P1-2: playerKeyFor resolves a stable, transport-independent identity. A signed-in user or
// guest keys off their account (so both sockets / a reconnect map to the same key); a bot off its id.

const { test, before } = require("node:test");
const assert = require("node:assert");

let identity, appState;
before(() => {
	identity = require("../src/server/runtime/identity");
	appState = require("../src/server/runtime/appState");
	appState.accounts.sockA = { userId: 42 };
	appState.accounts.sockB = { userId: 42 }; // same user, different socket (e.g. reconnect / 2nd connection)
	appState.bots.botX = true;
});

test("a user's key is stable across different sockets", () => {
	assert.strictEqual(identity.playerKeyFor("sockA"), "u:42");
	assert.strictEqual(identity.playerKeyFor("sockB"), "u:42", "same account → same key regardless of socket");
});

test("a bot keys off its bot id", () => {
	assert.strictEqual(identity.playerKeyFor("botX"), "bot:botX");
});

test("an accountless socket falls back to the socket id (marked)", () => {
	assert.strictEqual(identity.playerKeyFor("ghost"), "s:ghost");
});
