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
var puzzleSolver = require("./PuzzleSolver");
var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN, FLAGGED = BoardLogic.FLAGGED;
var MINE = BoardLogic.MINE;

var DEFAULT_MAX_CELLS = 8;
var DEFAULT_MAX_BBOX = 2;     // Chebyshev distance between any two cells
var DEFAULT_MAX_CLUES = 5000; // hard ceiling on the seen-set per search
var FLAG_BONUS = 0.5;
var SUBSET_COST = 1.5;
var UNION_COST = 1.5;
var INTERSECT_COST = 2.5;
// Per-cell surcharge added to each initial clue. Counting against five
// covered cells is harder than against two; the surcharge propagates
// through every derivation since parent complexities sum.
var CELL_CAP_FREE = 2;     // cells <= this many are free to read
var CELL_SURCHARGE = 0.2;  // each cell over the free cap
// Mine-density surcharge. Clues with mines in the middle of the range
// (e.g. "3 of 5") are harder than extremes ("0 of 5" / "5 of 5"). Add
// 0.1 per unit of min(mines, cells - mines) to the initial clue cost.
var DENSITY_SURCHARGE = 0.1;
// Op cost scales with the size of the result clue — a 5-cell deduction
// is mentally heavier than a 1-cell one even at the same depth.
var RESULT_SIZE_SURCHARGE = 0.1;

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
			var sizeSurcharge = CELL_SURCHARGE * Math.max(0, covered.length - CELL_CAP_FREE);
			var densitySurcharge = DENSITY_SURCHARGE * Math.min(mines, covered.length - mines);
			out.push(makeClue(covered, mines, sizeSurcharge + densitySurcharge + FLAG_BONUS * flagged));
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
	var sizeCost = RESULT_SIZE_SURCHARGE * Math.max(0, extras.length - 1);
	return makeClue(extras, newMines, A.complexity + B.complexity + SUBSET_COST + sizeCost);
}

function combineDisjointUnion(A, B) {
	var aSet = {};
	for (var i = 0; i < A.cells.length; i++) aSet[cellKey(A.cells[i])] = true;
	for (var j = 0; j < B.cells.length; j++) {
		if (aSet[cellKey(B.cells[j])]) return null;
	}
	var union = A.cells.concat(B.cells);
	var sizeCost = RESULT_SIZE_SURCHARGE * Math.max(0, union.length - 1);
	return makeClue(union, A.mines + B.mines, A.complexity + B.complexity + UNION_COST + sizeCost);
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
	var sizeCost = RESULT_SIZE_SURCHARGE * Math.max(0, inter.length - 1);
	return makeClue(inter, lo, A.complexity + B.complexity + INTERSECT_COST + sizeCost);
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

// Case analysis (1-cell split + propagate). When the CSP search can't
// reach a trivial clue, we try splitting on each frontier cell: simulate
// safe/mine, propagate each branch via the same CSP pipeline (no enum,
// no recursion), and intersect the determined cells. Any cell forced
// identically in both branches is determined regardless of the split
// cell's value; if one branch contradicts, the other value is forced
// for the split cell itself plus everything it propagates.
//
// This catches the puzzle patterns a human spots without brute-forcing:
// "what if THAT cell is a mine?" → propagate → see the contradiction
// or the common conclusion. Cost: 3 + max(branch propagation cost),
// modeling "do two scenarios and compare".

function snapshotState(state) {
	var out = new Array(state.length);
	for (var i = 0; i < state.length; i++) out[i] = state[i].slice();
	return out;
}

function stateConsistent(board, state) {
	var rows = board.length, cols = board[0].length;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			var flagged = 0, covered = 0;
			BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
				if (state[nr][nc] === FLAGGED) flagged++;
				else if (state[nr][nc] === UNKNOWN) covered++;
			});
			var need = board[r][c] - flagged;
			if (need < 0 || need > covered) return false;
		}
	}
	return true;
}

