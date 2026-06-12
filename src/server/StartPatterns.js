// Size-parametric enumeration of starting-cascade positions and the unique deduction
// patterns they produce. Generalises the 3x3-specific logic in StartingPositions.js /
// Patterns.js to any H×W revealed block centred in an (H+2)×(W+2) board, so the same code
// catalogues 3x3, 3x4, … building blocks. The pattern itself (method, complexity, which
// clues, what they force) and its canonical key come from the geometry-agnostic helpers in
// Patterns.js, so keys are directly comparable across block sizes.

var BoardLogic = require("../common/BoardLogic");
var patterns = require("./Patterns");
var KNOWN = BoardLogic.KNOWN;
var UNKNOWN = BoardLogic.UNKNOWN;

// Largest ring (or active-clue neighbourhood) we'll brute-force for the complete forced set.
// Beyond this — or beyond the 32-bit bitmask limit — extractPattern falls back to the
// analyzer's own deduced cells, so any block size still works (just without re-derivation).
var BRUTE_LIMIT = 24;

var popcount = BoardLogic.popcount;

// Geometry for an H×W revealed block at rows 1..H, cols 1..W of an (H+2)×(W+2) board.
// `walls` (optional) marks board edges the block sits flush against: { top, bottom, left,
// right } booleans. A walled side has no padding (the board ends there, so cells against it
// have fewer neighbours and the cascade is bounded by the wall, not by ring clues); non-walled
// sides get one row/col of outer ring. So "open" = no walls (ring on all 4 sides), "wall" =
// one side, "corner" = two adjacent sides. The block sits at offset (r0, c0); the ring is the
// in-board cells outside the block; boundary block cells touch the ring; interior cells (clue 0)
// don't (cells against a wall with no ring neighbour are interior).
function geometry(H, W, walls) {
	walls = walls || {};
	var padTop = walls.top ? 0 : 1, padBottom = walls.bottom ? 0 : 1;
	var padLeft = walls.left ? 0 : 1, padRight = walls.right ? 0 : 1;
	var BR = H + padTop + padBottom, BC = W + padLeft + padRight;
	var r0 = padTop, c0 = padLeft;
	function inBlock(r, c) { return r >= r0 && r < r0 + H && c >= c0 && c < c0 + W; }
	var ringCells = [], ringIndexAt = {};
	for (var r = 0; r < BR; r++) {
		for (var c = 0; c < BC; c++) {
			if (!inBlock(r, c)) { ringIndexAt[r + "," + c] = ringCells.length; ringCells.push([r, c]); }
		}
	}
	// Bitmasks over ring cells only work up to 31 bits; bigger blocks (e.g. 9×9, ring 40) skip
	// them and can't be brute-forced — extractPattern uses the analyzer's deduced cells there.
	var canMask = ringCells.length <= 31;
	var boundary = [], masks = [], degrees = [];
	for (var br = r0; br < r0 + H; br++) {
		for (var bc = c0; bc < c0 + W; bc++) {
			var mask = 0, touches = 0;
			for (var dr = -1; dr <= 1; dr++) {
				for (var dc = -1; dc <= 1; dc++) {
					if (dr === 0 && dc === 0) continue;
					var idx = ringIndexAt[(br + dr) + "," + (bc + dc)];
					if (idx !== undefined) { if (canMask) mask |= (1 << idx); touches++; }
				}
			}
			if (touches > 0) { boundary.push([br, bc]); masks.push(mask); degrees.push(touches); }
		}
	}
	return { H: H, W: W, BR: BR, BC: BC, r0: r0, c0: c0, ring: ringCells.length, ringCells: ringCells, boundary: boundary, masks: canMask ? masks : null, degrees: degrees, walls: walls };
}

function boundaryIndexOf(geo, r, c) {
	for (var i = 0; i < geo.boundary.length; i++) {
		if (geo.boundary[i][0] === r && geo.boundary[i][1] === c) return i;
	}
	return -1;
}

