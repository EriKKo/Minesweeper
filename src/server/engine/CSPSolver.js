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

var BoardLogic = require("../../common/BoardLogic");
var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN, FLAGGED = BoardLogic.FLAGGED;
var popcount = BoardLogic.popcount;
var MINE = BoardLogic.MINE;

var DEFAULT_MAX_CELLS = 8;
var DEFAULT_MAX_BBOX = 2;     // Chebyshev distance between any two cells
var DEFAULT_MAX_CLUES = 10000; // hard ceiling on the seen-set per search
var SUBSET_COST = 2.0;
var UNION_COST = 1.0;
var INTERSECT_COST = 2.5;
// Base complexity of a 1-cell case split (added to the hardest branch's propagation cost). Also the
// floor: when a maxComplexity cap is below this, case analysis is skipped entirely (capped-solve speedup).
var CASE_BASE = 8;
// Solver-internal cell state used ONLY inside case-split hypotheses: "deduced not-a-mine, clue unknown".
// A SAFE cell is removed from its neighbours' mine candidates but is NEVER revealed and its clue is NEVER
// read — that's what keeps the case-split sound (a hypothesis must not consult the hidden solution).
var SAFE = -5;
// Per-cell surcharge added to each initial clue. Counting against five
// covered cells is harder than against two; the surcharge propagates
// through every derivation since parent complexities sum.
var CELL_SURCHARGE = 0.15;  // each covered cell adds this much
// Per-flagged-neighbour surcharge on an initial clue — a flagged neighbour still costs a little to
// track (subtracting it from the number), but strictly less than a covered one: deliberately half of
// CELL_SURCHARGE, so flagging a neighbour is a *net decrease* in that origin's complexity (loses a
// full CELL_SURCHARGE off the covered count, gains only half back). This keeps the complexity model
// monotonic — placing a flag can only ever make a clue easier, never harder — which is what lets
// analyzeBoard's incremental clue store (see the persistent-store comment there) leave old clues in
// place indefinitely instead of retiring/regenerating them: a stale clue can never look cheaper than
// a fresh recomputation would.
var FLAG_BONUS = CELL_SURCHARGE / 2;
// Mine-density surcharge. Clues with mines in the middle of the range
// (e.g. "3 of 5") are harder than extremes ("0 of 5" / "5 of 5"). Add
// per unit of min(mines, cells - mines) to the initial clue cost.
var DENSITY_SURCHARGE = 0.12;
// Op cost scales with the size of the result clue — a 5-cell deduction
// is mentally heavier than a 1-cell one even at the same depth.
var RESULT_SIZE_SURCHARGE = 0.12;

function cellKey(cell) { return cell[0] + "," + cell[1]; }
function cellCompare(a, b) { return a[0] - b[0] || a[1] - b[1]; }

// Merges two already row/col-sorted, cell-disjoint arrays into one sorted array in O(n) — used by
// combineDisjointUnion instead of concat+sort, since both inputs already come pre-sorted.
function mergeSortedCells(a, b) {
	var out = new Array(a.length + b.length);
	var i = 0, j = 0, k = 0;
	while (i < a.length && j < b.length) {
		out[k++] = (cellCompare(a[i], b[j]) <= 0) ? a[i++] : b[j++];
	}
	while (i < a.length) out[k++] = a[i++];
	while (j < b.length) out[k++] = b[j++];
	return out;
}