function makeCascadeFor(board, state) {
	var rows = board.length, cols = board[0].length;
	return function(rr, cc) {
		BoardLogic.cascadeReveal(rr, cc, rows, cols,
			function(r2, c2) { return state[r2][c2] === UNKNOWN; },
			function(r2, c2) { state[r2][c2] = KNOWN; return false; },
			function(r2, c2) { return board[r2][c2]; });
	};
}

function propagateBranch(board, state, opts) {
	var cascade = makeCascadeFor(board, state);
	var maxC = 0;
	while (true) {
		if (!stateConsistent(board, state)) return -1; // contradiction
		var initial = buildInitialClues(board, state);
		if (!initial.length) break;
		var direct = null;
		for (var i = 0; i < initial.length; i++) {
			if (isTrivial(initial[i]) && (!direct || initial[i].complexity < direct.complexity)) direct = initial[i];
		}
		var best = direct || findBestTrivialClue(initial, opts);
		if (!best) break;
		if (best.complexity > maxC) maxC = best.complexity;
		applyTrivialClue(board, state, best, cascade);
	}
	return maxC;
}

function findCaseSplitStep(board, state, opts) {
	var rows = board.length, cols = board[0].length;
	// Frontier = covered cells adjacent to any KNOWN clue cell.
	var frontierMap = {};
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
				if (state[nr][nc] === UNKNOWN) frontierMap[nr + "," + nc] = [nr, nc];
			});
		}
	}
	var frontier = [];
	for (var fk in frontierMap) frontier.push(frontierMap[fk]);

	var best = null;
	for (var fi = 0; fi < frontier.length; fi++) {
		var cell = frontier[fi];
		var pr = cell[0], pc = cell[1];

		var sA = snapshotState(state);
		sA[pr][pc] = KNOWN;
		makeCascadeFor(board, sA)(pr, pc);
		var maxA = propagateBranch(board, sA, opts);

		var sB = snapshotState(state);
		sB[pr][pc] = FLAGGED;
		var maxB = propagateBranch(board, sB, opts);

		var okA = maxA >= 0, okB = maxB >= 0;
		if (!okA && !okB) continue; // both contradict — shouldn't happen on a valid puzzle

		var revealed = [], flagged = [];
		if (!okA && okB) {
			flagged.push([pr, pc]);
			for (var r2 = 0; r2 < rows; r2++) for (var c2 = 0; c2 < cols; c2++) {
				if (state[r2][c2] !== UNKNOWN || (r2 === pr && c2 === pc)) continue;
				if (sB[r2][c2] === KNOWN) revealed.push([r2, c2]);
				else if (sB[r2][c2] === FLAGGED) flagged.push([r2, c2]);
			}
		} else if (!okB && okA) {
			revealed.push([pr, pc]);
			for (var r3 = 0; r3 < rows; r3++) for (var c3 = 0; c3 < cols; c3++) {
				if (state[r3][c3] !== UNKNOWN || (r3 === pr && c3 === pc)) continue;
				if (sA[r3][c3] === KNOWN) revealed.push([r3, c3]);
				else if (sA[r3][c3] === FLAGGED) flagged.push([r3, c3]);
			}
		} else {
			// Both branches consistent — keep cells forced identically.
			for (var r4 = 0; r4 < rows; r4++) for (var c4 = 0; c4 < cols; c4++) {
				if (state[r4][c4] !== UNKNOWN || (r4 === pr && c4 === pc)) continue;
				if (sA[r4][c4] === KNOWN && sB[r4][c4] === KNOWN) revealed.push([r4, c4]);
				else if (sA[r4][c4] === FLAGGED && sB[r4][c4] === FLAGGED) flagged.push([r4, c4]);
			}
		}
		if (!revealed.length && !flagged.length) continue;
		var branchMax = Math.max(okA ? maxA : 0, okB ? maxB : 0);
		var complexity = 5 + branchMax;
		var yieldCount = revealed.length + flagged.length;
		if (!best
			|| complexity < best.complexity
			|| (complexity === best.complexity && yieldCount > best.yieldCount)) {
			best = {
				splitCell: [pr, pc],
				revealed: revealed,
				flagged: flagged,
				complexity: complexity,
				yieldCount: yieldCount,
				branchA: okA ? maxA : null,
				branchB: okB ? maxB : null
			};
		}
	}
	return best;
}

