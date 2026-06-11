// Generalized CSP-style solver for Minesweeper deductions.
//
// A "clue" is a cardinality constraint: a set S of covered cells whose
// mine count lies in a range [lo, hi]. Each numbered cell on the board
// generates an initial equality clue (lo = hi = M). Three combine ops
// produce new clues from existing ones, each carrying tightened bounds:
//
//   * subset       — A.cells ⊂ B.cells ⇒ B\A has [B.lo−A.hi, B.hi−A.lo]
//                    mines (clamped to [0, |B\A|]).
//   * disjoint sum — A ∩ B = ∅          ⇒ A∪B has [A.lo+B.lo, A.hi+B.hi].
//   * intersection — A, B overlap        ⇒ A∩B has bounds from each side.
//
// Earlier versions only produced *equality* clues (lo == hi). Allowing
// "at most"/"at least" clues — the cases where the intersection or
// subset doesn't collapse to a point — lets short proofs reach
// deductions that previously required case-split. A trivial deduction
// is still the same: lo == hi == 0 (set is all safe) or lo == hi ==
// |cells| (set is all mines).
//
// Complexity of a derived clue = max(parents) + op cost. Best-first
// search stops at the first trivial clue. Search space is bounded by:
//
//   * clue size ≤ 8 cells
//   * Chebyshev bounding-box of a clue's cells ≤ 2 (any pair of cells
//     within a 3×3 area — past that, humans can't easily reason about
//     the combination)
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
var DEFAULT_MAX_CLUES = 10000; // hard ceiling on the seen-set per search
var FLAG_BONUS = 0.5;
var SUBSET_COST = 2.0;
var UNION_COST = 1.0;
var INTERSECT_COST = 2.5;
// Per-cell surcharge added to each initial clue. Counting against five
// covered cells is harder than against two; the surcharge propagates
// through every derivation since parent complexities sum.
var CELL_SURCHARGE = 0.15;  // each covered cell adds this much
// Mine-density surcharge. Clues with mines in the middle of the range
// (e.g. "3 of 5") are harder than extremes ("0 of 5" / "5 of 5"). Add
// per unit of min(mines, cells - mines) to the initial clue cost.
var DENSITY_SURCHARGE = 0.12;
// Op cost scales with the size of the result clue — a 5-cell deduction
// is mentally heavier than a 1-cell one even at the same depth.
var RESULT_SIZE_SURCHARGE = 0.12;

function cellKey(cell) { return cell[0] + "," + cell[1]; }

function makeClue(cells, lo, hi, complexity, meta) {
	// Canonicalise so structurally-equal clues hash to the same key.
	var seen = {}, canon = [];
	for (var i = 0; i < cells.length; i++) {
		var k = cellKey(cells[i]);
		if (!seen[k]) { seen[k] = true; canon.push(cells[i]); }
	}
	canon.sort(function(a, b) { return a[0] - b[0] || a[1] - b[1]; });
	// Clamp bounds to the legal [0, |cells|] range.
	if (lo < 0) lo = 0;
	if (hi > canon.length) hi = canon.length;
	// Key includes bounds so "≤2 mines" and "=1 mine" on the same cells
	// are tracked as distinct deductions.
	var cellsKey = canon.map(cellKey).join(";");
	var key = cellsKey + "|" + lo + "-" + hi;
	meta = meta || {};
	var depth = 0;
	if (meta.parents) {
		for (var p = 0; p < meta.parents.length; p++) {
			if (meta.parents[p].depth + 1 > depth) depth = meta.parents[p].depth + 1;
		}
	}
	return {
		key: key, cellsKey: cellsKey, cells: canon, lo: lo, hi: hi,
		complexity: complexity,
		source: meta.source || "initial",
		parents: meta.parents || null,
		from: meta.from || null,    // origin cell for initial clues
		depth: depth
	};
}

function isTrivial(clue) {
	if (clue.cells.length === 0) return false;
	if (clue.lo !== clue.hi) return false;
	return clue.hi === 0 || clue.hi === clue.cells.length;
}

function isContradiction(clue) {
	return clue.lo > clue.hi;
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
			var sizeSurcharge = CELL_SURCHARGE * covered.length;
			var densitySurcharge = DENSITY_SURCHARGE * Math.min(mines, covered.length - mines);
			out.push(makeClue(covered, mines, mines, sizeSurcharge + densitySurcharge + FLAG_BONUS * flagged, {
				source: "initial",
				from: [r, c]
			}));
		}
	}
	return out;
}