// This sits on the hottest path in the whole solver (every combine attempt builds a clue here
// before admit() decides whether to keep it), so it's written to do the minimum necessary work:
//  - `cells` is never reused by its caller afterward (each call site builds it fresh just for this
//    call), so it's taken and sorted in place rather than defensively copied.
//  - No de-dup pass: every caller already produces a duplicate-free cell list by construction
//    (buildOriginClue visits each neighbour once; the combine ops filter/merge already-unique
//    parent cell lists), so there's never anything to de-duplicate.
//  - `alreadySorted` lets combineSubset/combineIntersection (whose results are order-preserving
//    subsequences of an already-sorted parent) skip the sort entirely; combineDisjointUnion merges
//    its two sorted inputs in O(n) (mergeSortedCells) instead of sorting the concatenation.
function makeClue(cells, lo, hi, complexity, meta, alreadySorted) {
	if (!alreadySorted) cells.sort(cellCompare);
	// Clamp bounds to the legal [0, |cells|] range.
	if (lo < 0) lo = 0;
	if (hi > cells.length) hi = cells.length;
	// Key includes bounds so "≤2 mines" and "=1 mine" on the same cells
	// are tracked as distinct deductions.
	var cellsKey = "";
	for (var i = 0; i < cells.length; i++) {
		if (i) cellsKey += ";";
		cellsKey += cells[i][0] + "," + cells[i][1];
	}
	var key = cellsKey + "|" + lo + "-" + hi;
	meta = meta || {};
	var depth = 0;
	if (meta.parents) {
		for (var p = 0; p < meta.parents.length; p++) {
			if (meta.parents[p].depth + 1 > depth) depth = meta.parents[p].depth + 1;
		}
	}
	return {
		key: key, cellsKey: cellsKey, cells: cells, lo: lo, hi: hi,
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

// The single revealed-numbered-cell -> initial-clue computation, factored out so the whole-board
// scan (buildInitialClues) and analyzeBoard's incremental per-cell discovery can share it.
function buildOriginClue(board, state, rows, cols, r, c) {
	if (state[r][c] !== KNOWN || board[r][c] <= 0) return null;
	var flagged = 0, covered = [];
	BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
		if (state[nr][nc] === FLAGGED) flagged++;
		else if (state[nr][nc] === UNKNOWN) covered.push([nr, nc]);
	});
	if (covered.length === 0) return null;
	var mines = board[r][c] - flagged;
	if (mines < 0) return null; // shouldn't happen on a consistent state
	var sizeSurcharge = CELL_SURCHARGE * covered.length;
	var densitySurcharge = DENSITY_SURCHARGE * Math.min(mines, covered.length - mines);
	return makeClue(covered, mines, mines, sizeSurcharge + densitySurcharge + FLAG_BONUS * flagged, {
		source: "initial",
		from: [r, c]
	});
}

function buildInitialClues(board, state) {
	var rows = board.length, cols = board[0].length;
	var out = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			var clue = buildOriginClue(board, state, rows, cols, r, c);
			if (clue) out.push(clue);
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
	// extras was built by scanning B.cells (already row/col-sorted) in order, so it's already sorted.
	return makeClue(extras, lo, hi, Math.max(A.complexity, B.complexity) + SUBSET_COST + sizeCost, {
		source: "subset", parents: [A, B]
	}, true);
}

function combineDisjointUnion(A, B) {
	var aSet = {};
	for (var i = 0; i < A.cells.length; i++) aSet[cellKey(A.cells[i])] = true;
	for (var j = 0; j < B.cells.length; j++) {
		if (aSet[cellKey(B.cells[j])]) return null;
	}
	var union = mergeSortedCells(A.cells, B.cells);
	var lo = A.lo + B.lo;
	var hi = A.hi + B.hi;
	if (lo === 0 && hi === union.length) return null;
	var sizeCost = RESULT_SIZE_SURCHARGE * union.length;
	return makeClue(union, lo, hi, Math.max(A.complexity, B.complexity) + UNION_COST + sizeCost, {
		source: "union", parents: [A, B]
	}, true);
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
	// inter was built by scanning B.cells (already row/col-sorted) in order, so it's already sorted.
	return makeClue(inter, lo, hi, Math.max(A.complexity, B.complexity) + INTERSECT_COST + sizeCost, {
		source: "intersect", parents: [A, B]
	}, true);
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

// Builds an admit() closure bound to a given seen/keys/heap store. Shared between
// findBestTrivialClue's one-shot store and analyzeBoard's persistent, whole-solve store.
function makeAdmitter(seen, keys, heap, opts) {
	var maxCells = opts.maxCells || DEFAULT_MAX_CELLS;
	var maxBbox = opts.maxBbox != null ? opts.maxBbox : DEFAULT_MAX_BBOX;
	var maxComplexity = opts.maxComplexity != null ? opts.maxComplexity : Infinity;
	return function admit(clue) {
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
	};
}

function findBestTrivialClue(initialClues, opts) {
	opts = opts || {};
	var maxClues = opts.maxClues || DEFAULT_MAX_CLUES;
	var seen = {}, keys = [], heap = [];
	var admit = makeAdmitter(seen, keys, heap, opts);

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

function snapshotState(state) {
	var out = new Array(state.length);
	for (var i = 0; i < state.length; i++) out[i] = state[i].slice();
	return out;
}

// Sound inconsistency check: for every revealed clue, the number of still-covered (UNKNOWN) neighbours
// must be able to hold exactly `clue - flaggedNeighbours` more mines. SAFE/KNOWN neighbours are determined
// non-mines (ignored); FLAGGED are mines. Reads only revealed clues — never an unopened cell's number.
function findInconsistency(board, state) {
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
			if (need < 0) return { clue: [r, c], why: "too many mines (need " + board[r][c] + " but " + flagged + " already flagged)" };
			if (need > covered) return { clue: [r, c], why: "not enough cells (need " + need + " more mines but only " + covered + " covered)" };
		}
	}
	return null;
}

