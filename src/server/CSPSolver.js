// Generalized CSP-style solver for Minesweeper deductions.
//
// A "clue" is a cardinality constraint: a set S of covered cells known to
// contain exactly M mines. Each numbered cell on the board generates an
// initial clue at complexity 0 (with a +0.5 bump per flagged neighbour
// that's been folded into the mine count). Three combine ops produce new
// clues from existing ones:
//
//   * subset       — if A.cells ⊂ B.cells, derive (B\A, M_B − M_A).   +1
//   * disjoint sum — if A ∩ B = ∅,         derive (A ∪ B, M_A + M_B). +1
//   * intersection — if bounds on |A ∩ B mines| collapse to a point,
//                    derive (A ∩ B, that point).                     +2
//
// Complexity of a derived clue = sum of parent complexities + op cost.
// We do best-first (min-complexity) search and stop at the first trivial
// clue (M = 0 → safe-set, or M = |S| → mine-set). Search space is bounded
// by:
//
//   * clue size ≤ 8 cells
//   * Chebyshev bounding-box of a clue's cells ≤ 2 (any pair of cells
//     within a 3×3 area)
//
// These two caps make the reachable clue space finite — the search either
// terminates with a deduction or genuinely runs out (puzzle needs enum).
//
// Built as a standalone module so it can run side-by-side with the
// existing trivial / subset / overlap / chain / enum pipeline for
// comparison.

var BoardLogic = require("../common/BoardLogic");
var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN, FLAGGED = BoardLogic.FLAGGED;
var MINE = BoardLogic.MINE;

var DEFAULT_MAX_CELLS = 8;
var DEFAULT_MAX_BBOX = 2;     // Chebyshev distance between any two cells
var DEFAULT_MAX_CLUES = 5000; // hard ceiling on the seen-set per search
var FLAG_BONUS = 0.5;
var SUBSET_COST = 1;
var UNION_COST = 1;
var INTERSECT_COST = 2;

function cellKey(cell) { return cell[0] + "," + cell[1]; }

function makeClue(cells, mines, complexity) {
	// Canonicalise so structurally-equal clues hash to the same key.
	var seen = {}, canon = [];
	for (var i = 0; i < cells.length; i++) {
		var k = cellKey(cells[i]);
		if (!seen[k]) { seen[k] = true; canon.push(cells[i]); }
	}
	canon.sort(function(a, b) { return a[0] - b[0] || a[1] - b[1]; });
	var key = canon.map(cellKey).join(";");
	return { key: key, cells: canon, mines: mines, complexity: complexity };
}

function isTrivial(clue) {
	if (clue.cells.length === 0) return false;
	return clue.mines === 0 || clue.mines === clue.cells.length;
}

function bboxOk(cells, maxDist) {
	if (cells.length <= 1) return true;
	var minR = cells[0][0], maxR = minR, minC = cells[0][1], maxC = minC;
	for (var i = 1; i < cells.length; i++) {
		var rr = cells[i][0], cc = cells[i][1];
		if (rr < minR) minR = rr; else if (rr > maxR) maxR = rr;
		if (cc < minC) minC = cc; else if (cc > maxC) maxC = cc;
	}
	return (maxR - minR) <= maxDist && (maxC - minC) <= maxDist;
}

function buildInitialClues(board, state) {
	var rows = board.length, cols = board[0].length;
	var out = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			var flagged = 0, covered = [];
			BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
				if (state[nr][nc] === FLAGGED) flagged++;
				else if (state[nr][nc] === UNKNOWN) covered.push([nr, nc]);
			});
			if (covered.length === 0) continue;
			var mines = board[r][c] - flagged;
			if (mines < 0) continue; // shouldn't happen on a consistent state
			out.push(makeClue(covered, mines, FLAG_BONUS * flagged));
		}
	}
	return out;
}