function combineSubset(A, B) {
	// A.cells ⊂ B.cells. The extras (B\A) hold mines(B) − mines(A).
	// With bounded clues, mines(B\A) ∈ [B.lo − A.hi, B.hi − A.lo].
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
	var lo = Math.max(0, B.lo - A.hi);
	var hi = Math.min(extras.length, B.hi - A.lo);
	if (lo > hi) return null;
	// Skip trivially-uninformative results (no tighter than (0..|extras|)).
	if (lo === 0 && hi === extras.length) return null;
	var sizeCost = RESULT_SIZE_SURCHARGE * extras.length;
	return makeClue(extras, lo, hi, Math.max(A.complexity, B.complexity) + SUBSET_COST + sizeCost, {
		source: "subset", parents: [A, B]
	});
}

function combineDisjointUnion(A, B) {
	var aSet = {};
	for (var i = 0; i < A.cells.length; i++) aSet[cellKey(A.cells[i])] = true;
	for (var j = 0; j < B.cells.length; j++) {
		if (aSet[cellKey(B.cells[j])]) return null;
	}
	var union = A.cells.concat(B.cells);
	var lo = A.lo + B.lo;
	var hi = A.hi + B.hi;
	if (lo === 0 && hi === union.length) return null;
	var sizeCost = RESULT_SIZE_SURCHARGE * union.length;
	return makeClue(union, lo, hi, Math.max(A.complexity, B.complexity) + UNION_COST + sizeCost, {
		source: "union", parents: [A, B]
	});
}