// Apply a trivial clue inside a hypothesis: a forced-safe conclusion marks the cell SAFE (NOT revealed —
// we must not read its clue), a forced-mine conclusion flags it. Mirrors applyTrivialClue's safe/mine split.
function applyDeductionSound(state, clue) {
	var prog = false;
	var mark = (clue.hi === 0) ? SAFE : FLAGGED;
	for (var i = 0; i < clue.cells.length; i++) {
		var r = clue.cells[i][0], c = clue.cells[i][1];
		if (state[r][c] === UNKNOWN) { state[r][c] = mark; prog = true; }
	}
	return prog;
}

// Propagate a single hypothesis to a fixpoint using ONLY the visible clues. Flags forced mines and marks
// forced-safe cells SAFE; it never reveals a cell or consults board[][] for a covered cell, so it can only
// chain through the numbers the player can already see — exactly what makes the case split sound. Returns
// { contradiction, moves, maxC }.
function propagateBranchSound(board, state, opts) {
	var maxC = 0, trace = [];
	while (true) {
		var bad = findInconsistency(board, state);
		if (bad) return { contradiction: bad, moves: trace, maxC: maxC };
		var initial = buildInitialClues(board, state);
		if (!initial.length) break;
		var direct = null;
		for (var i = 0; i < initial.length; i++) {
			if (isTrivial(initial[i]) && (!direct || initial[i].complexity < direct.complexity)) direct = initial[i];
		}
		var best = direct || findBestTrivialClue(initial, opts);
		if (!best) break;
		if (best.complexity > maxC) maxC = best.complexity;
		var changed = [];
		for (var ci = 0; ci < best.cells.length; ci++) {
			if (state[best.cells[ci][0]][best.cells[ci][1]] === UNKNOWN) changed.push(best.cells[ci]);
		}
		trace.push({
			action: best.hi === 0 ? "reveal" : "flag",
			cells: best.cells,
			changed: changed,
			complexity: best.complexity,
			depth: best.depth,
			derivation: flattenDerivation(best)
		});
		if (!applyDeductionSound(state, best)) break;
	}
	return { contradiction: null, moves: trace, maxC: maxC };
}