function combineSubset(A, B) {
	// Strict subset: A.cells ⊂ B.cells. Derives the extras.
	if (A.cells.length >= B.cells.length) return null;
	var bSet = {};
	for (var i = 0; i < B.cells.length; i++) bSet[cellKey(B.cells[i])] = true;
	var aKeys = {};
	for (var j = 0; j < A.cells.length; j++) {
		var ak = cellKey(A.cells[j]);
		if (!bSet[ak]) return null;
		aKeys[ak] = true;
	}
	var extras = [];
	for (var m = 0; m < B.cells.length; m++) {
		if (!aKeys[cellKey(B.cells[m])]) extras.push(B.cells[m]);
	}
	var newMines = B.mines - A.mines;
	if (newMines < 0 || newMines > extras.length) return null;
	return makeClue(extras, newMines, A.complexity + B.complexity + SUBSET_COST);
}

function combineDisjointUnion(A, B) {
	var aSet = {};
	for (var i = 0; i < A.cells.length; i++) aSet[cellKey(A.cells[i])] = true;
	for (var j = 0; j < B.cells.length; j++) {
		if (aSet[cellKey(B.cells[j])]) return null;
	}
	return makeClue(A.cells.concat(B.cells), A.mines + B.mines, A.complexity + B.complexity + UNION_COST);
}

function combineIntersection(A, B) {
	// Overlap (neither subset) with bounds on |intersection ∩ mines|
	// collapsing to a single value — yields a fresh clue on the
	// intersection. Skips the subset case (subsumed by combineSubset).
	var aSet = {};
	for (var i = 0; i < A.cells.length; i++) aSet[cellKey(A.cells[i])] = true;
	var inter = [];
	for (var j = 0; j < B.cells.length; j++) {
		if (aSet[cellKey(B.cells[j])]) inter.push(B.cells[j]);
	}
	if (inter.length === 0) return null;
	if (inter.length === A.cells.length) return null; // A ⊆ B — subset handles it
	if (inter.length === B.cells.length) return null; // B ⊆ A
	var uaSize = A.cells.length - inter.length;
	var ubSize = B.cells.length - inter.length;
	var lo = Math.max(0, A.mines - uaSize, B.mines - ubSize);
	var hi = Math.min(inter.length, A.mines, B.mines);
	if (lo !== hi) return null;
	return makeClue(inter, lo, A.complexity + B.complexity + INTERSECT_COST);
}

// Tiny binary heap keyed on the first element of each entry.
function heapPush(h, x) {
	h.push(x);
	var i = h.length - 1;
	while (i > 0) {
		var p = (i - 1) >> 1;
		if (h[p][0] > h[i][0]) { var t = h[p]; h[p] = h[i]; h[i] = t; i = p; } else break;
	}
}
function heapPop(h) {
	var top = h[0], last = h.pop();
	if (h.length) {
		h[0] = last;
		var i = 0, n = h.length;
		for (;;) {
			var l = 2 * i + 1, r = l + 1, best = i;
			if (l < n && h[l][0] < h[best][0]) best = l;
			if (r < n && h[r][0] < h[best][0]) best = r;
			if (best === i) break;
			var t = h[i]; h[i] = h[best]; h[best] = t; i = best;
		}
	}
	return top;
}

function findBestTrivialClue(initialClues, opts) {
	opts = opts || {};
	var maxCells = opts.maxCells || DEFAULT_MAX_CELLS;
	var maxBbox = opts.maxBbox != null ? opts.maxBbox : DEFAULT_MAX_BBOX;
	var maxClues = opts.maxClues || DEFAULT_MAX_CLUES;
	var seen = {}, keys = [], heap = [];

	function admit(clue) {
		if (!clue) return;
		if (clue.cells.length > maxCells) return;
		if (!bboxOk(clue.cells, maxBbox)) return;
		var prev = seen[clue.key];
		if (prev && prev.complexity <= clue.complexity) return;
		seen[clue.key] = clue;
		heapPush(heap, [clue.complexity, clue]);
		if (!prev) keys.push(clue.key);
	}

	for (var i = 0; i < initialClues.length; i++) admit(initialClues[i]);

	while (heap.length > 0) {
		if (keys.length > maxClues) break;
		var top = heapPop(heap);
		var c = top[1];
		if (seen[c.key] !== c) continue; // a cheaper version superseded this one
		if (isTrivial(c)) return c;

		// Combine with every clue we've seen so far. Subset is asymmetric
		// (try both directions); union and intersection are symmetric.
		for (var k = 0; k < keys.length; k++) {
			var other = seen[keys[k]];
			if (other === c) continue;
			admit(combineSubset(c, other));
			admit(combineSubset(other, c));
			admit(combineDisjointUnion(c, other));
			admit(combineIntersection(c, other));
		}
	}

	return null;
}

