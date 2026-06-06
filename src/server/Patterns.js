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

// Build the pattern object for the analyzer's first move on (board, state).
// Returns null if the analyzer can't move at all.
//
// The pattern carries three kinds of cells:
//   * clueCells   — revealed clue cells with their values; the inputs
//                   the analyzer's first move actually consumed.
//   * deducedCells — the cells the move forces ("S" safe / "M" mine).
//   * coveredCells — the rest of the cells those clues *constrain*
//                   (UNKNOWN neighbours of the input clues that aren't
//                   in the deduced set). They're geometrically part of
//                   the pattern even though this single move doesn't
//                   decide them.
function extractFirstDeductionPattern(board, state) {
	var stateCopy = state.map(function(row) { return row.slice(); });
	var result = cspSolver.analyzeBoard(board, stateCopy, {});
	if (!result.moves.length) return null;
	var move = result.moves[0];

	var clueCellList = [];
	var seen = {};
	if (move.action === "case") {
		initSourcesFromBranches(move.branches, clueCellList, seen);
	} else if (move.derivation) {
		initSourcesFromDerivation(move.derivation, clueCellList, seen);
	}

	// Attach clue values from the board.
	var clueCells = [];
	for (var i = 0; i < clueCellList.length; i++) {
		var pos = clueCellList[i];
		var v = board[pos[0]][pos[1]];
		if (v != null && v > 0) clueCells.push([pos[0], pos[1], v]);
	}

	// Deduced cells: revealed (becomes safe) or flagged (becomes mine).
	var deducedCells = [];
	var deducedKey = {};
	function addDeduced(r, c, tag) {
		var k = r + "," + c;
		if (deducedKey[k]) return;
		deducedKey[k] = true;
		deducedCells.push([r, c, tag]);
	}
	if (move.action === "reveal") {
		(move.cells || []).forEach(function(c) { addDeduced(c[0], c[1], "S"); });
	} else if (move.action === "flag") {
		(move.cells || []).forEach(function(c) { addDeduced(c[0], c[1], "M"); });
	} else if (move.action === "case") {
		(move.revealed || []).forEach(function(c) { addDeduced(c[0], c[1], "S"); });
		(move.flagged || []).forEach(function(c) { addDeduced(c[0], c[1], "M"); });
	}

	// Constrained covered cells: UNKNOWN neighbours of every input clue
	// cell, minus the ones already in the deduced set. For case-split
	// moves the splitCell is also part of the pattern even if it
	// happens not to be in the neighbour set of an init source.
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
	for (var j = 0; j < clueCellList.length; j++) {
		var p = clueCellList[j];
		for (var dr = -1; dr <= 1; dr++) {
			for (var dc = -1; dc <= 1; dc++) {
				if (dr === 0 && dc === 0) continue;
				addCovered(p[0] + dr, p[1] + dc);
			}
		}
	}
	if (move.action === "case" && move.splitCell) {
		addCovered(move.splitCell[0], move.splitCell[1]);
	}

	return {
		action: move.action,
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
		action: pattern.action,
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
