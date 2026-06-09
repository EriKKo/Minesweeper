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

// Are the two corner openings identical? The BR cascade must be the exact 180° mirror of the TL
// cascade, same cells AND same clue values.
function openingsIdentical(board, tl, br, R, C) {
	if (tl.length !== br.length) return false;
	var brClue = {};
	for (var i = 0; i < br.length; i++) brClue[br[i][0] + "," + br[i][1]] = board[br[i][0]][br[i][1]];
	for (var j = 0; j < tl.length; j++) {
		var p = tl[j], mk = (R - 1 - p[0]) + "," + (C - 1 - p[1]);
		if (brClue[mk] !== board[p[0]][p[1]]) return false;
	}
	return true;
}

// Generate a Territory board with two guarantees:
//   1. it's no-guess solvable from EACH corner independently (so neither player is forced to
//      guess — checked with the shared no-guess solver), and
//   2. the two corner start cascades are identical (the top-left corner block is mirrored 180°
//      onto the bottom-right, and every cascade is capped so the opening stays small and fully
//      inside that mirrored block).
// The interior between the corners is independent (not symmetric). Generate-and-test: most boards
// pass within a few tries; if none does within maxTries, the closest identical-opening board is
// returned as a fallback.
function generate(opts) {
	opts = opts || {};
	var R = opts.rows || 16, C = opts.cols || 16;
	var density = opts.density != null ? opts.density : 0.13;
	var cap = opts.cascadeCap || 6;
	var BLK = opts.cornerSize || 7;        // mirrored corner block → identical openings
	var safeRad = opts.safeRadius != null ? opts.safeRadius : 3; // Chebyshev radius of the mine-free start zone
	var maxTries = opts.maxTries || 150;

	function inBlock(r, c) { return (r < BLK && c < BLK) || (r >= R - BLK && c >= C - BLK); }
	// Mine-free safe zone: within Chebyshev distance safeRad of either corner.
	function inSafe(r, c) { return (r <= safeRad && c <= safeRad) || (r >= R - 1 - safeRad && c >= C - 1 - safeRad); }

	var best = null;
	for (var t = 0; t < maxTries; t++) {
		var mine = [];
		for (var r = 0; r < R; r++) { mine.push([]); for (var c = 0; c < C; c++) mine[r].push(Math.random() < density); }
		// Clear the mine-free safe zone at both corners, then mirror the whole TL block (180°) onto
		// the BR block so the two openings match. Only the corner blocks are mirrored — the interior
		// is independent. (safeRad < BLK, so the safe carve sits inside the mirrored block and stays equal.)
		for (var sr = 0; sr < R; sr++) for (var sc = 0; sc < C; sc++) if (inSafe(sr, sc)) mine[sr][sc] = false;
		for (var mr = 0; mr < BLK; mr++) for (var mc = 0; mc < BLK; mc++) mine[R - 1 - mr][C - 1 - mc] = mine[mr][mc];
		var board = cluesFromMines(mine);
		// Cap every cascade OUTSIDE the safe zone so no single click hands over a huge chunk; a
		// cap-mine inside a corner block is mirrored to keep the two sides equal. The safe zone is
		// excluded (inSafe) so the capper never drops a mine back into the protected start area —
		// its opening is intentionally large and identical by the block mirror.
		for (var it = 0; it < 3000; it++) {
			var big = firstBigZeroRegion(board, cap, inSafe);
			if (!big) break;
			var cell = big[Math.floor(big.length / 2)];
			mine[cell[0]][cell[1]] = true;
			if (inBlock(cell[0], cell[1])) mine[R - 1 - cell[0]][C - 1 - cell[1]] = true;
			board = cluesFromMines(mine);
		}
		var mineCount = 0;
		for (r = 0; r < R; r++) for (c = 0; c < C; c++) if (mine[r][c]) mineCount++;
		var tlReveal = cascadeFrom(board, 0, 0), brReveal = cascadeFrom(board, R - 1, C - 1);
		var result = {
			rows: R, cols: C, board: board, starts: [[0, 0], [R - 1, C - 1]],
			startReveals: [tlReveal, brReveal], mineCount: mineCount, cornerSize: BLK, solvable: false
		};
		if (!openingsIdentical(board, tlReveal, brReveal, R, C)) { if (!best) best = result; continue; }
		// No-guess from BOTH corners means each player can clear their side by pure deduction.
		if (noGuess.analyzeSolvability(board, tlReveal, mineCount).solved
			&& noGuess.analyzeSolvability(board, brReveal, mineCount).solved) {
			result.solvable = true;
			return result;
		}
		best = result; // identical openings but not both-solvable — better fallback than a non-identical board
	}
	return best;
}

module.exports = { generate: generate, cascadeFrom: cascadeFrom, cluesFromMines: cluesFromMines };
