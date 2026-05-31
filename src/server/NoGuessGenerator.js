// No-guess board generator + solvability analyzer.
//
// MSBattle plays every ranked round on a board that's solvable from the
// opening with pure logical deduction (no guessing). `createNoGuessTemplate`
// rolls boards from `GameCreator.createTemplate` and returns the first one
// `analyzeSolvability` proves reachable to 100% safe coverage.

var BoardLogic = require("../common/BoardLogic");
var GameCreator = require("./GameCreator");

var NOGUESS_MAX_TRIES = 100;
var ENUM_CAP = 18; // max frontier-component size we brute-force enumerate

function popcount(x) {
	var c = 0;
	while (x) { x &= x - 1; c++; }
	return c;
}

// Plays the board using only sound logical deduction (never guesses) starting
// from the pre-revealed opening, and reports whether every safe cell can be
// uncovered. Used to pick boards that don't force a guess.
function analyzeSolvability(board, knownCells, numMines) {
	var rows = board.length, cols = board[0].length;
	function neighborsOf(r, c) { return BoardLogic.neighbours(r, c, rows, cols); }

	var revealed = [], mineKnown = [];
	for (var r = 0; r < rows; r++) {
		revealed.push(new Array(cols).fill(false));
		mineKnown.push(new Array(cols).fill(false));
	}

	function reveal(r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			function(rr, cc) { return !revealed[rr][cc] && !mineKnown[rr][cc]; },
			function(rr, cc) { revealed[rr][cc] = true; return false; },
			function(rr, cc) { return board[rr][cc]; }
		);
	}

	for (var i = 0; i < knownCells.length; i++) reveal(knownCells[i][0], knownCells[i][1]);

	// A revealed number cell whose satisfied/forced neighbours give a deduction.
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

	// Global mine-count endgame: all remaining unknowns are all-safe or all-mines.
	function globalPass() {
		var km = 0, unknowns = [];
		for (var r = 0; r < rows; r++) {
			for (var c = 0; c < cols; c++) {
				if (mineKnown[r][c]) km++;
				else if (!revealed[r][c]) unknowns.push([r, c]);
			}
		}
		if (unknowns.length === 0) return false;
		var remaining = numMines - km;
		if (remaining === 0) {
			for (var i = 0; i < unknowns.length; i++) reveal(unknowns[i][0], unknowns[i][1]);
			return true;
		}
		if (remaining === unknowns.length) {
			for (var j = 0; j < unknowns.length; j++) mineKnown[unknowns[j][0]][unknowns[j][1]] = true;
			return true;
		}
		return false;
	}

	// Brute-force each independent frontier component to find cells that are a mine
	// (or safe) in every consistent assignment.
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

	var progress = true;
	while (progress) {
		progress = trivialPass() || globalPass() || enumPass();
	}

	var revealedSafe = 0;
	for (var rr = 0; rr < rows; rr++) {
		for (var cc2 = 0; cc2 < cols; cc2++) if (revealed[rr][cc2]) revealedSafe++;
	}
	var totalSafe = rows * cols - numMines;
	return { solved: revealedSafe === totalSafe, revealedSafe: revealedSafe };
}

// Generate-and-test: return the first board solvable without guessing, or — if
// none turns up within maxTries — the closest (most logically-revealable) one.
function createNoGuessTemplate(startR, startC, mineCount, maxTries, tRows, tCols) {
	maxTries = maxTries > 0 ? maxTries : NOGUESS_MAX_TRIES;
	var best = null, bestScore = -1;
	for (var i = 0; i < maxTries; i++) {
		var cand = GameCreator.createTemplate(startR, startC, mineCount, tRows, tCols);
		var res = analyzeSolvability(cand.board, cand.knownCells, cand.numMines);
		if (res.solved) return cand;
		if (res.revealedSafe > bestScore) { bestScore = res.revealedSafe; best = cand; }
	}
	return best;
}

exports.analyzeSolvability = analyzeSolvability;
exports.createNoGuessTemplate = createNoGuessTemplate;
