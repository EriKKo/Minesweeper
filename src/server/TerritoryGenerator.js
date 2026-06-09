// Board generator for the 2-player Territory (versus) mode.
//
// Two players start from opposite corners (top-left, bottom-right) and clear a shared board,
// claiming cells as they go. To keep it fair and well-paced this generator:
//   - mirrors each corner's start BLOCK (180° rotation) so both openings are identical;
//   - caps the size of any cascade (connected clue-0 region) so no single click hands over a
//     huge chunk of territory;
//   - carves a mine-free opening (Chebyshev radius `safeRadius`) at each corner so the first moves
//     are safe (no instant self-detonation on the start cascade).
// The interior between the corners stays random. Mine hits are part of the mode (no full no-guess
// guarantee), so this is a plain mine layout, not a no-guess template.

var BoardLogic = require("../common/BoardLogic");
var noGuess = require("./NoGuessGenerator");
var MINE = BoardLogic.MINE; // -1

function inBounds(r, c, R, C) { return r >= 0 && c >= 0 && r < R && c < C; }

// Recompute clue numbers from a boolean mine grid. Non-mine cell = count of adjacent mines.
function cluesFromMines(mine) {
	var R = mine.length, C = mine[0].length, board = [];
	for (var r = 0; r < R; r++) {
		board.push(new Array(C));
		for (var c = 0; c < C; c++) {
			if (mine[r][c]) { board[r][c] = MINE; continue; }
			var n = 0;
			for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
				if (!dr && !dc) continue;
				var nr = r + dr, nc = c + dc;
				if (inBounds(nr, nc, R, C) && mine[nr][nc]) n++;
			}
			board[r][c] = n;
		}
	}
	return board;
}

// Cells revealed by clicking (sr,sc): the connected clue-0 region (8-dir) plus its boundary.
function cascadeFrom(board, sr, sc) {
	var R = board.length, C = board[0].length, seen = {}, out = [];
	BoardLogic.cascadeReveal(sr, sc, R, C,
		function(r, c) { return !seen[r + "," + c] && board[r][c] !== MINE; },
		function(r, c) { seen[r + "," + c] = true; out.push([r, c]); return false; },
		function(r, c) { return board[r][c]; });
	return out;
}

// First 8-connected clue-0 region larger than `cap`, ignoring cells inside either corner block
// (those are kept symmetric and small by construction). Returns its cells, or null.
function firstBigZeroRegion(board, cap, inCorner) {
	var R = board.length, C = board[0].length, seen = {};
	for (var r = 0; r < R; r++) {
		for (var c = 0; c < C; c++) {
			if (board[r][c] !== 0 || seen[r + "," + c] || inCorner(r, c)) continue;
			var comp = [], stack = [[r, c]];
			while (stack.length) {
				var p = stack.pop(), k = p[0] + "," + p[1];
				if (seen[k] || board[p[0]][p[1]] !== 0 || inCorner(p[0], p[1])) continue;
				seen[k] = true; comp.push(p);
				for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
					if (!dr && !dc) continue;
					var nr = p[0] + dr, nc = p[1] + dc;
					if (inBounds(nr, nc, R, C) && !seen[nr + "," + nc] && board[nr][nc] === 0) stack.push([nr, nc]);
				}
			}
			if (comp.length > cap) return comp;
		}
	}
	return null;
}

// Are all corner openings identical? Each corner's cascade must be the exact mirror of the first
// corner's (TL), same cells AND same clue values — the per-corner mirror flips rows/cols depending on
// which edges that corner sits on. Works for 2 corners (TL/BR, a 180° flip) and 4 (TL/TR/BL/BR).
function openingsMatch(board, reveals, corners, R, C) {
	var base = reveals[0];
	for (var k = 1; k < reveals.length; k++) {
		if (reveals[k].length !== base.length) return false;
		var ar = corners[k][0], ac = corners[k][1], kClue = {};
		for (var i = 0; i < reveals[k].length; i++) kClue[reveals[k][i][0] + "," + reveals[k][i][1]] = board[reveals[k][i][0]][reveals[k][i][1]];
		for (var j = 0; j < base.length; j++) {
			var p = base[j];
			var mr = (ar === 0) ? p[0] : R - 1 - p[0];
			var mc = (ac === 0) ? p[1] : C - 1 - p[1];
			if (kClue[mr + "," + mc] !== board[p[0]][p[1]]) return false;
		}
	}
	return true;
}