// Enum fallback. When the CSP search can't reach a trivial clue, we hand
// off to the brute-force enum pass, but pick the **smallest yielding
// component** — that way the move's complexity reflects only the case
// analysis the player actually had to do, not the biggest component on
// the board. Component size k → complexity 2 + 0.6·(k−1)^1.3, matching
// the shape of the existing generator's enum-size bonus.
function enumComplexity(componentSize) {
	if (componentSize <= 1) return 2;
	return 2 + 0.6 * Math.pow(componentSize - 1, 1.3);
}

function findSmallestEnumStep(board, state) {
	var steps = puzzleSolver.findEnumSteps(board, state);
	if (!steps.length) return null;
	var best = steps[0];
	for (var i = 1; i < steps.length; i++) {
		if (steps[i].componentSize < best.componentSize) best = steps[i];
	}
	return best;
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
		if (best) {
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
			continue;
		}
		// CSP search exhausted — try 1-cell case analysis (cheaper than enum).
		var caseStep = findCaseSplitStep(board, state, opts);
		if (caseStep) {
			var caseRevealed = [], caseFlagged = [];
			for (var csi = 0; csi < caseStep.revealed.length; csi++) {
				var crc = caseStep.revealed[csi];
				if (state[crc[0]][crc[1]] === UNKNOWN) {
					caseRevealed.push(crc);
					if (opts.revealCell) opts.revealCell(crc[0], crc[1]);
					else state[crc[0]][crc[1]] = KNOWN;
				}
			}
			for (var cfi = 0; cfi < caseStep.flagged.length; cfi++) {
				var cfc = caseStep.flagged[cfi];
				if (state[cfc[0]][cfc[1]] !== FLAGGED) {
					caseFlagged.push(cfc);
					state[cfc[0]][cfc[1]] = FLAGGED;
				}
			}
			moves.push({
				complexity: caseStep.complexity,
				action: "case",
				splitCell: caseStep.splitCell,
				cells: caseRevealed.concat(caseFlagged),
				changed: caseRevealed.concat(caseFlagged),
				revealed: caseRevealed,
				flagged: caseFlagged
			});
			continue;
		}
		// Even case analysis can't progress — final fallback is brute-force enum
		// on the smallest yielding frontier component.
		var enumStep = findSmallestEnumStep(board, state);
		if (!enumStep) break;
		var revealed = [], flagged = [];
		for (var si = 0; si < enumStep.safeCells.length; si++) {
			var sr = enumStep.safeCells[si];
			if (state[sr[0]][sr[1]] === UNKNOWN) {
				revealed.push(sr);
				if (opts.revealCell) opts.revealCell(sr[0], sr[1]);
				else state[sr[0]][sr[1]] = KNOWN;
			}
		}
		for (var mi = 0; mi < enumStep.mineCells.length; mi++) {
			var mr = enumStep.mineCells[mi];
			if (state[mr[0]][mr[1]] !== FLAGGED) {
				flagged.push(mr);
				state[mr[0]][mr[1]] = FLAGGED;
			}
		}
		if (!revealed.length && !flagged.length) break; // shouldn't happen, defensive
		moves.push({
			complexity: enumComplexity(enumStep.componentSize),
			action: "enum",
			componentSize: enumStep.componentSize,
			cells: revealed.concat(flagged),
			changed: revealed.concat(flagged),
			revealed: revealed,
			flagged: flagged
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
