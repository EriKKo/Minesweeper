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

function popcount(x) {
	x = x - ((x >>> 1) & 0x55555555);
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Geometry for an H×W revealed block at rows 1..H, cols 1..W of an (H+2)×(W+2) board.
// The "outer ring" is the padded border; boundary block cells touch it (their clues are
// set by ring mines); interior block cells are surrounded entirely by the block (clue 0).
function geometry(H, W) {
	var BR = H + 2, BC = W + 2;
	var ringCells = [], ringIndexAt = {};
	for (var r = 0; r < BR; r++) {
		for (var c = 0; c < BC; c++) {
			if (r === 0 || r === BR - 1 || c === 0 || c === BC - 1) {
				ringIndexAt[r + "," + c] = ringCells.length;
				ringCells.push([r, c]);
			}
		}
	}
	if (ringCells.length > 24) throw new Error("ring too large to brute-force: " + ringCells.length + " cells");
	var boundary = [], masks = [];
	for (var br = 1; br <= H; br++) {
		for (var bc = 1; bc <= W; bc++) {
			var mask = 0, touches = 0;
			for (var dr = -1; dr <= 1; dr++) {
				for (var dc = -1; dc <= 1; dc++) {
					if (dr === 0 && dc === 0) continue;
					var idx = ringIndexAt[(br + dr) + "," + (bc + dc)];
					if (idx !== undefined) { mask |= (1 << idx); touches++; }
				}
			}
			if (touches > 0) { boundary.push([br, bc]); masks.push(mask); }
		}
	}
	return { H: H, W: W, BR: BR, BC: BC, ring: ringCells.length, ringCells: ringCells, boundary: boundary, masks: masks };
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
// real edge of the opening). Returns positions whose full clue set forces at least one safe
// AND one mine cell — the only ones that can yield a two-sided pattern.
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
		if (hasSafe && hasMine) out.push({ clues: bk.clues, solCount: bk.solCount });
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
	for (var br = 1; br <= geo.H; br++) {
		for (var bc = 1; bc <= geo.W; bc++) { state[br][bc] = KNOWN; board[br][bc] = 0; }
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
	var bf = bruteForceWithMask(geo, clues, activeMask);
	if (!bf) return null;

	var deducedCells = [], deducedKey = {};
	for (var k = 0; k < geo.ring; k++) {
		var bit = 1 << k, cell = geo.ringCells[k];
		if (bf.safeMask & bit) { deducedCells.push([cell[0], cell[1], "S"]); deducedKey[cell[0] + "," + cell[1]] = true; }
		else if (bf.mineMask & bit) { deducedCells.push([cell[0], cell[1], "M"]); deducedKey[cell[0] + "," + cell[1]] = true; }
	}
	var hasMine = false, hasSafe = false;
	for (var d = 0; d < deducedCells.length; d++) { if (deducedCells[d][2] === "M") hasMine = true; else hasSafe = true; }
	if (!hasMine || !hasSafe) return null;

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
				if (nr >= 1 && nr <= geo.H && nc >= 1 && nc <= geo.W) continue; // revealed block cell
				var ck = nr + "," + nc;
				if (deducedKey[ck] || coveredKey[ck]) continue;
				coveredKey[ck] = true;
				coveredCells.push([nr, nc, "?"]);
			}
		}
	}

	var canon = patterns.canonicalize({
		method: raw.method,
		complexity: raw.complexity,
		clueCells: clueCellsForPattern,
		deducedCells: deducedCells,
		coveredCells: coveredCells
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
function enumeratePatterns(H, W) {
	var geo = geometry(H, W);
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
