// Extract the minimal "first deduction" pattern from a starting
// position. The pattern captures only the clue cells that actually
// fed into the analyzer's first move, plus the cells that move
// deduced — translation- and rotation/reflection-canonicalized so
// patterns that differ only by where they sit on the board collapse
// to a single record.

var BoardLogic = require("../common/BoardLogic");
var cspSolver = require("./CSPSolver");
var puzzleGen = require("./PuzzleGenerator");
var KNOWN = BoardLogic.KNOWN;
var UNKNOWN = BoardLogic.UNKNOWN;
var FLAGGED = BoardLogic.FLAGGED;

// Walk a derivation chain and collect the (r, c) positions of every
// initial-clue leaf, deduped.
function initSourcesFromDerivation(derivation, sink, seen) {
	for (var i = 0; i < derivation.length; i++) {
		var step = derivation[i];
		if (step.source === "initial" && step.from) {
			var k = step.from[0] + "," + step.from[1];
			if (!seen[k]) { seen[k] = true; sink.push(step.from); }
		}
	}
}

// Case-split moves have two branches with their own move sequences,
// each with its own derivation chain. The set of initial clues that
// participate in EITHER branch's proof is the full set of clues the
// analyzer relied on for this case-split.
function initSourcesFromBranches(branches, sink, seen) {
	["safe", "mine"].forEach(function(side) {
		var br = branches && branches[side];
		if (!br || !br.moves) return;
		for (var i = 0; i < br.moves.length; i++) {
			var m = br.moves[i];
			if (m.derivation) initSourcesFromDerivation(m.derivation, sink, seen);
		}
	});
}

// Collect the init source clue cells that fed a single move (handles
// both trivial-derivation and case-split-with-branches shapes). The
// move's `method` field marks case-split bundles; everything else
// carries the derivation chain directly.
function initsForMove(move) {
	var sink = [], seen = {};
	if (move.method === "case") {
		initSourcesFromBranches(move.branches, sink, seen);
	} else if (move.derivation) {
		initSourcesFromDerivation(move.derivation, sink, seen);
	}
	return sink;
}

// Stable serialization of an init-source set so we can compare across
// moves. Two moves share a deduction context iff they have the same
// sorted set of init source cells.
function initsKey(inits) {
	return inits.map(function(p) { return p[0] + "," + p[1]; }).sort().join("|");
}