// SOUND 1-cell case split. For each frontier cell, try both hypotheses ("safe" = mark SAFE, "mine" = flag)
// and propagate each with propagateBranchSound (visible clues only — no peeking). Conclusions:
//   - one branch contradicts  → the split cell takes the other value, plus everything that branch forced;
//   - both branches survive    → any cell determined the SAME way in BOTH is forced regardless of the split.
// Because neither branch ever reads a deduced cell's clue, every conclusion is forced by public information
// alone. Cheaper/broader than full enumeration on large frontiers, where a single hypothesis still cracks a
// contradiction that exhaustive enumeration can't reach within ENUM_CAP.
function findCaseSplitStep(board, state, opts) {
	var rows = board.length, cols = board[0].length;
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
		var pr = frontier[fi][0], pc = frontier[fi][1];

		var sA = snapshotState(state);
		sA[pr][pc] = SAFE;                 // hypothesis: split cell is safe (no reveal, no clue read)
		var resA = propagateBranchSound(board, sA, opts);

		var sB = snapshotState(state);
		sB[pr][pc] = FLAGGED;              // hypothesis: split cell is a mine
		var resB = propagateBranchSound(board, sB, opts);

		var okA = !resA.contradiction, okB = !resB.contradiction;
		if (!okA && !okB) continue; // both contradict — only on an already-inconsistent board

		var revealed = [], flagged = [];
		function gather(snap, wantSafe, wantMine) {
			for (var r2 = 0; r2 < rows; r2++) for (var c2 = 0; c2 < cols; c2++) {
				if (state[r2][c2] !== UNKNOWN || (r2 === pr && c2 === pc)) continue;
				if (wantSafe(r2, c2)) revealed.push([r2, c2]);
				else if (wantMine(r2, c2)) flagged.push([r2, c2]);
			}
		}
		if (!okA && okB) {            // "safe" impossible → split cell is a mine
			flagged.push([pr, pc]);
			gather(sB, function(r2, c2) { return sB[r2][c2] === SAFE; }, function(r2, c2) { return sB[r2][c2] === FLAGGED; });
		} else if (!okB && okA) {     // "mine" impossible → split cell is safe
			revealed.push([pr, pc]);
			gather(sA, function(r2, c2) { return sA[r2][c2] === SAFE; }, function(r2, c2) { return sA[r2][c2] === FLAGGED; });
		} else {                      // both consistent → agreement deductions
			gather(null, function(r2, c2) { return sA[r2][c2] === SAFE && sB[r2][c2] === SAFE; },
			              function(r2, c2) { return sA[r2][c2] === FLAGGED && sB[r2][c2] === FLAGGED; });
		}
		if (!revealed.length && !flagged.length) continue;
		var branchMax = Math.max(okA ? resA.maxC : 0, okB ? resB.maxC : 0);
		var complexity = CASE_BASE + branchMax;
		var yieldCount = revealed.length + flagged.length;
		if (!best || complexity < best.complexity || (complexity === best.complexity && yieldCount > best.yieldCount)) {
			best = {
				splitCell: [pr, pc],
				revealed: revealed,
				flagged: flagged,
				complexity: complexity,
				yieldCount: yieldCount,
				branches: {
					safe: { contradiction: resA.contradiction, moves: resA.moves, maxC: resA.maxC },
					mine: { contradiction: resB.contradiction, moves: resB.moves, maxC: resB.maxC }
				}
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

// A revealed clue's local constraint: its covered (UNKNOWN) neighbours and how many more mines they
// must contain. Shared primitive for the enum step + the frontier-fallback hint.
function constraintAt(board, state, r, c) {
	var rows = board.length, cols = board[0].length;
	var flagged = 0, covered = [];
	BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
		if (state[nr][nc] === FLAGGED) flagged++;
		else if (state[nr][nc] === UNKNOWN) covered.push([nr, nc]);
	});
	return { clue: board[r][c], flagged: flagged, covered: covered, need: board[r][c] - flagged };
}

// Brute-force enumeration of each frontier component (≤ ENUM_CAP cells): for every component, enumerate
// the mine assignments consistent with the visible clues and keep cells that are safe (mine in none) or
// mine (mine in all) across ALL of them. Sound and complete within the cap. Returns one step per
// component that yields a determination.
var ENUM_CAP = 18;
function findEnumSteps(board, state, opts) {
	opts = opts || {};
	var cap = opts.cap || ENUM_CAP;
	var rows = board.length, cols = board[0].length;
	var varId = {}, varList = [], raw = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			var ctx = constraintAt(board, state, r, c);
			if (!ctx.covered.length) continue;
			var ids = [];
			for (var k = 0; k < ctx.covered.length; k++) {
				var key = ctx.covered[k][0] + "," + ctx.covered[k][1];
				if (varId[key] === undefined) { varId[key] = varList.length; varList.push(ctx.covered[k]); }
				ids.push(varId[key]);
			}
			raw.push({ clueR: r, clueC: c, ids: ids, need: ctx.need });
		}
	}
	if (varList.length === 0) return [];
	var parent = [];
	for (var v = 0; v < varList.length; v++) parent.push(v);
	function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
	for (var ci = 0; ci < raw.length; ci++) {
		var idsC = raw[ci].ids;
		for (var t = 1; t < idsC.length; t++) parent[find(idsC[t])] = find(idsC[0]);
	}
	var comps = {};
	for (var w = 0; w < varList.length; w++) { var root = find(w); (comps[root] || (comps[root] = [])).push(w); }
	var steps = [];
	for (var rootKey in comps) {
		var vars = comps[rootKey];
		var k2 = vars.length;
		if (k2 > cap) continue;
		var rootKeyInt = parseInt(rootKey, 10);
		var local = {};
		for (var li = 0; li < k2; li++) local[vars[li]] = li;
		var cons = [], clueCellSet = {}, clueCells = [];
		for (var rc2 = 0; rc2 < raw.length; rc2++) {
			if (find(raw[rc2].ids[0]) !== rootKeyInt) continue;
			var mask = 0;
			for (var m = 0; m < raw[rc2].ids.length; m++) mask |= (1 << local[raw[rc2].ids[m]]);
			cons.push({ mask: mask, need: raw[rc2].need });
			var ck = raw[rc2].clueR + "," + raw[rc2].clueC;
			if (!clueCellSet[ck]) { clueCellSet[ck] = true; clueCells.push([raw[rc2].clueR, raw[rc2].clueC]); }
		}
		var orCount = new Array(k2).fill(0), solCount = 0, total = 1 << k2;
		for (var a = 0; a < total; a++) {
			var ok = true;
			for (var cc = 0; cc < cons.length; cc++) { if (popcount(a & cons[cc].mask) !== cons[cc].need) { ok = false; break; } }
			if (!ok) continue;
			solCount++;
			for (var b = 0; b < k2; b++) if (a & (1 << b)) orCount[b]++;
		}
		if (solCount === 0) continue;
		var safeCells = [], mineCells = [];
		for (var f = 0; f < k2; f++) {
			var cell = varList[vars[f]];
			if (orCount[f] === 0) safeCells.push(cell);
			else if (orCount[f] === solCount) mineCells.push(cell);
		}
		if (safeCells.length || mineCells.length) steps.push({ clueCells: clueCells, safeCells: safeCells, mineCells: mineCells, componentSize: k2 });
	}
	return steps;
}

