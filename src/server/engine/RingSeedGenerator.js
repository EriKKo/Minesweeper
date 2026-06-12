// Turn a "4s and 2s" ring start (corners4-edges2) into a real, solvable puzzle.
//
// The corners4-edges2 ring on its own isn't no-guess solvable: it pins a checkerboard of mines
// via a cx-8 case-split and then stalls on a genuine ambiguity (it never forces a safe reveal).
// This generator nudges it into solvability:
//
//   1. Build the ring start: an H×W block (clue-0 interior, corners-4/edges-2 boundary clues)
//      centred in a padded board, everything outside the block covered.
//   2. Perturbation search: try changing ONE boundary clue to each legal value and run the CSP
//      analyzer. Keep the variants that force at least one cell to be REVEALED (not just flagged),
//      and rank them by how hard that deduction is (max CSP complexity).
//   3. From the hardest reveal-producing variant downward, hand the seed to the inside-out
//      generator (constructFromSeed), which drives the analyzer outward — committing each forced
//      reveal's clue to the value that maximises difficulty — until every cell is classified.
//      Keep the first variant that fully solves.
//
// Result: a board that opens from the recognisable 4s/2s ring but is fully deducible.

var BoardLogic = require("../../common/BoardLogic");
var csp = require("./CSPSolver");
var IO = require("./InsideOutGenerator");
var puzzleGen = require("./PuzzleGenerator");
var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN, FLAGGED = BoardLogic.FLAGGED, MINE = BoardLogic.MINE;

var scoreToRating = BoardLogic.scoreToRating;

// The corners4-edges2 ring start for an H×W block centred in an (H+2·pad)×(W+2·pad) board.
// Each block cell's clue counts the mines among its neighbours OUTSIDE the block (corner cells
// see 5 such cells -> 4, edge cells see 3 -> 2, interior sees 0 -> 0). Returns the geometry plus
// a clue map and the perturbable boundary cells (those with a non-zero clue).
function ringSeed(H, W, pad) {
	var rows = H + 2 * pad, cols = W + 2 * pad, r0 = pad, c0 = pad;
	function inBlock(r, c) { return r >= r0 && r < r0 + H && c >= c0 && c < c0 + W; }
	var blockCells = [], clue = {}, deg = {};
	for (var r = r0; r < r0 + H; r++) {
		for (var c = c0; c < c0 + W; c++) {
			blockCells.push([r, c]);
			var d = 0;
			for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
				if (!dr && !dc) continue;
				var nr = r + dr, nc = c + dc;
				if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
				if (!inBlock(nr, nc)) d++;
			}
			deg[r + "," + c] = d;
			clue[r + "," + c] = d === 0 ? 0 : (d >= 5 ? 4 : 2);
		}
	}
	var boundary = blockCells.filter(function(c) { return clue[c[0] + "," + c[1]] > 0; });
	return { H: H, W: W, rows: rows, cols: cols, r0: r0, c0: c0, blockCells: blockCells, boundary: boundary, clue: clue, deg: deg };
}

// Fresh (board, state) for a seed, applying a set of clue changes [{cell, value}, ...].
function materialize(seed, changes) {
	var board = [], state = [];
	for (var r = 0; r < seed.rows; r++) { board.push(new Array(seed.cols).fill(null)); state.push(new Array(seed.cols).fill(UNKNOWN)); }
	seed.blockCells.forEach(function(c) { state[c[0]][c[1]] = KNOWN; board[c[0]][c[1]] = seed.clue[c[0] + "," + c[1]]; });
	(changes || []).forEach(function(ch) { board[ch.cell[0]][ch.cell[1]] = ch.value; });
	return { board: board, state: state, startRevealed: seed.blockCells.slice() };
}

// All size-k change-sets: choose k boundary cells, each reassigned to a value != its original
// (within the legal 0..deg range). Returns arrays of { cell, value }.
function changeSets(seed, k) {
	var B = seed.boundary;
	var out = [];
	(function rec(start, acc) {
		if (acc.length === k) { out.push(acc.slice()); return; }
		for (var i = start; i < B.length; i++) {
			var cell = B[i], key = cell[0] + "," + cell[1], v0 = seed.clue[key], maxV = seed.deg[key];
			for (var v = 0; v <= maxV; v++) {
				if (v === v0) continue;
				acc.push({ cell: cell, value: v });
				rec(i + 1, acc);
				acc.pop();
			}
		}
	})(0, []);
	return out;
}

// Run the analyzer on a seed variant; report how many cells it forces revealed and the hardest
// deduction's complexity. (No revealCell: cells just flip KNOWN, which is all we need to count.)
function probe(board, state) {
	var sc = state.map(function(row) { return row.slice(); });
	var res;
	try { res = csp.analyzeBoard(board, sc, {}); } catch (e) { return null; }
	if (!res || !res.moves) return null;
	var reveals = 0;
	res.moves.forEach(function(m) { reveals += (m.revealed || []).length; });
	return { reveals: reveals, maxC: res.maxComplexity, solved: res.solved };
}

