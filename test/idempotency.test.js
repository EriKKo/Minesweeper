// Phase 0 P0-5: match-result persistence is idempotent. The primitive is db.markMatchPersisted —
// the first call for a matchId returns true (apply the results), every later call returns false
// (already applied), so a retried/duplicate result report can't double-apply Elo/history/replay.

const { test, before } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let db;
before(() => {
	// Point db.js at a throwaway database so we never touch the real ranked.db.
	process.env.RANKED_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ms-idem-")), "test.db");
	db = require("../src/server/db");
});

test("markMatchPersisted records a matchId exactly once", () => {
	const id = "room:42";
	assert.strictEqual(db.markMatchPersisted(id), true, "first time → newly persisted");
	assert.strictEqual(db.markMatchPersisted(id), false, "second time → already persisted");
	assert.strictEqual(db.markMatchPersisted(id), false, "still idempotent on further retries");
});

test("distinct matchIds are tracked independently", () => {
	assert.strictEqual(db.markMatchPersisted("room:100"), true);
	assert.strictEqual(db.markMatchPersisted("room:101"), true);
	assert.strictEqual(db.markMatchPersisted("room:100"), false);
});

test("a missing matchId fails open (does not block persistence)", () => {
	assert.strictEqual(db.markMatchPersisted(null), true);
	assert.strictEqual(db.markMatchPersisted(""), true);
});