function findSmallestEnumStep(board, state) {
	var steps = findEnumSteps(board, state);
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
	var maxClues = opts.maxClues || DEFAULT_MAX_CLUES;
	var maxComplexity = opts.maxComplexity != null ? opts.maxComplexity : Infinity;
	var rows = board.length, cols = board[0].length;
	var moves = [];

	// Persistent clue store for the whole solve, instead of rebuilding the reachable clue space
	// from scratch on every move. A derived clue is a permanently-true fact about the fixed board,
	// so it's never WRONG to leave one in place once a cell inside it resolves — but it does
	// become structurally stale: combineSubset/DisjointUnion/Intersection match on the literal
	// cell lists, so a clue that still lists an already-resolved cell can fail to line up with a
	// freshly-built (narrower) clue from another origin in ways a fresh rebuild wouldn't, and
	// bundleMoves reports a move's cell list verbatim, so returning one as an answer would leak
	// already-resolved cells into the reported output. So a stale clue is left in the store (cheap
	// — no bookkeeping to remove it) but ignored entirely — not combined from, not returned as an
	// answer — the moment any of its cells resolve (`isFresh`, below); only a clue whose entire
	// cell list is still unknown is touched again, exactly matching what a fresh per-iteration
	// rebuild would have available.
	var seen = {}, keys = [], heap = [];
	var admit = makeAdmitter(seen, keys, heap, opts);
	var prevState = [];
	for (var pr = 0; pr < rows; pr++) prevState.push(new Array(cols).fill(UNKNOWN));

	// Diffs `state` against the last-seen snapshot to find every cell that actually changed this
	// move (a plain full-board scan — cheap, and the only way to catch every cell a cascade
	// revealed, not just the ones the winning clue's own cell list named). For each changed cell
	// and its neighbours, rebuilds and (re-)admits that origin's initial clue if it's revealed and
	// numbered — covers both brand-new origins and existing ones whose covered set just narrowed.
	// `admit`'s existing key-based dedup makes re-admitting an unchanged origin a cheap no-op.
	function syncOrigins() {
		var seenCand = {}, candidates = [];
		function addCandidate(r, c) {
			var k = r + "," + c;
			if (seenCand[k]) return;
			seenCand[k] = true;
			candidates.push([r, c]);
		}
		for (var r = 0; r < rows; r++) {
			for (var c = 0; c < cols; c++) {
				if (prevState[r][c] === state[r][c]) continue;
				prevState[r][c] = state[r][c];
				addCandidate(r, c);
				BoardLogic.forEachNeighbour(r, c, rows, cols, addCandidate);
			}
		}
		for (var i = 0; i < candidates.length; i++) {
			var clue = buildOriginClue(board, state, rows, cols, candidates[i][0], candidates[i][1]);
			if (clue) admit(clue);
		}
	}

	function isFresh(clue) {
		for (var i = 0; i < clue.cells.length; i++) {
			if (state[clue.cells[i][0]][clue.cells[i][1]] !== UNKNOWN) return false;
		}
		return true;
	}

	// Best-first search over the persistent store: pop cheapest, skip anything superseded by a
	// cheaper version or stale (a cell inside it has since resolved, whether fully or partly),
	// combine with every other still-fresh key, admit results. Resumes exactly where the previous
	// call left off instead of starting over. A clue with even one resolved cell is skipped
	// entirely, not just excluded from combination: bundleMoves reports a move's raw cell list
	// verbatim (not filtered to only-still-unknown cells), so returning a partly-stale clue as the
	// answer would leak already-resolved cells into the reported revealed/flagged output. A fresh
	// rebuild never has this problem (every clue it holds is built from currently-unknown cells by
	// construction), so requiring full freshness here is what keeps the two behaviourally identical.
	function searchForTrivial() {
		while (heap.length > 0) {
			if (keys.length > maxClues) break;
			var top = heapPop(heap);
			var c = top[1];
			if (seen[c.key] !== c) continue; // a cheaper version superseded this one
			if (!isFresh(c)) continue; // stale (or fully dead) — a fresh equivalent will surface separately
			if (isTrivial(c)) return c;
			for (var k = 0; k < keys.length; k++) {
				var other = seen[keys[k]];
				if (other === c || !isFresh(other)) continue;
				admit(combineSubset(c, other));
				admit(combineSubset(other, c));
				admit(combineDisjointUnion(c, other));
				admit(combineIntersection(c, other));
			}
		}
		return null;
	}

	syncOrigins();

	while (true) {
		var best = searchForTrivial();
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
			syncOrigins();
			continue;
		}
		// CSP subset search exhausted. First try a SOUND 1-cell case split (findCaseSplitStep): hypothesise
		// the cell is safe vs a mine, propagate each branch over the VISIBLE clues only (never revealing a
		// cell or reading its hidden number), and take what a contradiction forces / both branches agree on.
		// Cheaper than full enumeration and works on frontiers larger than ENUM_CAP. Skipped below CASE_BASE.
		var caseStep = (maxComplexity >= CASE_BASE) ? findCaseSplitStep(board, state, opts) : null;
		if (caseStep && caseStep.complexity <= maxComplexity) {
			var caseRevealed = [], caseFlagged = [];
			for (var csi = 0; csi < caseStep.revealed.length; csi++) {
				var crc = caseStep.revealed[csi];
				if (state[crc[0]][crc[1]] === UNKNOWN) {
					caseRevealed.push(crc);
					// The cell is forced safe by public info, so revealing it (and cascading) is legitimate.
					if (opts.revealCell) opts.revealCell(crc[0], crc[1]); else state[crc[0]][crc[1]] = KNOWN;
				}
			}
			for (var cfi = 0; cfi < caseStep.flagged.length; cfi++) {
				var cfc = caseStep.flagged[cfi];
				if (state[cfc[0]][cfc[1]] !== FLAGGED) { caseFlagged.push(cfc); state[cfc[0]][cfc[1]] = FLAGGED; }
			}
			if (caseRevealed.length || caseFlagged.length) {
				moves.push({
					complexity: caseStep.complexity,
					action: "case",
					splitCell: caseStep.splitCell,
					cells: caseRevealed.concat(caseFlagged),
					changed: caseRevealed.concat(caseFlagged),
					revealed: caseRevealed,
					flagged: caseFlagged,
					branches: caseStep.branches
				});
				syncOrigins();
				continue;
			}
		}
		// Final fallback: exhaustively enumerate the smallest frontier component's mine configurations
		// (findEnumSteps) and take only cells that are safe/mine in EVERY consistent configuration. Like the
		// case split, this reasons purely over visible clue sums — it never reads a covered cell's number.
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
		syncOrigins();
	}
	// Solved = every safe cell is KNOWN. Mines may sit either FLAGGED or
	// UNKNOWN (they don't all need to be flagged for the player to win),
	// matching the existing analyzer's definition.
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

