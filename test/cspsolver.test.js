// CSPSolver.analyzeBoard coverage. Previously zero — analyzeBoard rebuilt its clue search from
// scratch every move; it's now incremental (a persistent clue store carried across the whole
// solve instead of rebuilt each iteration), so these pin down both basic deduction correctness and
// the specific bug that incremental rewrite introduced and fixed: a clue that still lists an
// already-resolved cell can fail to structurally match (subset/disjoint/intersect all compare
// literal cell lists) against a freshly-built clue from another origin, so the search can get
// stuck on a board that's still solvable unless origins are re-narrowed as their neighbours
// resolve (see analyzeBoard's `syncOrigins`/`isFresh`).

const { test } = require("node:test");
const assert = require("node:assert");
const csp = require("../src/server/engine/CSPSolver");
const NoGuessGenerator = require("../src/server/engine/NoGuessGenerator");
const GameCreator = require("../src/server/engine/GameCreator");
const BoardLogic = require("../src/common/BoardLogic");

const U = BoardLogic.UNKNOWN, K = BoardLogic.KNOWN, F = BoardLogic.FLAGGED, M = BoardLogic.MINE;

function mulberry32(seed) {
	return function() {
		seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function cascadeFor(board, state) {
	const rows = board.length, cols = board[0].length;
	return function(r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			(rr, cc) => state[rr][cc] === U,
			(rr, cc) => { state[rr][cc] = K; return false; },
			(rr, cc) => board[rr][cc]);
	};
}

// Every KNOWN cell must be a real non-mine and every FLAGGED cell a real mine — the one invariant
// that must hold regardless of derivation path, complexity numbers, or move bundling.
function assertSound(board, state, label) {
	for (let r = 0; r < board.length; r++) {
		for (let c = 0; c < board[0].length; c++) {
			if (state[r][c] === K) assert.notStrictEqual(board[r][c], M, `${label}: (${r},${c}) revealed but is a mine`);
			if (state[r][c] === F) assert.strictEqual(board[r][c], M, `${label}: (${r},${c}) flagged but isn't a mine`);
		}
	}
}

test("trivial flag + solve: single mine in a corner, forced once its only neighbour opens up", () => {
	// board (single mine at bottom-right corner):
	//   0 0 0
	//   0 1 1
	//   0 1 M
	const board = [[0, 0, 0], [0, 1, 1], [0, 1, M]];
	const state = [[U, U, U], [U, U, U], [U, U, U]];
	const cascade = cascadeFor(board, state);
	cascade(0, 0); // the starting click a real game would already have opened
	const result = csp.analyzeBoard(board, state, { revealCell: cascade });
	assert.strictEqual(result.solved, true);
	assertSound(board, state, "trivial flag");
	assert.strictEqual(state[2][2], F, "the only mine should end up flagged");
});

test("incremental narrowing regression: solve stays complete when a neighbour resolves mid-solve", () => {
	// Regression for the exact bug found while making analyzeBoard incremental: without
	// re-narrowing an origin's clue when one of its own neighbours resolves, a later subset match
	// against a fresher (smaller) clue from a different origin can silently fail to fire, leaving
	// a solvable board stuck. This board/seed combination was the first reproduction found.
	const rows = 8, cols = 8, density = 0.15;
	const mines = Math.round(rows * cols * density);
	const origRandom = Math.random;
	Math.random = mulberry32(2);
	let tmpl;
	try { tmpl = GameCreator.createTemplate(4, 4, mines, rows, cols); }
	finally { Math.random = origRandom; }

	const state = [];
	for (let r = 0; r < rows; r++) state.push(new Array(cols).fill(U));
	tmpl.knownCells.forEach(([r, c]) => { state[r][c] = K; });

	const result = csp.analyzeBoard(tmpl.board, state, { maxComplexity: 7, revealCell: cascadeFor(tmpl.board, state) });
	assert.strictEqual(result.solved, true);
	assertSound(tmpl.board, state, "incremental narrowing regression");
});

test("no-guess-generated boards: fully solvable and sound across a range of sizes/densities", () => {
	const cases = [
		{ rows: 8, cols: 8, density: 0.12, seed: 10 },
		{ rows: 12, cols: 16, density: 0.15, seed: 11 },
		{ rows: 16, cols: 20, density: 0.18, seed: 12 },
		{ rows: 20, cols: 24, density: 0.20, seed: 13 }
	];
	const origRandom = Math.random;
	try {
		cases.forEach(({ rows, cols, density, seed }) => {
			Math.random = mulberry32(seed);
			const mines = Math.round(rows * cols * density);
			const tmpl = NoGuessGenerator.createNoGuessTemplate(Math.floor(rows / 2), Math.floor(cols / 2), mines, 30, rows, cols);
			assert.ok(tmpl, `${rows}x${cols}@${density}: generator found no candidate at all`);

			const state = [];
			for (let r = 0; r < rows; r++) state.push(new Array(cols).fill(U));
			tmpl.knownCells.forEach(([r, c]) => { state[r][c] = K; });

			const result = csp.analyzeBoard(tmpl.board, state, { revealCell: cascadeFor(tmpl.board, state) });
			assert.strictEqual(result.solved, true, `${rows}x${cols}@${density} should be fully solvable (generator already verified it)`);
			assertSound(tmpl.board, state, `${rows}x${cols}@${density}`);
		});
	} finally {
		Math.random = origRandom;
	}
});

test("partial-solve state: analyzeBoard stays sound and completes when called on an already-partway-solved board", () => {
	const rows = 15, cols = 20, density = 0.15;
	const mines = Math.round(rows * cols * density);
	const origRandom = Math.random;
	Math.random = mulberry32(20);
	let tmpl;
	try { tmpl = GameCreator.createTemplate(7, 10, mines, rows, cols); }
	finally { Math.random = origRandom; }

	const seedState = [];
	for (let r = 0; r < rows; r++) seedState.push(new Array(cols).fill(U));
	tmpl.knownCells.forEach(([r, c]) => { seedState[r][c] = K; });

	// Run once uncapped to get a real, valid partial trace, then stop partway through it.
	// (cascadeFor must be built from the SAME state array analyzeBoard mutates — a separate
	// clone here would make revealCell's writes invisible to analyzeBoard's own state, so a
	// "reveal" move would never actually register and get rediscovered forever.)
	const fullState = seedState.map(row => row.slice());
	const full = csp.analyzeBoard(tmpl.board, fullState, { revealCell: cascadeFor(tmpl.board, fullState) });
	assert.ok(full.moves.length > 4, "test board should take more than a handful of moves to solve");

	const partialState = [];
	for (let r = 0; r < rows; r++) partialState.push(new Array(cols).fill(U));
	tmpl.knownCells.forEach(([r, c]) => { partialState[r][c] = K; });
	const cascade = cascadeFor(tmpl.board, partialState);
	const cutoff = Math.floor(full.moves.length * 0.4);
	for (let i = 0; i < cutoff; i++) {
		const mv = full.moves[i];
		(mv.revealed || (mv.action === "reveal" ? mv.changed : [])).forEach(([r, c]) => {
			if (partialState[r][c] === U) cascade(r, c);
		});
		(mv.flagged || (mv.action === "flag" ? mv.changed : [])).forEach(([r, c]) => {
			if (partialState[r][c] === U) partialState[r][c] = F;
		});
	}

	const resumed = csp.analyzeBoard(tmpl.board, partialState, { revealCell: cascadeFor(tmpl.board, partialState) });
	assert.strictEqual(resumed.solved, true, "resuming from a partial state should still reach a full solve");
	assertSound(tmpl.board, partialState, "partial-solve resume");
});
