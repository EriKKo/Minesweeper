// Random small-puzzle generator with difficulty classification.
//
// generatePuzzles({ count, rows, cols, ... }) returns up to `count` puzzles
// that pass the filters below:
//   - bottom-left corner cascade-reveals at start (so the puzzle has visible
//     context — players don't stare at an all-covered board).
//   - 1..5 covered safe cells remain after the cascade (small "active area"
//     — the puzzle is one deduction or a short chain).
//   - 100% solvable with no guessing.
//
// Each returned puzzle carries { rows, cols, mines, revealed, coveredSafe,
// difficulty, passes } so the caller can sort / bucket / display.

var BoardLogic = require("../common/BoardLogic");
var MINE = BoardLogic.MINE;

function generatePuzzles(opts) {
	opts = opts || {};
	var batchSize = opts.count || 20;
	var attemptsPerPuzzle = opts.attempts || 25;
	var puzzles = [];
	for (var i = 0; i < batchSize; i++) {
		for (var t = 0; t < attemptsPerPuzzle; t++) {
			var p = tryGenerate(opts);
			if (p) { puzzles.push(p); break; }
		}
	}
	return puzzles;
}

function tryGenerate(opts) {
	var rows = opts.rows || randInt(4, 6);
	var cols = opts.cols || randInt(4, 6);
	// Mine density around 18% — enough to make the cascade interesting without
	// turning the whole board into clues.
	var defaultMines = Math.max(2, Math.round(rows * cols * 0.18));
	var mineCount = opts.mineCount || defaultMines;
	var startCell = [rows - 1, 0];

	// Random mine placement that keeps the start cell + its neighbours mine-
	// free so cascade actually triggers.
	var avoid = {};
	avoid[startCell[0] + "," + startCell[1]] = true;
	BoardLogic.forEachNeighbour(startCell[0], startCell[1], rows, cols, function(r, c) {
		avoid[r + "," + c] = true;
	});
	var positions = [];
	for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
		if (!avoid[r + "," + c]) positions.push([r, c]);
	}
	if (positions.length < mineCount) return null;
	shuffle(positions);
	var mines = positions.slice(0, mineCount).sort(comparePos);

	var board = buildBoard(rows, cols, mines);
	if (board[startCell[0]][startCell[1]] !== 0) return null;
	var revealed = cascadeFrom(board, startCell);

	var totalSafe = rows * cols - mines.length;
	var coveredSafe = totalSafe - revealed.length;
	if (coveredSafe < 1 || coveredSafe > 5) return null;

	var analysis = analyzeWithTracking(board, revealed, mines.length);
	if (!analysis.solved) return null;

	return {
		rows: rows,
		cols: cols,
		mines: mines,
		revealed: revealed.slice().sort(comparePos),
		coveredSafe: coveredSafe,
		difficulty: analysis.difficulty,
		passes: analysis.passes
	};
}

function comparePos(a, b) { return a[0] - b[0] || a[1] - b[1]; }

function shuffle(arr) {
	for (var i = arr.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
	}
	return arr;
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function buildBoard(rows, cols, mines) {
	var board = [];
	for (var r = 0; r < rows; r++) board[r] = new Array(cols).fill(0);
	mines.forEach(function(m) { board[m[0]][m[1]] = MINE; });
	for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
		if (board[r][c] === MINE) continue;
		var cnt = 0;
		BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
			if (board[nr][nc] === MINE) cnt++;
		});
		board[r][c] = cnt;
	}
	return board;
}

function cascadeFrom(board, start) {
	var rows = board.length, cols = board[0].length;
	var seen = {};
	var revealed = [];
	BoardLogic.cascadeReveal(start[0], start[1], rows, cols,
		function(r, c) { return !seen[r + "," + c] && board[r][c] !== MINE; },
		function(r, c) {
			seen[r + "," + c] = true;
			revealed.push([r, c]);
			return false;
		},
		function(r, c) { return board[r][c]; }
	);
	return revealed;
}

// Per-pass tracking solver. Mirrors NoGuessGenerator.analyzeSolvability but
// counts how many times each pass made progress so we can classify difficulty:
//   1 (trivial): only trivialPass needed — forced mines + satisfied clear
//   2 (medium):  enumPass needed once — single non-trivial deduction (subset,
//                1-2-1 wall, simple case analysis…)
//   3+ (chain):  enumPass needed multiple times — chain of harder deductions
var ENUM_CAP = 18;