// Build the pattern object for the analyzer's first deduction on
// (board, state). The "first deduction" is the leading run of moves
// that all draw from the same set of init source clues — typically
// move 0 and any immediate follow-up moves that reuse the same clue
// cells. Subsequent deductions that bring in new clue cells start a
// different deduction shape and are not bundled here.
//
// The pattern carries three kinds of cells:
//   * clueCells   — revealed clue cells with their values; the inputs
//                   the bundled moves all consumed.
//   * deducedCells — every cell the bundled moves forced ("S" safe,
//                   "M" mine). A pattern can mix safes and mines if
//                   the bundle spans a reveal *and* a flag.
//   * coveredCells — the rest of the cells those clues constrain
//                   (UNKNOWN neighbours of the input clues that aren't
//                   in the deduced set). They're geometrically part of
//                   the pattern even when the bundled moves don't
//                   decide them.
// Extract a deduction pattern for a single move on (board, state).
// The state reflects what's KNOWN/FLAGGED/UNKNOWN BEFORE the move is
// applied, which matters for general puzzles where prior moves have
// flagged some neighbours. Clue values come out as effective values
// (raw clue − pre-flagged neighbours) so two configurations that
// reach the same logical constraint collapse to the same pattern.
// Walls are added for every off-board position adjacent to an input
// clue, so the canonical form distinguishes corner / edge / interior
// clue placements.
function extractMovePattern(board, state, move) {
	var rows = board.length, cols = board[0].length;

	// Init-source clues. We use the derivation's stored lo (== hi for
	// initial steps) as the effective clue value — the analyzer has
	// already subtracted any pre-flagged neighbours from it.
	var inits = [];
	var seenInit = {};
	function visit(d) {
		if (!d) return;
		for (var i = 0; i < d.length; i++) {
			var s = d[i];
			if (s.source !== "initial" || !s.from) continue;
			var k = s.from[0] + "," + s.from[1];
			if (seenInit[k]) continue;
			seenInit[k] = true;
			inits.push({ pos: s.from, value: s.lo });
		}
	}
	visit(move.derivation);
	if (move.method === "case" && move.branches) {
		["safe", "mine"].forEach(function(side) {
			var br = move.branches[side];
			if (br && br.moves) br.moves.forEach(function(m) { visit(m.derivation); });
		});
	}
	if (inits.length === 0) return null;

	var clueCells = inits.map(function(s) { return [s.pos[0], s.pos[1], s.value]; })
		.filter(function(c) { return c[2] != null && c[2] >= 0; });

	var deducedCells = [];
	var deducedKey = {};
	(move.revealed || []).forEach(function(c) {
		var k = c[0] + "," + c[1];
		if (deducedKey[k]) return;
		deducedKey[k] = true;
		deducedCells.push([c[0], c[1], "S"]);
	});
	(move.flagged || []).forEach(function(c) {
		var k = c[0] + "," + c[1];
		if (deducedKey[k]) return;
		deducedKey[k] = true;
		deducedCells.push([c[0], c[1], "M"]);
	});

	var coveredCells = [];
	var coveredKey = {};
	var wallCells = [];
	var wallKey = {};
	function addCovered(r, c) {
		if (state[r][c] !== UNKNOWN) return;
		var k = r + "," + c;
		if (coveredKey[k] || deducedKey[k]) return;
		coveredKey[k] = true;
		coveredCells.push([r, c, "?"]);
	}
	function addWall(r, c) {
		var k = r + "," + c;
		if (wallKey[k]) return;
		wallKey[k] = true;
		wallCells.push([r, c, "W"]);
	}
	for (var i = 0; i < inits.length; i++) {
		var p = inits[i].pos;
		for (var dr = -1; dr <= 1; dr++) {
			for (var dc = -1; dc <= 1; dc++) {
				if (dr === 0 && dc === 0) continue;
				var nr = p[0] + dr, nc = p[1] + dc;
				if (nr >= 0 && nc >= 0 && nr < rows && nc < cols) addCovered(nr, nc);
				else addWall(nr, nc);
			}
		}
	}
	if (move.method === "case" && move.splitCell) {
		var sc = move.splitCell;
		if (sc[0] >= 0 && sc[0] < rows && sc[1] >= 0 && sc[1] < cols) addCovered(sc[0], sc[1]);
	}

	var canon = canonicalize({
		method: move.method || "trivial",
		complexity: move.complexity,
		clueCells: clueCells,
		deducedCells: deducedCells,
		coveredCells: coveredCells,
		wallCells: wallCells
	});
	var bb = patternBoundingBox(canon);
	canon.width = bb.width;
	canon.height = bb.height;
	canon.rating = scoreToRating(canon.complexity);
	return canon;
}

// Walk every move of a puzzle's analyzer trace, extracting each move's
// pattern using the state just before that move was applied. Returns
// an array of canonical patterns.
function extractPatternsFromPuzzle(rows, cols, mines, revealed) {
	var board = puzzleGen.buildBoard(rows, cols, mines);

	// Tracking state used for pattern extraction. Starts at the
	// puzzle's initial revealed set, then advances move-by-move so
	// each pattern sees the state immediately before its move runs.
	var trackingState = new Array(rows);
	for (var r = 0; r < rows; r++) trackingState[r] = new Array(cols).fill(UNKNOWN);
	function cascadeIn(state, r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			function(rr, cc) { return state[rr][cc] === UNKNOWN; },
			function(rr, cc) { state[rr][cc] = KNOWN; return false; },
			function(rr, cc) { return board[rr][cc]; }
		);
	}
	revealed.forEach(function(p) { trackingState[p[0]][p[1]] = KNOWN; });
	revealed.forEach(function(p) { cascadeIn(trackingState, p[0], p[1]); });

	// Separate state for the analyzer — its revealCell callback MUST
	// mutate the state the analyzer is iterating over, or the
	// analyzer's loop never sees its own deductions apply and it
	// spins forever on the same constraint.
	var analyzerState = trackingState.map(function(row) { return row.slice(); });
	function analyzerCascade(r, c) { cascadeIn(analyzerState, r, c); }
	var result = cspSolver.analyzeBoard(board, analyzerState, { revealCell: analyzerCascade });

	var patterns = [];
	for (var m = 0; m < result.moves.length; m++) {
		var move = result.moves[m];
		var pat = extractMovePattern(board, trackingState, move);
		if (pat) patterns.push(pat);
		// Advance tracking state to mirror what the analyzer just did.
		(move.revealed || []).forEach(function(c) {
			if (board[c[0]][c[1]] === 0) cascadeIn(trackingState, c[0], c[1]);
			else trackingState[c[0]][c[1]] = KNOWN;
		});
		(move.flagged || []).forEach(function(c) { trackingState[c[0]][c[1]] = FLAGGED; });
	}
	return patterns;
}