// Single pass over all 2^ring mine arrangements: derive each arrangement's boundary clue
// tuple and bucket by it, accumulating per-ring-cell mine occurrences. Arrangements with
// any boundary clue 0 are skipped (a 0-clue boundary would cascade further, so it isn't a
// real edge of the opening). Returns positions whose full clue set forces at least one cell
// (safe or mine) — single-sided deductions count too (e.g. the all-1s ring forces only safes
// via a case-split, which is a legitimate hard building block).
function enumeratePositions(geo) {
	var ring = geo.ring, nb = geo.boundary.length, masks = geo.masks;
	var total = 1 << ring;
	var buckets = {};
	for (var a = 0; a < total; a++) {
		var clues = new Array(nb);
		var bad = false;
		for (var i = 0; i < nb; i++) {
			var v = popcount(a & masks[i]);
			if (v === 0) { bad = true; break; }
			clues[i] = v;
		}
		if (bad) continue;
		var key = clues.join(".");
		var b = buckets[key];
		if (!b) { b = buckets[key] = { clues: clues, solCount: 0, orCounts: new Int32Array(ring) }; }
		b.solCount++;
		for (var bit = 0; bit < ring; bit++) if (a & (1 << bit)) b.orCounts[bit]++;
	}
	var out = [];
	for (var k in buckets) {
		var bk = buckets[k];
		var hasSafe = false, hasMine = false;
		for (var j = 0; j < ring; j++) {
			if (bk.orCounts[j] === 0) hasSafe = true;
			else if (bk.orCounts[j] === bk.solCount) hasMine = true;
		}
		if (hasSafe || hasMine) out.push({ clues: bk.clues, solCount: bk.solCount });
	}
	return out;
}

// Forced-safe / forced-mine ring masks given only the `activeMask` boundary clues. A cell
// can only be forced by clues that touch it, so we brute-force just the ring cells adjacent
// to an active clue (the `relevant` set) rather than the whole ring — 2^(a few cells) instead
// of 2^ring. Cells outside `relevant` are unconstrained, hence never forced. Returns null if
// the active clues are jointly inconsistent.
function bruteForceWithMask(geo, clues, activeMask) {
	var masks = geo.masks;
	var relevant = 0;
	for (var c = 0; c < masks.length; c++) if (activeMask & (1 << c)) relevant |= masks[c];
	if (relevant === 0) return null;

	var solCount = 0;
	var orMask = 0;        // ring bits set as a mine in EVERY solution → forced mine
	var everSafe = relevant; // ring bits never a mine across solutions → forced safe (start full, clear on mine)
	var first = true;
	// Enumerate every subset of `relevant` (mines confined to relevant cells; the rest are
	// unconstrained and fixed safe — they can't be forced anyway).
	for (var a = relevant; ; a = (a - 1) & relevant) {
		var ok = true;
		for (var cc = 0; cc < masks.length; cc++) {
			if (!(activeMask & (1 << cc))) continue;
			if (popcount(a & masks[cc]) !== clues[cc]) { ok = false; break; }
		}
		if (ok) {
			solCount++;
			if (first) { orMask = a; first = false; } else { orMask &= a; }
			everSafe &= ~a;
		}
		if (a === 0) break;
	}
	if (solCount === 0) return null;
	return { safeMask: everSafe, mineMask: orMask };
}

function buildBoardState(geo, clues) {
	var board = [], state = [];
	for (var r = 0; r < geo.BR; r++) {
		board.push(new Array(geo.BC).fill(null));
		state.push(new Array(geo.BC).fill(UNKNOWN));
	}
	for (var br = geo.r0; br < geo.r0 + geo.H; br++) {
		for (var bc = geo.c0; bc < geo.c0 + geo.W; bc++) { state[br][bc] = KNOWN; board[br][bc] = 0; }
	}
	for (var i = 0; i < geo.boundary.length; i++) {
		board[geo.boundary[i][0]][geo.boundary[i][1]] = clues[i];
	}
	return { board: board, state: state };
}