function analyzeWithTracking(board, revealedList, numMines) {
	var rows = board.length, cols = board[0].length;
	var revealed = [], mineKnown = [];
	for (var r = 0; r < rows; r++) {
		revealed.push(new Array(cols).fill(false));
		mineKnown.push(new Array(cols).fill(false));
	}
	revealedList.forEach(function(p) { revealed[p[0]][p[1]] = true; });

	function neighborsOf(r, c) { return BoardLogic.neighbours(r, c, rows, cols); }

	function reveal(r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			function(rr, cc) { return !revealed[rr][cc] && !mineKnown[rr][cc]; },
			function(rr, cc) { revealed[rr][cc] = true; return false; },
			function(rr, cc) { return board[rr][cc]; }
		);
	}

	function trivialPass() {
		var prog = false;
		for (var r = 0; r < rows; r++) {
			for (var c = 0; c < cols; c++) {
				if (!revealed[r][c] || board[r][c] <= 0) continue;
				var nb = neighborsOf(r, c);
				var km = 0, unk = [];
				for (var k = 0; k < nb.length; k++) {
					var nr = nb[k][0], nc = nb[k][1];
					if (mineKnown[nr][nc]) km++;
					else if (!revealed[nr][nc]) unk.push(nb[k]);
				}
				if (unk.length === 0) continue;
				if (board[r][c] === km) {
					for (var u = 0; u < unk.length; u++) reveal(unk[u][0], unk[u][1]);
					prog = true;
				} else if (board[r][c] - km === unk.length) {
					for (var u2 = 0; u2 < unk.length; u2++) mineKnown[unk[u2][0]][unk[u2][1]] = true;
					prog = true;
				}
			}
		}
		return prog;
	}

	function popcount(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }

	function enumPass() {
		var varId = {}, varList = [], raw = [];
		for (var r = 0; r < rows; r++) {
			for (var c = 0; c < cols; c++) {
				if (!revealed[r][c] || board[r][c] <= 0) continue;
				var nb = neighborsOf(r, c);
				var km = 0, ids = [];
				for (var k = 0; k < nb.length; k++) {
					var nr = nb[k][0], nc = nb[k][1];
					if (mineKnown[nr][nc]) km++;
					else if (!revealed[nr][nc]) {
						var key = nr + "," + nc;
						if (varId[key] === undefined) { varId[key] = varList.length; varList.push([nr, nc]); }
						ids.push(varId[key]);
					}
				}
				if (ids.length) raw.push({ ids: ids, need: board[r][c] - km });
			}
		}
		if (varList.length === 0) return false;

		var parent = [];
		for (var v = 0; v < varList.length; v++) parent.push(v);
		function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
		for (var ci = 0; ci < raw.length; ci++) {
			var idsC = raw[ci].ids;
			for (var t = 1; t < idsC.length; t++) parent[find(idsC[t])] = find(idsC[0]);
		}

		var comps = {};
		for (var w = 0; w < varList.length; w++) {
			var root = find(w);
			(comps[root] || (comps[root] = [])).push(w);
		}

		var prog = false;
		for (var rootKey in comps) {
			var vars = comps[rootKey];
			var k2 = vars.length;
			if (k2 > ENUM_CAP) continue;
			var local = {};
			for (var li = 0; li < k2; li++) local[vars[li]] = li;
			var cons = [];
			for (var rc2 = 0; rc2 < raw.length; rc2++) {
				if (find(raw[rc2].ids[0]) !== parseInt(rootKey, 10)) continue;
				var mask = 0;
				for (var m = 0; m < raw[rc2].ids.length; m++) mask |= (1 << local[raw[rc2].ids[m]]);
				cons.push({ mask: mask, need: raw[rc2].need });
			}
			var orCount = new Array(k2).fill(0), solCount = 0;
			var total = 1 << k2;
			for (var a = 0; a < total; a++) {
				var ok = true;
				for (var cc = 0; cc < cons.length; cc++) {
					if (popcount(a & cons[cc].mask) !== cons[cc].need) { ok = false; break; }
				}
				if (!ok) continue;
				solCount++;
				for (var b = 0; b < k2; b++) if (a & (1 << b)) orCount[b]++;
			}
			if (solCount === 0) continue;
			for (var f = 0; f < k2; f++) {
				var cell = varList[vars[f]];
				if (orCount[f] === 0) { reveal(cell[0], cell[1]); prog = true; }
				else if (orCount[f] === solCount) { mineKnown[cell[0]][cell[1]] = true; prog = true; }
			}
		}
		return prog;
	}

	var trivCount = 0, enumCount = 0;
	while (true) {
		if (trivialPass()) { trivCount++; continue; }
		if (enumPass())    { enumCount++; continue; }
		break;
	}

	var revealedSafe = 0;
	for (var rr = 0; rr < rows; rr++) {
		for (var cc2 = 0; cc2 < cols; cc2++) if (revealed[rr][cc2]) revealedSafe++;
	}
	var totalSafe = rows * cols - numMines;
	var solved = revealedSafe === totalSafe;

	// Difficulty: 1 if trivial-only; otherwise 1 + enumCount (so an enum pass
	// followed by more trivial work is "2", multiple enum passes climb from
	// there). Cap at 5 for display purposes.
	var difficulty = solved ? (enumCount === 0 ? 1 : Math.min(5, 1 + enumCount)) : 0;
	return { solved: solved, difficulty: difficulty, passes: { trivial: trivCount, enum: enumCount } };
}

exports.generatePuzzles = generatePuzzles;