// Generate a Territory board for `corners` players (2 → top-left + bottom-right; 4 → all four
// corners), with two guarantees:
//   1. it's no-guess solvable from EACH corner independently (so no player is forced to guess), and
//   2. all corner start cascades are identical — the top-left corner block is mirrored onto every
//      other corner, and every cascade is capped so the opening stays small and fully inside that
//      mirrored block.
// The interior between the corners is independent (not symmetric). Generate-and-test: if none passes
// within maxTries, the closest identical-opening board is returned as a fallback.
function generate(opts) {
	opts = opts || {};
	var R = opts.rows || 16, C = opts.cols || 16;
	var density = opts.density != null ? opts.density : 0.13;
	var cap = opts.cascadeCap || 6;
	var BLK = opts.cornerSize || 7;        // mirrored corner block → identical openings
	var safeRad = opts.safeRadius != null ? opts.safeRadius : 3; // Chebyshev radius of the mine-free start zone
	var nCorners = opts.corners === 4 ? 4 : 2;
	var maxTries = opts.maxTries || (nCorners === 4 ? 400 : 150); // 4-fold no-guess is rarer, so try harder

	var corners = nCorners === 4
		? [[0, 0], [0, C - 1], [R - 1, 0], [R - 1, C - 1]]
		: [[0, 0], [R - 1, C - 1]];

	function nearCorner(r, c, rad) {
		for (var k = 0; k < corners.length; k++) if (Math.max(Math.abs(r - corners[k][0]), Math.abs(c - corners[k][1])) <= rad) return true;
		return false;
	}
	function inSafe(r, c) { return nearCorner(r, c, safeRad); }
	function inBlock(r, c) { return nearCorner(r, c, BLK - 1); }
	// Images of a top-left-relative block cell (lr,lc) in every active corner, so all corner blocks
	// (hence all openings) stay identical: the 180° partner for 2 corners; the full set for 4.
	function imagesOf(lr, lc) {
		return nCorners === 4
			? [[lr, lc], [lr, C - 1 - lc], [R - 1 - lr, lc], [R - 1 - lr, C - 1 - lc]]
			: [[lr, lc], [R - 1 - lr, C - 1 - lc]];
	}
	function toTL(r, c) { return [r < BLK ? r : R - 1 - r, c < BLK ? c : C - 1 - c]; } // fold a corner cell back to TL coords

	var best = null;
	for (var t = 0; t < maxTries; t++) {
		var mine = [];
		for (var r = 0; r < R; r++) { mine.push([]); for (var c = 0; c < C; c++) mine[r].push(Math.random() < density); }
		// Mine-free start zones at every corner, then copy the TL corner block into every other corner.
		for (var sr = 0; sr < R; sr++) for (var sc = 0; sc < C; sc++) if (inSafe(sr, sc)) mine[sr][sc] = false;
		for (var lr = 0; lr < BLK; lr++) for (var lc = 0; lc < BLK; lc++) {
			var imgs = imagesOf(lr, lc);
			for (var ii = 1; ii < imgs.length; ii++) mine[imgs[ii][0]][imgs[ii][1]] = mine[lr][lc];
		}
		var board = cluesFromMines(mine);
		// Cap every cascade OUTSIDE the safe zones so no single click hands over a huge chunk; a cap-mine
		// inside a corner block is mirrored to every corner to keep the openings identical.
		for (var it = 0; it < 3000; it++) {
			var big = firstBigZeroRegion(board, cap, inSafe);
			if (!big) break;
			var cell = big[Math.floor(big.length / 2)];
			if (inBlock(cell[0], cell[1])) {
				var tl = toTL(cell[0], cell[1]), imgs2 = imagesOf(tl[0], tl[1]);
				for (var iq = 0; iq < imgs2.length; iq++) mine[imgs2[iq][0]][imgs2[iq][1]] = true;
			} else {
				mine[cell[0]][cell[1]] = true;
			}
			board = cluesFromMines(mine);
		}
		var mineCount = 0;
		for (r = 0; r < R; r++) for (c = 0; c < C; c++) if (mine[r][c]) mineCount++;
		var reveals = corners.map(function(cc) { return cascadeFrom(board, cc[0], cc[1]); });
		var result = {
			rows: R, cols: C, board: board, starts: corners.map(function(cc) { return [cc[0], cc[1]]; }),
			startReveals: reveals, mineCount: mineCount, cornerSize: BLK, corners: nCorners, solvable: false
		};
		if (!openingsMatch(board, reveals, corners, R, C)) { if (!best) best = result; continue; }
		// No-guess from EVERY corner means each player can clear their own corner by pure deduction.
		if (reveals.every(function(rv) { return noGuess.analyzeSolvability(board, rv, mineCount).solved; })) {
			result.solvable = true;
			return result;
		}
		best = result; // identical openings but not all-solvable — better fallback than a non-identical board
	}
	return best;
}

module.exports = { generate: generate, cascadeFrom: cascadeFrom, cluesFromMines: cluesFromMines };