function extractFirstDeductionPattern(board, state) {
	var stateCopy = state.map(function(row) { return row.slice(); });
	var result = cspSolver.analyzeBoard(board, stateCopy, {});
	if (!result.moves.length) return null;

	// The solver returns bundled moves: a single overlap operation
	// that produces both safes and mines is already one move with
	// both lists populated, and `method` is already set.
	var move = result.moves[0];
	var inits = initsForMove(move);

	var clueCells = inits.map(function(pos) {
		return [pos[0], pos[1], board[pos[0]][pos[1]]];
	}).filter(function(c) { return c[2] != null && c[2] > 0; });

	var deducedCells = [];
	var deducedKey = {};
	(move.revealed || []).forEach(function(c) {
		var k = c[0] + "," + c[1];
		if (deducedKey[k]) return;
		deducedKey[k] = true;
		deducedCells.push([c[0], c[1], "S"]);
	});
	(move.flagged || []).forEach(function(c) {
		var k = c[0] + "," + c[1];
		if (deducedKey[k]) return;
		deducedKey[k] = true;
		deducedCells.push([c[0], c[1], "M"]);
	});

	// Constrained covered cells: UNKNOWN neighbours of input clues in
	// the original state, minus cells the move already deduced. The
	// splitCell of a case-split move is added explicitly in case it
	// wasn't a direct neighbour of an init source.
	var rows = state.length, cols = state[0].length;
	var coveredCells = [];
	var coveredKey = {};
	function addCovered(r, c) {
		if (r < 0 || c < 0 || r >= rows || c >= cols) return;
		if (state[r][c] !== UNKNOWN) return;
		var k = r + "," + c;
		if (coveredKey[k] || deducedKey[k]) return;
		coveredKey[k] = true;
		coveredCells.push([r, c, "?"]);
	}
	for (var j = 0; j < inits.length; j++) {
		var p = inits[j];
		for (var dr = -1; dr <= 1; dr++) {
			for (var dc = -1; dc <= 1; dc++) {
				if (dr === 0 && dc === 0) continue;
				addCovered(p[0] + dr, p[1] + dc);
			}
		}
	}
	if (move.method === "case" && move.splitCell) addCovered(move.splitCell[0], move.splitCell[1]);

	return {
		method: move.method || "trivial",
		complexity: move.complexity,
		clueCells: clueCells,
		deducedCells: deducedCells,
		coveredCells: coveredCells
	};
}

// Eight dihedral transformations of a point (r, c). After applying any
// transformation we re-translate the resulting cell set to origin so
// canonical forms compare cleanly.
function transform(r, c, t) {
	switch (t) {
		case 0: return [r, c];
		case 1: return [c, -r];     // 90° CW
		case 2: return [-r, -c];    // 180°
		case 3: return [-c, r];     // 270° CW
		case 4: return [r, -c];     // hflip
		case 5: return [c, r];      // transpose (hflip + 90°)
		case 6: return [-r, c];     // vflip (hflip + 180°)
		case 7: return [-c, -r];    // anti-transpose (hflip + 270°)
	}
	return [r, c];
}

function transformAndNormalize(pattern, t) {
	function tx(x) {
		var p = transform(x[0], x[1], t);
		return [p[0], p[1], x[2]];
	}
	var clues = pattern.clueCells.map(tx);
	var deduced = pattern.deducedCells.map(tx);
	var covered = (pattern.coveredCells || []).map(tx);
	var walls = (pattern.wallCells || []).map(tx);
	var minR = Infinity, minC = Infinity;
	clues.concat(deduced, covered, walls).forEach(function(c) {
		if (c[0] < minR) minR = c[0];
		if (c[1] < minC) minC = c[1];
	});
	function shift(c) { return [c[0] - minR, c[1] - minC, c[2]]; }
	return {
		clueCells: clues.map(shift),
		deducedCells: deduced.map(shift),
		coveredCells: covered.map(shift),
		wallCells: walls.map(shift),
		method: pattern.method,
		complexity: pattern.complexity
	};
}