// Apply a trivial clue's effect to the state. Returns false if the clue
// wasn't trivial (caller error) or didn't change anything.
function applyTrivialClue(board, state, clue, revealCell) {
	if (!isTrivial(clue)) return false;
	var prog = false;
	if (clue.mines === 0) {
		for (var i = 0; i < clue.cells.length; i++) {
			var r = clue.cells[i][0], c = clue.cells[i][1];
			if (state[r][c] === UNKNOWN) {
				if (revealCell) revealCell(r, c); else state[r][c] = KNOWN;
				prog = true;
			}
		}
	} else {
		for (var j = 0; j < clue.cells.length; j++) {
			var r2 = clue.cells[j][0], c2 = clue.cells[j][1];
			if (state[r2][c2] === UNKNOWN) { state[r2][c2] = FLAGGED; prog = true; }
		}
	}
	return prog;
}

// Drive the full solve, replaying CSP search → apply → rebuild until
// either the puzzle is solved or no trivial clue is reachable inside the
// search budget. Returns { solved, moves, maxComplexity, totalComplexity }.
//
// `revealCell` cascades safe reveals (zeros open neighbours, etc.). When
// omitted, we set cells to KNOWN one at a time without cascade — that's
// fine for analysis but produces an inflated move count on cascade-heavy
// boards.
function analyzeBoard(board, state, opts) {
	opts = opts || {};
	var moves = [];
	while (true) {
		var initial = buildInitialClues(board, state);
		if (initial.length === 0) break;
		// Cheap path first: a starting clue that's already trivial costs 0
		// (or 0.5·flagged) and doesn't require any search.
		var directTrivial = null;
		for (var i = 0; i < initial.length; i++) {
			if (isTrivial(initial[i]) && (!directTrivial || initial[i].complexity < directTrivial.complexity)) {
				directTrivial = initial[i];
			}
		}
		var best = directTrivial || findBestTrivialClue(initial, opts);
		if (!best) break;
		// Snapshot the cells the move actually changed (reveal or flag)
		// before applying, so the UI can highlight them on the board.
		var changed = [];
		for (var ci = 0; ci < best.cells.length; ci++) {
			var rc = best.cells[ci];
			if (state[rc[0]][rc[1]] === UNKNOWN) changed.push(rc);
		}
		applyTrivialClue(board, state, best, opts.revealCell);
		moves.push({
			complexity: best.complexity,
			action: best.mines === 0 ? "reveal" : "flag",
			cells: best.cells,
			changed: changed,
			mines: best.mines
		});
	}
	// Solved = every safe cell is KNOWN. Mines may sit either FLAGGED or
	// UNKNOWN (they don't all need to be flagged for the player to win),
	// matching the existing analyzer's definition.
	var rows = board.length, cols = board[0].length;
	var safeCovered = 0;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (board[r][c] !== MINE && state[r][c] !== KNOWN) safeCovered++;
		}
	}
	var maxC = 0, totalC = 0;
	for (var m = 0; m < moves.length; m++) { totalC += moves[m].complexity; if (moves[m].complexity > maxC) maxC = moves[m].complexity; }
	return {
		solved: safeCovered === 0,
		moves: moves,
		maxComplexity: maxC,
		totalComplexity: totalC,
		safeCovered: safeCovered
	};
}

module.exports = {
	makeClue: makeClue,
	isTrivial: isTrivial,
	buildInitialClues: buildInitialClues,
	combineSubset: combineSubset,
	combineDisjointUnion: combineDisjointUnion,
	combineIntersection: combineIntersection,
	findBestTrivialClue: findBestTrivialClue,
	applyTrivialClue: applyTrivialClue,
	analyzeBoard: analyzeBoard
};
