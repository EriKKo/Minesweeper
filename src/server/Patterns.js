// Extract the minimal "first deduction" pattern from a starting
// position. The pattern captures only the clue cells that actually
// fed into the analyzer's first move, plus the cells that move
// deduced — translation- and rotation/reflection-canonicalized so
// patterns that differ only by where they sit on the board collapse
// to a single record.

var BoardLogic = require("../common/BoardLogic");
var cspSolver = require("./CSPSolver");
var KNOWN = BoardLogic.KNOWN;
var UNKNOWN = BoardLogic.UNKNOWN;

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
// both trivial-derivation and case-split-with-branches shapes).
function initsForMove(move) {
	var sink = [], seen = {};
	if (move.action === "case") {
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
function extractFirstDeductionPattern(board, state) {
	var stateCopy = state.map(function(row) { return row.slice(); });
	var result = cspSolver.analyzeBoard(board, stateCopy, {});
	if (!result.moves.length) return null;

	var firstMove = result.moves[0];
	var firstInits = initsForMove(firstMove);
	var firstKey = initsKey(firstInits);

	// Bundle move 0 plus subsequent moves that share the same init
	// source set. As soon as a move pulls in a different clue cell
	// (a new init source or one previously unused), stop.
	var bundled = [firstMove];
	for (var idx = 1; idx < result.moves.length; idx++) {
		var m = result.moves[idx];
		if (initsKey(initsForMove(m)) !== firstKey) break;
		bundled.push(m);
	}

	// Union of init sources across the bundle (all bundled moves
	// share the same set, so the firstInits list already covers it).
	var clueCells = firstInits.map(function(pos) {
		return [pos[0], pos[1], board[pos[0]][pos[1]]];
	}).filter(function(c) { return c[2] != null && c[2] > 0; });

	// Deduced cells: union across bundled moves, tagged S or M.
	var deducedCells = [];
	var deducedKey = {};
	function addDeduced(r, c, tag) {
		var k = r + "," + c;
		if (deducedKey[k]) return;
		deducedKey[k] = true;
		deducedCells.push([r, c, tag]);
	}
	bundled.forEach(function(m) {
		if (m.action === "reveal") (m.cells || []).forEach(function(c) { addDeduced(c[0], c[1], "S"); });
		else if (m.action === "flag") (m.cells || []).forEach(function(c) { addDeduced(c[0], c[1], "M"); });
		else if (m.action === "case") {
			(m.revealed || []).forEach(function(c) { addDeduced(c[0], c[1], "S"); });
			(m.flagged || []).forEach(function(c) { addDeduced(c[0], c[1], "M"); });
		}
	});

	// Constrained covered cells: UNKNOWN neighbours of input clues in
	// the original state, minus cells the bundle already deduced. The
	// splitCell of any case-split move is added explicitly in case it
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
	for (var j = 0; j < firstInits.length; j++) {
		var p = firstInits[j];
		for (var dr = -1; dr <= 1; dr++) {
			for (var dc = -1; dc <= 1; dc++) {
				if (dr === 0 && dc === 0) continue;
				addCovered(p[0] + dr, p[1] + dc);
			}
		}
	}
	bundled.forEach(function(m) {
		if (m.action === "case" && m.splitCell) addCovered(m.splitCell[0], m.splitCell[1]);
	});

	// Method = derivation operation of the hardest move in the bundle.
	// For trivial derivations the root step has source="initial"; we
	// surface that as "trivial". Case-split and enum moves have their
	// own labels. Whether the move happened to flag, reveal, or do
	// both falls out of the cells; we don't separate "mixed" because
	// an overlap operation that yields cells of both kinds is still
	// the same operation type.
	function methodFor(m) {
		if (m.action === "case") return "case";
		if (m.action === "enum") return "enum";
		if (m.derivation && m.derivation.length) {
			var root = m.derivation[m.derivation.length - 1];
			if (root.source === "initial") return "trivial";
			return root.source; // "subset" | "union" | "intersect"
		}
		return "trivial";
	}
	var hardest = bundled[0];
	for (var b = 1; b < bundled.length; b++) {
		if (bundled[b].complexity > hardest.complexity) hardest = bundled[b];
	}
	var method = methodFor(hardest);
	var maxComplexity = hardest.complexity;
	for (var b2 = 0; b2 < bundled.length; b2++) {
		if (bundled[b2].complexity > maxComplexity) maxComplexity = bundled[b2].complexity;
	}

	return {
		method: method,
		complexity: maxComplexity,
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
	var minR = Infinity, minC = Infinity;
	clues.concat(deduced, covered).forEach(function(c) {
		if (c[0] < minR) minR = c[0];
		if (c[1] < minC) minC = c[1];
	});
	function shift(c) { return [c[0] - minR, c[1] - minC, c[2]]; }
	return {
		clueCells: clues.map(shift),
		deducedCells: deduced.map(shift),
		coveredCells: covered.map(shift),
		method: pattern.method,
		complexity: pattern.complexity
	};
}

// Canonical key — the lex-smallest serialization over all 8 dihedral
// variants. Cells in each variant are sorted before joining so the
// ordering of the inputs doesn't influence the key. Each cell-kind
// prefix (C/D/X) keeps clue, deduced, and ambiguous covered cells
// distinct in the key.
function patternKey(pattern) {
	var parts = [];
	pattern.clueCells.forEach(function(c) { parts.push("C" + c[0] + "," + c[1] + ":" + c[2]); });
	pattern.deducedCells.forEach(function(c) { parts.push("D" + c[0] + "," + c[1] + ":" + c[2]); });
	(pattern.coveredCells || []).forEach(function(c) { parts.push("X" + c[0] + "," + c[1]); });
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
	pattern.clueCells.concat(pattern.deducedCells, pattern.coveredCells || []).forEach(function(c) {
		if (c[0] > maxR) maxR = c[0];
		if (c[1] > maxC) maxC = c[1];
	});
	return { height: maxR + 1, width: maxC + 1 };
}

function scoreToRating(score) { return Math.max(0, Math.round(240 * (score - 0.5))); }

// Build the (board, state) pair for a 3x3 starting position given its
// pattern (e.g. "1.1.1.1.2.2.2.2") and ask the analyzer for the first
// move. Returns the canonical pattern object, or null on no-move.
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
	// Clockwise from (1,1): (1,1), (1,2), (1,3), (2,3), (3,3), (3,2), (3,1), (2,1)
	var BOUND = [[1,1],[1,2],[1,3],[2,3],[3,3],[3,2],[3,1],[2,1]];
	for (var i = 0; i < 8; i++) board[BOUND[i][0]][BOUND[i][1]] = clues[i];
	var raw = extractFirstDeductionPattern(board, state);
	if (!raw) return null;
	var canon = canonicalize(raw);
	var bb = patternBoundingBox(canon);
	canon.width = bb.width;
	canon.height = bb.height;
	canon.rating = scoreToRating(canon.complexity);
	return canon;
}

module.exports = {
	extractFirstDeductionPattern: extractFirstDeductionPattern,
	canonicalize: canonicalize,
	patternKey: patternKey,
	extract3x3PatternFromClues: extract3x3PatternFromClues
};