// Extract the canonical first-deduction pattern for one starting position. Mirrors
// Patterns.extract3x3PatternFromClues but parametric: ask the analyzer for its first move,
// then re-derive the COMPLETE forced set from exactly the clues that move used (so the same
// input clues always give the same pattern regardless of analyzer bundling). Returns the
// canonical pattern (with `.key`) or null when there's no two-sided deduction.
function extractPattern(geo, clues) {
	var bs = buildBoardState(geo, clues);
	var raw = patterns.extractFirstDeductionPattern(bs.board, bs.state);
	if (!raw) return null;

	var activeMask = 0, clueCellsForPattern;
	if (raw.method === "case") {
		activeMask = (1 << geo.boundary.length) - 1; // case-split is global; all clues in scope
		clueCellsForPattern = geo.boundary.map(function(b, i) { return [b[0], b[1], clues[i]]; });
	} else {
		clueCellsForPattern = raw.clueCells;
		for (var j = 0; j < raw.clueCells.length; j++) {
			var bi = boundaryIndexOf(geo, raw.clueCells[j][0], raw.clueCells[j][1]);
			if (bi >= 0) activeMask |= (1 << bi);
		}
	}
	// Forced set: on small rings, brute-force the active clues for the COMPLETE forced set
	// (canonical, matches the legacy 3×3). On big rings (no bitmask, or the active-clue
	// neighbourhood is too wide to brute-force) fall back to the analyzer's own deduced cells.
	var deducedCells = [], deducedKey = {};
	var relevant = 0, canBrute = false;
	if (geo.masks) {
		for (var rc = 0; rc < geo.masks.length; rc++) if (activeMask & (1 << rc)) relevant |= geo.masks[rc];
		canBrute = popcount(relevant) <= BRUTE_LIMIT;
	}
	if (canBrute) {
		var bf = bruteForceWithMask(geo, clues, activeMask);
		if (!bf) return null;
		for (var k = 0; k < geo.ring; k++) {
			var bit = 1 << k, cell = geo.ringCells[k];
			if (bf.safeMask & bit) { deducedCells.push([cell[0], cell[1], "S"]); deducedKey[cell[0] + "," + cell[1]] = true; }
			else if (bf.mineMask & bit) { deducedCells.push([cell[0], cell[1], "M"]); deducedKey[cell[0] + "," + cell[1]] = true; }
		}
	} else {
		(raw.deducedCells || []).forEach(function(c) { deducedCells.push([c[0], c[1], c[2]]); deducedKey[c[0] + "," + c[1]] = true; });
	}
	// Keep any deduction with at least one forced cell (single-sided included).
	if (deducedCells.length === 0) return null;

	// Covered context: UNKNOWN ring neighbours of the active clue cells the move didn't decide
	// (interior block cells are revealed, so they're never covered).
	var coveredCells = [], coveredKey = {};
	for (var ci = 0; ci < clueCellsForPattern.length; ci++) {
		var cp = clueCellsForPattern[ci];
		for (var ddr = -1; ddr <= 1; ddr++) {
			for (var ddc = -1; ddc <= 1; ddc++) {
				if (ddr === 0 && ddc === 0) continue;
				var nr = cp[0] + ddr, nc = cp[1] + ddc;
				if (nr < 0 || nc < 0 || nr >= geo.BR || nc >= geo.BC) continue;
				if (nr >= geo.r0 && nr < geo.r0 + geo.H && nc >= geo.c0 && nc < geo.c0 + geo.W) continue; // revealed block cell
				var ck = nr + "," + nc;
				if (deducedKey[ck] || coveredKey[ck]) continue;
				coveredKey[ck] = true;
				coveredCells.push([nr, nc, "?"]);
			}
		}
	}

	// Walls: off-board positions adjacent to the active clue cells. These make a clue against a
	// board edge canonically distinct from the same clue in the open (the wall removes neighbours).
	var wallCells = [], wallKey = {};
	for (var wi = 0; wi < clueCellsForPattern.length; wi++) {
		var wp = clueCellsForPattern[wi];
		for (var wdr = -1; wdr <= 1; wdr++) {
			for (var wdc = -1; wdc <= 1; wdc++) {
				if (wdr === 0 && wdc === 0) continue;
				var wnr = wp[0] + wdr, wnc = wp[1] + wdc;
				if (wnr >= 0 && wnr < geo.BR && wnc >= 0 && wnc < geo.BC) continue; // in-board
				var wk = wnr + "," + wnc;
				if (wallKey[wk]) continue;
				wallKey[wk] = true;
				wallCells.push([wnr, wnc, "W"]);
			}
		}
	}

	var canon = patterns.canonicalize({
		method: raw.method,
		complexity: raw.complexity,
		clueCells: clueCellsForPattern,
		deducedCells: deducedCells,
		coveredCells: coveredCells,
		wallCells: wallCells
	});
	var maxR = 0, maxC = 0;
	canon.clueCells.concat(canon.deducedCells, canon.coveredCells || [], canon.wallCells || []).forEach(function(c) {
		if (c[0] > maxR) maxR = c[0];
		if (c[1] > maxC) maxC = c[1];
	});
	canon.width = maxC + 1;
	canon.height = maxR + 1;
	canon.rating = Math.max(0, Math.round(240 * (canon.complexity - 0.5)));
	return canon;
}

// Enumerate every starting position for an H×W block and return its unique deduction
// patterns, deduped by canonical key. Each entry: { key, pattern, count } where count is how
// many distinct positions produced that pattern.
function enumeratePatterns(H, W, walls) {
	var geo = geometry(H, W, walls);
	var positions = enumeratePositions(geo);
	var byKey = {};
	for (var i = 0; i < positions.length; i++) {
		var pat = extractPattern(geo, positions[i].clues);
		if (!pat) continue;
		var e = byKey[pat.key];
		if (!e) byKey[pat.key] = { key: pat.key, pattern: pat, count: 1 };
		else e.count++;
	}
	return { positions: positions.length, patterns: byKey };
}

module.exports = {
	geometry: geometry,
	enumeratePositions: enumeratePositions,
	extractPattern: extractPattern,
	enumeratePatterns: enumeratePatterns
};
