// Marathon boards (scripts/generate-marathon-boards.js, source="marathon") deliberately live in the
// same `puzzles` table as curriculum puzzles — the admin Marathon boards page and the puzzle_retry
// "Play" flow both work by treating them as ordinary rows. A real bug slipped through because of
// that: the daily-puzzle and rated/streak/storm pickers had no source filter, so a marathon board
// (long, dense, "lots of medium moves") could get served as if it were a normal curriculum puzzle.
// These pin down that every random-selection path excludes them, while direct by-id lookups (how
// puzzle_retry/Analyze reach a marathon row on purpose) still work.

const { test, before } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let db;
before(() => {
	process.env.RANKED_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ms-puzzlesource-"))); // dir
	process.env.RANKED_DB = path.join(process.env.RANKED_DB, "test.db");
	db = require("../src/server/db");
});

function seedPuzzle(source, ratingSeed) {
	// score maps to rating via scoreToRating; anything mid-range clears every window pickPuzzleNearRating
	// and pickDailyCandidate try, so these are reachable from any target/band used below.
	return db.insertPuzzle({
		key: "test:" + source + ":" + ratingSeed + ":" + Math.random(),
		rows: 8, cols: 8,
		mines: [[0, 0]],
		revealed: [[4, 4]],
		coveredSafe: 10, difficulty: 3, score: 1.5,
		maxEnumSize: 0, needsCaseSplit: false, cspMethod: "trivial",
		source: source
	});
}

test("pickDailyCandidate never returns a marathon board", () => {
	for (let i = 0; i < 15; i++) seedPuzzle("marathon", i);
	const curriculum = seedPuzzle("random", 0);
	assert.ok(curriculum, "curriculum puzzle inserted");

	for (let i = 0; i < 25; i++) {
		const picked = db.pickDailyCandidate();
		assert.ok(picked, "a candidate was found");
		assert.notStrictEqual(picked.source, "marathon", "must never pick a marathon board");
	}
});

test("pickPuzzleNearRating never returns a marathon board", () => {
	for (let i = 0; i < 25; i++) {
		const picked = db.pickPuzzleNearRating(1500, []);
		assert.ok(picked, "a candidate was found");
		assert.notStrictEqual(picked.source, "marathon", "must never pick a marathon board");
	}
});

test("pickPuzzleNearRating still excludes marathon even with no other puzzles in range", () => {
	// Force only-marathon-in-range by excluding the one curriculum puzzle we know exists; the "last
	// resort: any puzzle" fallback must still filter marathon out rather than falling back to it.
	const all = db.listPuzzles({ pageSize: 200 });
	const curriculumIds = all.filter(p => p.source !== "marathon").map(p => p.id);
	const picked = db.pickPuzzleNearRating(1500, curriculumIds);
	// Either null (nothing left to serve) or a non-marathon puzzle — never a marathon one.
	if (picked) assert.notStrictEqual(picked.source, "marathon");
});

test("curriculumPuzzleCount excludes marathon boards, puzzleCount includes them", () => {
	const total = db.puzzleCount();
	const curriculum = db.curriculumPuzzleCount();
	assert.ok(total > curriculum, "total pool count should include the marathon rows too");
	const marathonCount = total - curriculum;
	assert.ok(marathonCount >= 15, "expected at least the 15 marathon rows seeded above");
});

test("getPuzzleById can still reach a marathon board directly (puzzle_retry/Analyze path)", () => {
	const id = seedPuzzle("marathon", 999);
	// insertPuzzle returns a boolean (changes>0), not the id, so look it up by scanning for it.
	const rows = db.listPuzzles({ pageSize: 200, source: "marathon" });
	assert.ok(rows.length > 0, "marathon rows are listable directly");
	const byId = db.getPuzzleById(rows[0].id);
	assert.ok(byId, "direct by-id lookup still works for a marathon row");
	assert.strictEqual(byId.source, "marathon");
});