function comparePos(a, b) { return a[0] - b[0] || a[1] - b[1]; }

// Cascade-complete the revealed set against the final board (a covered tile next to a 0-clue is
// impossible — clicking a 0 cascades through), mirroring InsideOutGenerator's finishing step.
function cascadeComplete(board, rows, cols, revealed) {
	var set = {};
	revealed.forEach(function(rc) { set[rc[0] + "," + rc[1]] = true; });
	var list = revealed.slice();
	for (var i = 0; i < list.length; i++) {
		var rc = list[i];
		if (board[rc[0]][rc[1]] !== 0) continue;
		for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
			if (!dr && !dc) continue;
			BoardLogic.cascadeReveal(rc[0] + dr, rc[1] + dc, rows, cols,
				function(r, c) { return !set[r + "," + c] && board[r][c] !== MINE; },
				function(r, c) { set[r + "," + c] = true; list.push([r, c]); return false; },
				function(r, c) { return board[r][c]; });
		}
	}
	return list;
}

// Generate a solvable puzzle from the H×W corners4-edges2 ring. The ring on its own has two
// symmetric solutions, and no single clue change breaks that — so we search change-sets of
// increasing size (fewest changes first), keep the ones that force a reveal, and from the hardest
// downward hand them to the inside-out generator, returning the first that finishes faithfully
// and fully solvable. opts: { pads, maxChanges, tryLimit }.
function generateFromRing(H, W, opts) {
	opts = opts || {};
	var pads = opts.pads || [2, 1];
	var maxChanges = opts.maxChanges || 3;
	var tryLimit = opts.tryLimit || 60;
	for (var pi = 0; pi < pads.length; pi++) {
		var seed = ringSeed(H, W, pads[pi]);
		for (var k = 1; k <= maxChanges; k++) {
			// Change-sets of size k that force at least one reveal, hardest deduction first.
			var cands = [];
			changeSets(seed, k).forEach(function(changes) {
				var m = materialize(seed, changes);
				var p = probe(m.board, m.state);
				if (p && p.reveals > 0) cands.push({ changes: changes, maxC: p.maxC });
			});
			cands.sort(function(a, b) { return b.maxC - a.maxC; });
			for (var i = 0; i < cands.length && i < tryLimit; i++) {
				var changes = cands[i].changes;
				var mm = materialize(seed, changes);
				var raw = IO.constructFromSeed(mm.board, mm.state, mm.startRevealed, seed.rows, seed.cols, opts);
				if (!raw) continue;
				var board = puzzleGen.buildBoard(raw.rows, raw.cols, raw.mines);
				// Faithfulness guard: the finished board's block clues must still be the ring values
				// (with exactly our changes). A change-set that makes the ring unsatisfiable lets the
				// construction "deduce" from a contradiction and buildBoard yields an unrelated board
				// whose block clues drifted — reject so we only keep boards that genuinely open from
				// the 4s/2s ring with the chosen numbers changed.
				var want = {};
				seed.blockCells.forEach(function(bc) { want[bc[0] + "," + bc[1]] = seed.clue[bc[0] + "," + bc[1]]; });
				changes.forEach(function(ch) { want[ch.cell[0] + "," + ch.cell[1]] = ch.value; });
				var faithful = seed.blockCells.every(function(bc) { return board[bc[0]][bc[1]] === want[bc[0] + "," + bc[1]]; });
				if (!faithful) continue;
				var revealed = cascadeComplete(board, raw.rows, raw.cols, raw.revealed).sort(comparePos);
				var coveredSafe = raw.rows * raw.cols - raw.mines.length - revealed.length;
				if (coveredSafe < 1) continue;
				var a = puzzleGen.analyzeWithTracking(board, revealed, raw.mines.length);
				if (!a.solved) continue;
				return {
					rows: raw.rows, cols: raw.cols, mines: raw.mines.slice().sort(comparePos), revealed: revealed,
					coveredSafe: coveredSafe, difficulty: a.difficulty, score: a.score, rating: scoreToRating(a.score),
					solved: true, cspMethod: a.cspMethod, needsCaseSplit: a.needsCaseSplit, cspMaxComplexity: a.cspMaxComplexity,
					perturbation: { changes: changes.map(function(ch) { return { cell: ch.cell, to: ch.value, from: seed.clue[ch.cell[0] + "," + ch.cell[1]] }; }), startComplexity: cands[i].maxC },
					pad: pads[pi]
				};
			}
		}
	}
	return null;
}

module.exports = { ringSeed: ringSeed, materialize: materialize, generateFromRing: generateFromRing };
