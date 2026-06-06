// Enumeration of 3x3 starting-cascade configurations.
//
// A "starting position" is the state the player sees when a cascade
// opens up — for the 3x3 case, a 9-cell square where the center is a
// clue=0 cell and the 8 surrounding cells are revealed with their own
// clue values. The clue values are determined by mines in the
// surrounding ring (the cells just outside the 3x3).
//
// This module enumerates every possible clue tuple for the 8 boundary
// cells, brute-forces the 2^16 mine arrangements in the outer ring to
// check consistency, and records those that have at least one forced
// safe cell (a cell whose status is "safe" across all consistent
// arrangements). Each record carries the analyzer's first-move
// complexity as its difficulty rating.
//
// Coordinate convention: the 3x3 cascade sits at the center of a 5x5
// board (rows/cols 1..3). The center is (2,2). The 8 boundary cells
// (clockwise from top-left) are at (1,1), (1,2), (1,3), (2,3), (3,3),
// (3,2), (3,1), (2,1). The "outer ring" is the 16 cells of the 5x5
// minus the 3x3 center.

var BoardLogic = require("../common/BoardLogic");
var cspSolver = require("./CSPSolver");
var KNOWN = BoardLogic.KNOWN;
var UNKNOWN = BoardLogic.UNKNOWN;

// 16-bit index for cells in the outer ring of the 5x5.
//   row 0:  cols 0..4 → indices 0..4
//   col 0:  rows 1..3 → indices 5..7
//   col 4:  rows 1..3 → indices 8..10
//   row 4:  cols 0..4 → indices 11..15
function outsideIndex(r, c) {
	if (r === 0) return c;
	if (r === 4) return 11 + c;
	if (c === 0) return 5 + (r - 1);
	if (c === 4) return 8 + (r - 1);
	return -1;
}