// Canonical key — the lex-smallest serialization over all 8 dihedral
// variants. Cells in each variant are sorted before joining so the
// ordering of the inputs doesn't influence the key. The four cell
// kinds — clue (C), deduced (D), ambiguous-covered (X), wall (W) —
// each carry their own prefix so the canonicalization preserves
// corner/edge geometry: a clue with three off-board neighbours
// always reads as distinct from an interior clue with three covered
// neighbours, because the W cells participate in the bbox and the key.
function patternKey(pattern) {
	var parts = [];
	pattern.clueCells.forEach(function(c) { parts.push("C" + c[0] + "," + c[1] + ":" + c[2]); });
	pattern.deducedCells.forEach(function(c) { parts.push("D" + c[0] + "," + c[1] + ":" + c[2]); });
	(pattern.coveredCells || []).forEach(function(c) { parts.push("X" + c[0] + "," + c[1]); });
	(pattern.wallCells || []).forEach(function(c) { parts.push("W" + c[0] + "," + c[1]); });
	parts.sort();
	return parts.join(";");
}

function canonicalize(pattern) {
	var best = null;
	var bestKey = null;
	for (var t = 0; t < 8; t++) {
		var v = transformAndNormalize(pattern, t);
		var k = patternKey(v);
		if (bestKey == null || k < bestKey) {
			bestKey = k;
			best = v;
			best.key = k;
		}
	}
	return best;
}

function patternBoundingBox(pattern) {
	var maxR = 0, maxC = 0;
	pattern.clueCells.concat(pattern.deducedCells, pattern.coveredCells || [], pattern.wallCells || []).forEach(function(c) {
		if (c[0] > maxR) maxR = c[0];
		if (c[1] > maxC) maxC = c[1];
	});
	return { height: maxR + 1, width: maxC + 1 };
}

function scoreToRating(score) { return Math.max(0, Math.round(240 * (score - 0.5))); }

// Boundary cell positions in the 5x5-with-3x3-cascade setup,
// clockwise from (1,1). Their bitmask of outside-neighbour cells in
// the 16-cell ring lives in StartingPositions.MASK_3x3 — duplicated
// here so we don't introduce a require cycle.
var BOUNDARY_3x3 = [
	[1,1], [1,2], [1,3], [2,3], [3,3], [3,2], [3,1], [2,1]
];
var MASK_3x3 = (function() {
	var out = [];
	function outsideIndex(r, c) {
		if (r === 0) return c;
		if (r === 4) return 11 + c;
		if (c === 0) return 5 + (r - 1);
		if (c === 4) return 8 + (r - 1);
		return -1;
	}
	BOUNDARY_3x3.forEach(function(b) {
		var m = 0;
		for (var dr = -1; dr <= 1; dr++) {
			for (var dc = -1; dc <= 1; dc++) {
				if (dr === 0 && dc === 0) continue;
				var nr = b[0] + dr, nc = b[1] + dc;
				if (nr < 0 || nc < 0 || nr >= 5 || nc >= 5) continue;
				var idx = outsideIndex(nr, nc);
				if (idx < 0) continue;
				m |= (1 << idx);
			}
		}
		out.push(m);
	});
	return out;
})();

function outsideCellFromIndex(idx) {
	if (idx <= 4) return [0, idx];
	if (idx <= 7) return [idx - 4, 0];
	if (idx <= 10) return [idx - 7, 4];
	return [4, idx - 11];
}