function combineIntersection(A, B) {
	// Bounds on mines(A∩B) from each side, then take the tighter.
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
	var lo = Math.max(0, A.lo - uaSize, B.lo - ubSize);
	var hi = Math.min(inter.length, A.hi, B.hi);
	if (lo > hi) return null;
	if (lo === 0 && hi === inter.length) return null;
	var sizeCost = RESULT_SIZE_SURCHARGE * inter.length;
	return makeClue(inter, lo, hi, Math.max(A.complexity, B.complexity) + INTERSECT_COST + sizeCost, {
		source: "intersect", parents: [A, B]
	});
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
	var maxComplexity = opts.maxComplexity != null ? opts.maxComplexity : Infinity;
	var seen = {}, keys = [], heap = [];

	function admit(clue) {
		if (!clue) return;
		if (clue.cells.length > maxCells) return;
		// Derivations only get more complex (children >= parent complexity + a
		// positive op cost), so anything already over the cap can be pruned — its
		// descendants would exceed it too. This both enforces the skill ceiling and
		// is the main speedup for capped solves.
		if (clue.complexity > maxComplexity) return;
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

// Walk the proof DAG from a final trivial clue back to its initial
// clues, producing a topologically-ordered list of derivation steps the
// UI can render. Each step refers to its parents by index in the list,
// so the renderer can show "step N = intersect of step A and step B".
function flattenDerivation(clue) {
	var seen = {}, steps = [];
	function visit(c) {
		if (seen[c.key] != null) return seen[c.key];
		var parentIdx = null;
		if (c.parents) parentIdx = c.parents.map(visit);
		var step = {
			index: steps.length,
			source: c.source,
			cells: c.cells,
			lo: c.lo,
			hi: c.hi,
			complexity: Math.round(c.complexity * 100) / 100,
			depth: c.depth
		};
		if (c.from) step.from = c.from;
		if (parentIdx) step.parents = parentIdx;
		seen[c.key] = step.index;
		steps.push(step);
		return step.index;
	}
	visit(clue);
	return steps;
}

// Apply a trivial clue's effect to the state. Returns false if the clue
// wasn't trivial (caller error) or didn't change anything.
function applyTrivialClue(board, state, clue, revealCell) {
	if (!isTrivial(clue)) return false;
	var prog = false;
	if (clue.hi === 0) {
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
	var maxComplexity = opts.maxComplexity != null ? opts.maxComplexity : Infinity;
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
		if (best && best.complexity <= maxComplexity) {
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
				action: best.hi === 0 ? "reveal" : "flag",
				cells: best.cells,
				changed: changed,
				lo: best.lo,
				hi: best.hi,
				depth: best.depth,
				derivation: flattenDerivation(best)
			});
			continue;
		}
		// CSP subset search exhausted — fall back to SOUND case analysis: exhaustively enumerate the
		// smallest frontier component's mine configurations (findEnumSteps) and take only the cells that
		// are safe (or mine) in EVERY consistent configuration. This reasons purely over the visible clue
		// sums and never reveals a covered cell to read its hidden number.
		//
		// NB this replaced an unsound 1-cell case-split that, in its "cell is safe" branch, REVEALED the
		// hypothetical cell and cascaded using the TRUE board clues (and `propagateBranch` likewise read
		// true clues for every cell it opened mid-branch). Because that fixes an unopened cell's clue to
		// its real value, it silently discards consistent layouts where the cell would have a different
		// clue — so it could "prove" a cell safe/mine that isn't actually forced by public information
		// (e.g. concluding a 50/50 cell is safe just because it happens to be safe on this board). Enum
		// is the sound equivalent: it only ever concludes a cell when it's forced across ALL layouts.
		var enumStep = findSmallestEnumStep(board, state);
		if (!enumStep || enumComplexity(enumStep.componentSize) > maxComplexity) break;
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
	var bundled;
	try { bundled = bundleMoves(moves); } catch (e) { console.error("bundleMoves failed:", e.message); bundled = moves; }
	return {
		solved: safeCovered === 0,
		moves: bundled,
		maxComplexity: maxC,
		totalComplexity: totalC,
		safeCovered: safeCovered
	};
}

// Group consecutive moves that draw their conclusions from the exact
// same set of initial clue cells into one logical step. A single
// overlap operation (subset / union / intersect) sometimes produces
// several trivial derivations off the same input clues — one
// flagging a cell, another revealing one. Those are conclusions of
// the same deductive idea, so the solver reports them as one move
// with both `revealed` and `flagged` populated, rather than as two
// adjacent moves that the caller has to stitch together. Case-split
// and enum moves never merge with anything else.
function bundleMoves(moves) {
	function initsKey(mv) {
		var seen = {}, keys = [];
		function visit(d) {
			if (!d) return;
			for (var i = 0; i < d.length; i++) {
				if (d[i].source === "initial" && d[i].from) {
					var k = d[i].from[0] + "," + d[i].from[1];
					if (!seen[k]) { seen[k] = true; keys.push(k); }
				}
			}
		}
		visit(mv.derivation);
		if (mv.action === "case" && mv.branches) {
			["safe", "mine"].forEach(function(side) {
				var br = mv.branches[side];
				if (br && br.moves) br.moves.forEach(function(m) { visit(m.derivation); });
			});
		}
		return keys.sort().join("|");
	}
	function methodOf(mv) {
		if (mv.action === "case") return "case";
		if (mv.action === "enum") return "enum";
		if (mv.derivation && mv.derivation.length) {
			var root = mv.derivation[mv.derivation.length - 1];
			if (root.source === "initial") return "trivial";
			return root.source;
		}
		return "trivial";
	}
	var bundles = [];
	var i = 0;
	while (i < moves.length) {
		var head = moves[i];
		var group = [head];
		var j = i + 1;
		if (head.action !== "case" && head.action !== "enum") {
			var key = initsKey(head);
			while (j < moves.length
				&& moves[j].action !== "case"
				&& moves[j].action !== "enum"
				&& initsKey(moves[j]) === key) {
				group.push(moves[j]);
				j++;
			}
		}
		var revealed = [], flagged = [];
		var maxC = 0, hardest = group[0];
		for (var g = 0; g < group.length; g++) {
			var mv = group[g];
			if (mv.complexity > maxC) { maxC = mv.complexity; hardest = mv; }
			if (mv.action === "reveal") (mv.cells || []).forEach(function(c) { revealed.push(c); });
			else if (mv.action === "flag") (mv.cells || []).forEach(function(c) { flagged.push(c); });
			else if (mv.action === "case" || mv.action === "enum") {
				(mv.revealed || []).forEach(function(c) { revealed.push(c); });
				(mv.flagged || []).forEach(function(c) { flagged.push(c); });
			}
		}
		bundles.push({
			method: methodOf(hardest),
			complexity: maxC,
			revealed: revealed,
			flagged: flagged,
			cells: revealed.concat(flagged),
			changed: revealed.concat(flagged),
			derivation: hardest.derivation,
			branches: hardest.branches,
			splitCell: hardest.splitCell,
			componentSize: hardest.componentSize,
			depth: hardest.depth,
			lo: hardest.lo,
			hi: hardest.hi,
			subMoves: group
		});
		i = j;
	}
	return bundles;
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