// Clue cells justifying a bundled move (for the hint UI's highlight). Best-effort: the initial-clue
// origins from the derivation, or the move's own clueCells (enum), or the split cell (case).
function moveClueCells(mv) {
	if (mv.clueCells && mv.clueCells.length) return mv.clueCells;
	var out = [], seen = {};
	(mv.derivation || []).forEach(function(d) {
		if (d.source === "initial" && d.from) { var k = d.from[0] + "," + d.from[1]; if (!seen[k]) { seen[k] = true; out.push(d.from); } }
	});
	if (!out.length && mv.splitCell) out.push(mv.splitCell);
	return out;
}

// Easiest forced-safe move from the current state — drives in-game hints and bot move selection. Runs
// the analyzer (optionally capped via opts.maxComplexity so bots stay under the case-split threshold),
// then returns the first move that reveals a safe cell the caller may take (opts.allow(r,c), e.g. a
// territory bot's own frontier). Falls back to the first forced-mine (flag) move if no safe reveal is
// reachable. Returns { kind, clueCells, safeCells, mineCells, componentSize } or null.
function findNextSafeStep(board, state, opts) {
	opts = opts || {};
	var R = board.length, C = board[0].length;
	var s = snapshotState(state);
	function cascade(rr, cc) {
		BoardLogic.cascadeReveal(rr, cc, R, C,
			function(r, c) { return s[r][c] === UNKNOWN; },
			function(r, c) { s[r][c] = KNOWN; return false; },
			function(r, c) { return board[r][c]; });
	}
	var res;
	try { res = analyzeBoard(board, s, { revealCell: cascade, maxComplexity: opts.maxComplexity }); }
	catch (e) { return null; }
	var allow = opts.allow, firstFlag = null;
	for (var i = 0; i < res.moves.length; i++) {
		var mv = res.moves[i];
		var revealed = mv.revealed || [];
		if (revealed.length) {
			var safe = allow ? revealed.filter(function(c) { return allow(c[0], c[1]); }) : revealed.slice();
			if (safe.length) return { kind: mv.method, clueCells: moveClueCells(mv), safeCells: safe, mineCells: [], componentSize: mv.componentSize || 0 };
		}
		if (!firstFlag && (mv.flagged || []).length) {
			firstFlag = { kind: mv.method + "-flag", clueCells: moveClueCells(mv), safeCells: [], mineCells: mv.flagged.slice(), componentSize: mv.componentSize || 0 };
		}
	}
	return firstFlag;
}

// Public API. analyzeBoard rates a whole board; findNextSafeStep returns the next
// forced move (hints + bots); constraintAt is used by the server's frontier fallback.
// Everything else (makeClue, combine*, findEnumSteps, the trivial-clue helpers, …)
// is an internal building block and intentionally not exported.
module.exports = {
	analyzeBoard: analyzeBoard,
	constraintAt: constraintAt,
	findNextSafeStep: findNextSafeStep
};
