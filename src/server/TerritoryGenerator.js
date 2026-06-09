// Board generator for the 2-player Territory (versus) mode.
//
// Two players start from opposite corners (top-left, bottom-right) and clear a shared board,
// claiming cells as they go. To keep it fair and well-paced this generator:
//   - mirrors each corner's start BLOCK (180° rotation) so both openings are identical;
//   - caps the size of any cascade (connected clue-0 region) so no single click hands over a
//     huge chunk of territory;
//   - carves a small open pocket at each corner so the first click cascades a modest, equal area.
// The interior between the corners stays random. Mine hits are part of the mode (no full no-guess
// guarantee), so this is a plain mine layout, not a no-guess template.

var BoardLogic = require("../common/BoardLogic");
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

function generate(opts) {
	opts = opts || {};
	var R = opts.rows || 16, C = opts.cols || 16;
	var density = opts.density != null ? opts.density : 0.18;
	var cap = opts.cascadeCap || 6;
	var D = opts.cornerSize || 5;          // size of the mirrored corner block
	var openDepth = opts.openDepth || 3;   // triangular open pocket: cells with r+c < openDepth

	function inCorner(r, c) {
		return (r < D && c < D) || (r >= R - D && c >= C - D);
	}

	var mine = [];
	for (var r = 0; r < R; r++) { mine.push([]); for (var c = 0; c < C; c++) mine[r].push(Math.random() < density); }

	// Carve an identical open pocket at the top-left corner (within its block)…
	for (var pr = 0; pr < D; pr++) for (var pc = 0; pc < D; pc++) if (pr + pc < openDepth) mine[pr][pc] = false;
	// …then mirror the whole top-left block (incl. the pocket) onto the bottom-right via 180° rotation,
	// so both corners face an identical opening.
	for (var br = 0; br < D; br++) for (var bc = 0; bc < D; bc++) mine[R - 1 - br][C - 1 - bc] = mine[br][bc];
	mine[0][0] = false; mine[R - 1][C - 1] = false; // start cells always safe

	var board = cluesFromMines(mine);

	// Cap cascades outside the corner blocks: drop a mine into any oversized clue-0 region and
	// recompute, until none exceeds the cap (bounded iterations as a safety net).
	for (var it = 0; it < 1000; it++) {
		var big = firstBigZeroRegion(board, cap, inCorner);
		if (!big) break;
		var cell = big[Math.floor(big.length / 2)];
		mine[cell[0]][cell[1]] = true;
		board = cluesFromMines(mine);
	}

	var mineCount = 0;
	for (r = 0; r < R; r++) for (c = 0; c < C; c++) if (mine[r][c]) mineCount++;

	return {
		rows: R, cols: C, board: board,
		starts: [[0, 0], [R - 1, C - 1]],
		startReveals: [cascadeFrom(board, 0, 0), cascadeFrom(board, R - 1, C - 1)],
		mineCount: mineCount, cornerSize: D
	};
}

module.exports = { generate: generate, cascadeFrom: cascadeFrom, cluesFromMines: cluesFromMines };