function popcount32(x) {
	x = x - ((x >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Given the 8 boundary clue values and a bitmask of clue indices to
// keep "active", brute-force every mine arrangement of the 16-cell
// ring that satisfies those clues. Returns the always-mine and
// always-safe bitmasks. Returns null when no arrangement is consistent.
function bruteForceWithMask(clues, activeMask) {
	var total = 1 << 16;
	var solCount = 0;
	var orCount = new Array(16).fill(0);
	for (var a = 0; a < total; a++) {
		var ok = true;
		for (var c = 0; c < 8; c++) {
			if (!(activeMask & (1 << c))) continue;
			if (popcount32(a & MASK_3x3[c]) !== clues[c]) { ok = false; break; }
		}
		if (!ok) continue;
		solCount++;
		for (var b = 0; b < 16; b++) if (a & (1 << b)) orCount[b]++;
	}
	if (solCount === 0) return null;
	var safeMask = 0, mineMask = 0;
	for (var k = 0; k < 16; k++) {
		if (orCount[k] === 0) safeMask |= (1 << k);
		else if (orCount[k] === solCount) mineMask |= (1 << k);
	}
	return { safeMask: safeMask, mineMask: mineMask };
}

function boundaryIndexOf(r, c) {
	for (var i = 0; i < BOUNDARY_3x3.length; i++) {
		if (BOUNDARY_3x3[i][0] === r && BOUNDARY_3x3[i][1] === c) return i;
	}
	return -1;
}

// Build the (board, state) pair for a 3x3 starting position given its
// pattern (e.g. "1.1.1.1.2.2.2.2") and ask the analyzer for the first
// move. The canonical pattern's deduction is the COMPLETE set of cells
// the init-source clues force on their own — derived via a brute-force
// pass that ignores every other clue in the cascade. This way two
// starting positions that hand the analyzer the same input clues
// always produce the same pattern, regardless of which forced cells
// the analyzer's bundling happened to extract in context.
function extract3x3PatternFromClues(clues) {
	var board = [], state = [];
	for (var r = 0; r < 5; r++) {
		board.push(new Array(5).fill(null));
		state.push(new Array(5).fill(UNKNOWN));
	}
	for (var rr = 1; rr <= 3; rr++) {
		for (var cc = 1; cc <= 3; cc++) state[rr][cc] = KNOWN;
	}
	board[2][2] = 0;
	for (var i = 0; i < 8; i++) board[BOUNDARY_3x3[i][0]][BOUNDARY_3x3[i][1]] = clues[i];

	var raw = extractFirstDeductionPattern(board, state);
	if (!raw) return null;

	// Determine which boundary clues are in scope for the deduction.
	// Trivial / subset / intersect / union derivations work from a
	// specific subset of the clues — exactly the init sources the
	// analyzer's derivation chain identified. Case-split, in contrast,
	// is a global inference: it propagates over every constraint, even
	// if the recorded "init sources" only call out the clues that
	// participated in a contradictory branch. So for case patterns we
	// activate all eight boundary clues.
	var clueCellsForPattern = raw.clueCells;
	var activeMask = 0;
	if (raw.method === "case") {
		activeMask = 0xFF;
		clueCellsForPattern = BOUNDARY_3x3.map(function(b, i) { return [b[0], b[1], clues[i]]; });
	} else {
		for (var j = 0; j < raw.clueCells.length; j++) {
			var idx = boundaryIndexOf(raw.clueCells[j][0], raw.clueCells[j][1]);
			if (idx >= 0) activeMask |= (1 << idx);
		}
	}
	var bf = bruteForceWithMask(clues, activeMask);
	if (!bf) return null;

	// Rebuild deducedCells from the brute-force result.
	var deducedCells = [];
	for (var k = 0; k < 16; k++) {
		var bit = 1 << k;
		var cell = outsideCellFromIndex(k);
		if (bf.safeMask & bit) deducedCells.push([cell[0], cell[1], "S"]);
		else if (bf.mineMask & bit) deducedCells.push([cell[0], cell[1], "M"]);
	}
	var deducedKey = {};
	deducedCells.forEach(function(c) { deducedKey[c[0] + "," + c[1]] = true; });

	// Covered context: UNKNOWN neighbours of the active clue cells
	// that the deduction didn't decide. Inside-cascade cells (rows 1-3,
	// cols 1-3) are revealed, so skip them.
	var coveredCells = [];
	var coveredKey = {};
	for (var ci = 0; ci < clueCellsForPattern.length; ci++) {
		var cp = clueCellsForPattern[ci];
		for (var dr = -1; dr <= 1; dr++) {
			for (var dc = -1; dc <= 1; dc++) {
				if (dr === 0 && dc === 0) continue;
				var nr = cp[0] + dr, nc = cp[1] + dc;
				if (nr < 0 || nc < 0 || nr >= 5 || nc >= 5) continue;
				if (nr >= 1 && nr <= 3 && nc >= 1 && nc <= 3) continue;
				var ck = nr + "," + nc;
				if (deducedKey[ck] || coveredKey[ck]) continue;
				coveredKey[ck] = true;
				coveredCells.push([nr, nc, "?"]);
			}
		}
	}

	var canon = canonicalize({
		method: raw.method,
		complexity: raw.complexity,
		clueCells: clueCellsForPattern,
		deducedCells: deducedCells,
		coveredCells: coveredCells
	});
	var bb = patternBoundingBox(canon);
	canon.width = bb.width;
	canon.height = bb.height;
	canon.rating = scoreToRating(canon.complexity);
	return canon;
}

module.exports = {
	extractFirstDeductionPattern: extractFirstDeductionPattern,
	extractMovePattern: extractMovePattern,
	extractPatternsFromPuzzle: extractPatternsFromPuzzle,
	canonicalize: canonicalize,
	patternKey: patternKey,
	extract3x3PatternFromClues: extract3x3PatternFromClues
};