// Boundary cells in clockwise order from top-left of the 3x3.
var BOUNDARY_3x3 = [
	[1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [2, 1]
];

// Pre-compute, for each boundary cell, the bitmask of outer-ring cells
// in its neighbourhood, plus the maximum clue value (= the cell count).
var MASK_3x3 = [];
var MAX_CLUE_3x3 = [];
for (var bi = 0; bi < BOUNDARY_3x3.length; bi++) {
	var br = BOUNDARY_3x3[bi][0], bc = BOUNDARY_3x3[bi][1];
	var mask = 0, count = 0;
	for (var dr = -1; dr <= 1; dr++) {
		for (var dc = -1; dc <= 1; dc++) {
			if (dr === 0 && dc === 0) continue;
			var nr = br + dr, nc = bc + dc;
			if (nr < 0 || nc < 0 || nr >= 5 || nc >= 5) continue;
			var idx = outsideIndex(nr, nc);
			if (idx < 0) continue;
			mask |= (1 << idx);
			count++;
		}
	}
	MASK_3x3.push(mask);
	MAX_CLUE_3x3.push(count);
}

function popcount(x) {
	x = x - ((x >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Dihedral-8 symmetry on the 3x3 boundary tuple. Tuple positions
// correspond to boundary cells in clockwise order from (1,1):
// indices 0..7 = (1,1), (1,2), (1,3), (2,3), (3,3), (3,2), (3,1), (2,1).
// A 90° clockwise board rotation maps cell (1,1) to (1,3), so the
// rotated tuple's index 0 is the original tuple's index 6. The full
// rotation thus shifts the tuple by 2 positions (one corner+edge).
function rotate90CW(t) {
	return [t[6], t[7], t[0], t[1], t[2], t[3], t[4], t[5]];
}
// Horizontal flip swaps the two sides while leaving the vertical
// midline fixed.
function hflip(t) {
	return [t[2], t[1], t[0], t[7], t[6], t[5], t[4], t[3]];
}

// Return the lexicographically smallest of the eight dihedral
// variants of `t`. Use this as the canonical key when storing
// patterns so symmetric duplicates collapse to a single row.
function canonical3x3(t) {
	var best = t;
	var current = t;
	for (var i = 0; i < 3; i++) {
		current = rotate90CW(current);
		if (compareTuple(current, best) < 0) best = current;
	}
	current = hflip(t);
	if (compareTuple(current, best) < 0) best = current;
	for (var j = 0; j < 3; j++) {
		current = rotate90CW(current);
		if (compareTuple(current, best) < 0) best = current;
	}
	return best;
}

function compareTuple(a, b) {
	for (var i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

// Brute-force every mine arrangement of the 16-cell outer ring and
// return solution count plus per-cell "always-mine" / "always-safe"
// bitmasks. `skipClueMask` is a bitmask over the 8 boundary clues —
// any bit set means "ignore this clue's constraint" (used to test
// whether a clue is essential to the deduction). Returns null if no
// arrangement is consistent with the (non-skipped) clues.
function bruteForce3x3(clues, skipClueMask) {
	skipClueMask = skipClueMask || 0;
	var total = 1 << 16;
	var solCount = 0;
	var orCount = new Array(16).fill(0);
	for (var a = 0; a < total; a++) {
		var ok = true;
		for (var c = 0; c < 8; c++) {
			if (skipClueMask & (1 << c)) continue;
			if (popcount(a & MASK_3x3[c]) !== clues[c]) { ok = false; break; }
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
	return {
		solCount: solCount,
		forcedSafe: popcount(safeMask),
		forcedMine: popcount(mineMask),
		forcedSafeMask: safeMask,
		forcedMineMask: mineMask
	};
}

// A clue is "removable" iff dropping its constraint leaves the
// deduction set unchanged. A pattern is "prime" iff every clue is
// essential — i.e. no clue is removable. Returns { isPrime,
// removableMask } where removableMask flags the redundant clues
// (bit i = 1 means clue i can be dropped).
function primeAnalysis3x3(clues, fullSafeMask, fullMineMask) {
	var removableMask = 0;
	for (var i = 0; i < 8; i++) {
		var bf = bruteForce3x3(clues, 1 << i);
		if (!bf) continue;
		if (bf.forcedSafeMask === fullSafeMask && bf.forcedMineMask === fullMineMask) {
			removableMask |= (1 << i);
		}
	}
	return { isPrime: removableMask === 0, removableMask: removableMask };
}

// Build a 5x5 board/state with the cascade in the centre and the
// given clue tuple, then ask the analyzer what move it would make.
// Returns { firstAction, firstComplexity } or null if the analyzer
// finds nothing.
function rate3x3(clues) {
	var rows = 5, cols = 5;
	var board = new Array(rows);
	var state = new Array(rows);
	for (var r = 0; r < rows; r++) {
		board[r] = new Array(cols).fill(null);
		state[r] = new Array(cols).fill(UNKNOWN);
	}
	for (var rr = 1; rr <= 3; rr++) {
		for (var cc = 1; cc <= 3; cc++) state[rr][cc] = KNOWN;
	}
	board[2][2] = 0;
	for (var k = 0; k < 8; k++) {
		var pos = BOUNDARY_3x3[k];
		board[pos[0]][pos[1]] = clues[k];
	}
	var result = cspSolver.analyzeBoard(board, state, {});
	if (!result.moves.length) return null;
	var m = result.moves[0];
	return { firstAction: m.action, firstComplexity: m.complexity };
}

function scoreToRating(score) { return Math.max(0, Math.round(240 * (score - 0.5))); }

// Walk every clue tuple where the corners take values 1..5 and the
// edges take values 1..3 (clue=0 is excluded because it would extend
// the cascade beyond the 3x3). For each tuple that is consistent AND
// has at least one forced-safe outside cell, return a record ready for
// insertion. Counts are returned alongside the records so callers can
// report how much of the search space ended up in the database.
function enumerate3x3() {
	var records = [];
	var total = 0;
	var inconsistent = 0;
	var noForcedSafe = 0;
	var nonCanonical = 0;
	for (var c1 = 1; c1 <= 5; c1++)
	for (var c2 = 1; c2 <= 5; c2++)
	for (var c3 = 1; c3 <= 5; c3++)
	for (var c4 = 1; c4 <= 5; c4++)
	for (var e1 = 1; e1 <= 3; e1++)
	for (var e2 = 1; e2 <= 3; e2++)
	for (var e3 = 1; e3 <= 3; e3++)
	for (var e4 = 1; e4 <= 3; e4++) {
		total++;
		// Order matches BOUNDARY_3x3: (1,1)=c1, (1,2)=e1, (1,3)=c2, (2,3)=e2,
		// (3,3)=c3, (3,2)=e3, (3,1)=c4, (2,1)=e4
		var clues = [c1, e1, c2, e2, c3, e3, c4, e4];
		// Skip any tuple that isn't the lex-smallest of its dihedral
		// orbit — the canonical representative carries the same
		// information and avoids storing 8 symmetric duplicates.
		var canon = canonical3x3(clues);
		if (compareTuple(clues, canon) !== 0) { nonCanonical++; continue; }
		var bf = bruteForce3x3(clues);
		if (!bf) { inconsistent++; continue; }
		if (bf.forcedSafe === 0) { noForcedSafe++; continue; }
		var r = rate3x3(clues);
		// rate3x3 may very rarely return null on a brute-force-deducible
		// pattern if the analyzer's bounded search misses it. Skip
		// those so the rating stays meaningful.
		if (!r) continue;
		var prime = primeAnalysis3x3(clues, bf.forcedSafeMask, bf.forcedMineMask);
		records.push({
			size: 3,
			pattern: clues.join("."),
			solutions: bf.solCount,
			forcedSafe: bf.forcedSafe,
			forcedMine: bf.forcedMine,
			forcedSafeMask: bf.forcedSafeMask,
			forcedMineMask: bf.forcedMineMask,
			isPrime: prime.isPrime,
			removableMask: prime.removableMask,
			firstAction: r.firstAction,
			firstComplexity: r.firstComplexity,
			rating: scoreToRating(r.firstComplexity)
		});
	}
	return {
		total: total,
		inconsistent: inconsistent,
		noForcedSafe: noForcedSafe,
		nonCanonical: nonCanonical,
		records: records
	};
}

module.exports = {
	enumerate3x3: enumerate3x3,
	bruteForce3x3: bruteForce3x3,
	rate3x3: rate3x3,
	canonical3x3: canonical3x3
};
