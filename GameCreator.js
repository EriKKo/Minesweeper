var BoardLogic = require("./BoardLogic");

var DEFAULT_MINES = 30;
var DEFAULT_ROWS = 15;
var DEFAULT_COLS = 20;

// Used by getAdjacentSquares (the variadic-filter helper still in use here).
var dr = [0, 1, 0, -1, -1, 1, -1, 1];
var dc = [-1, 0, 1, 0, -1, -1, 1, 1];

var MINE = BoardLogic.MINE;
var FLAGGED = BoardLogic.FLAGGED;
var UNKNOWN = BoardLogic.UNKNOWN;
var KNOWN = BoardLogic.KNOWN;

function createGame(mineCount, gameRows, gameCols) {
	var numMines = mineCount > 0 ? mineCount : DEFAULT_MINES;
	var rows = gameRows > 0 ? gameRows : DEFAULT_ROWS;
	var cols = gameCols > 0 ? gameCols : DEFAULT_COLS;
	var board = new Array(rows);
	var state = new Array(rows);
	for (var i = 0; i < rows; i++) {
		board[i] = new Array(cols);
		state[i] = new Array(cols);
	}

	var squaresLeft = 0;
	var firstClick = true;
	
	var game = {};
	game.board = board;
	game.state = state;
	game.rows = rows;
	game.cols = cols;
	game.playing = false;
	game.frozenUntil = 0;
	game.finished = false;
	game.finishedAt = 0;
	game.handleLeftClick = handleLeftClick;
	game.handleRightClick = handleRightClick;
	game.init = init;
	game.revealedSafeCount = revealedSafeCount;
	game.totalSafeSquares = rows * cols - numMines;
	game.win = null;
	game.mineHit = null;
	game.playerName = "New player";
	game.autoChordOnFlag = false; // powerup: flagging a cell chords its satisfied numbered neighbours

	function isFrozen() {
		return Date.now() < game.frozenUntil;
	}

	function handleLeftClick(r, c) {
		if (!game.playing || isFrozen()) return;
		if (state[r][c] == UNKNOWN) {
			dfs(r, c);
		} else if (state[r][c] == KNOWN) {
			clearAdjacentIfEnoughFlags(r, c);
		}
		if (squaresLeft <= numMines) {
			game.win();
		}
	}

	function handleRightClick(r, c) {
		if (!game.playing || isFrozen()) return;
		if (state[r][c] == UNKNOWN) {
			state[r][c] = FLAGGED;
			if (game.autoChordOnFlag) {
				var neighbours = getAdjacentSquares(r, c, KNOWN);
				for (var i = 0; i < neighbours.length; i++) {
					var nr = neighbours[i][0], nc = neighbours[i][1];
					if (board[nr][nc] > 0) clearAdjacentIfEnoughFlags(nr, nc);
				}
			}
		} else if (state[r][c] == FLAGGED) {
			state[r][c] = UNKNOWN;
		} else if (state[r][c] == KNOWN) {
			clearAdjacentIfEnoughFlags(r, c);
		}
		if (squaresLeft <= numMines) {
			game.win();
		}
	}

	function revealedSafeCount() {
		return rows * cols - squaresLeft;
	}

	function clearAdjacentIfEnoughFlags(r, c) {
		var ctx = BoardLogic.chordContext(r, c, rows, cols,
			function(rr, cc) { return state[rr][cc] === FLAGGED; },
			function(rr, cc) { return state[rr][cc] === KNOWN && board[rr][cc] === MINE; },
			function(rr, cc) { return state[rr][cc] === UNKNOWN; }
		);
		if (ctx.flagCount === board[r][c]) {
			for (var i = 0; i < ctx.covered.length; i++) dfs(ctx.covered[i][0], ctx.covered[i][1]);
		}
	}

	function putMine(r, c) {
		board[r][c] = MINE;
		var adjacent = getAdjacentSquares(r, c);
		for (var i = 0; i < adjacent.length; i++) {
			var nr = adjacent[i][0];
			var nc = adjacent[i][1];
			if (board[nr][nc] != MINE) {
				board[nr][nc]++;
			}
		}
	}
	
	function removeMine(r, c) {
		board[r][c] = 0;
		var adjacent = getAdjacentSquares(r, c);
		for (var i = 0; i < adjacent.length; i++) {
			var square = adjacent[i];
			if (board[square[0]][square[1]] != MINE) {
				board[square[0]][square[1]]--;
			} else {
				board[r][c]++;
			}
		}
	}
	
	function randomizeMine() {
		while (true) {
			var r = randInt(rows);
			var c = randInt(cols);
			if (board[r][c] != MINE) {
				putMine(r, c);
				return;;
			}
		}
	}
	
	function handleFirstClick(r, c) {
		var adjacent = getAdjacentSquares(r, c);
		adjacent.push([r,c]);
		var mineCount = 0;
		for (var i = 0; i < adjacent.length; i++) {
			var square = adjacent[i];
			if (board[square[0]][square[1]] == MINE) {
				mineCount++;
			} else {
				putMine(square[0], square[1]);
			}
		}
		for (var i = 0; i < mineCount; i++) {
			randomizeMine();
		}
		for (var i = 0; i < adjacent.length; i++) {
			removeMine(adjacent[i][0], adjacent[i][1]);
		}
	}

	function init(template) {
		for (var i = 0; i < rows; i++) {
			for (var j = 0; j < cols; j++) {
				board[i][j] = template ? template.board[i][j] : 0;
				state[i][j] = UNKNOWN;
			}
		}
		squaresLeft = rows*cols;
		if (template) {
			numMines = template.numMines;
			for (var k = 0; k < template.knownCells.length; k++) {
				var rc = template.knownCells[k];
				state[rc[0]][rc[1]] = KNOWN;
				squaresLeft--;
			}
			firstClick = false;
		} else {
			for (var i = 0; i < numMines; i++) {
				randomizeMine();
			}
			firstClick = true;
		}
		game.totalSafeSquares = rows * cols - numMines;
		game.frozenUntil = 0;
		game.finished = false;
		game.finishedAt = 0;
		game.botFocus = null; // bot's roaming focus point, re-seeded each round
	}

	function dfs(r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			function(rr, cc) { return state[rr][cc] === UNKNOWN; },
			function(rr, cc) {
				state[rr][cc] = KNOWN;
				if (firstClick) {
					handleFirstClick(rr, cc);
					firstClick = false;
				}
				if (board[rr][cc] !== MINE) {
					squaresLeft--;
				} else if (game.mineHit) {
					game.mineHit();
				}
				return false;
			},
			function(rr, cc) { return board[rr][cc]; }
		);
	}

	function getAdjacentSquares(r, c) {
		var ret = [];
		for (var i = 0; i < 8; i++) {
			var nr = r + dr[i];
			var nc = c + dc[i];
			if (onBoard(nr, nc)) {
				var good = arguments.length == getAdjacentSquares.length;
				for (var j = getAdjacentSquares.length; j < arguments.length; j++) {
					good |= arguments[j] == state[nr][nc];
				}
				if (good) {
					ret.push([nr, nc]);		
				}
			}
		}
		return ret;
	}

	function randInt(max) {
		return Math.floor(Math.random()*max);
	}

	function onBoard(r, c) {
		return r >= 0 && r < rows && c >= 0 && c < cols;
	}
	return game;
}

function createTemplate(startR, startC, mineCount, tRows, tCols) {
	var numMines = mineCount > 0 ? mineCount : DEFAULT_MINES;
	var rows = tRows > 0 ? tRows : DEFAULT_ROWS;
	var cols = tCols > 0 ? tCols : DEFAULT_COLS;
	var tmp = createGame(numMines, rows, cols);
	tmp.win = function() {};
	tmp.mineHit = function() {};
	tmp.playing = true;
	tmp.init();
	tmp.handleLeftClick(startR, startC);
	var board = new Array(rows);
	for (var r = 0; r < rows; r++) {
		board[r] = tmp.board[r].slice();
	}
	var knownCells = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (tmp.state[r][c] === KNOWN) knownCells.push([r, c]);
		}
	}
	return { board: board, knownCells: knownCells, numMines: numMines, rows: rows, cols: cols };
}

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
		var cand = createTemplate(startR, startC, mineCount, tRows, tCols);
		var res = analyzeSolvability(cand.board, cand.knownCells, cand.numMines);
		if (res.solved) return cand;
		if (res.revealedSafe > bestScore) { bestScore = res.revealedSafe; best = cand; }
	}
	return best;
}

exports.createGame = createGame;
exports.createTemplate = createTemplate;
exports.createNoGuessTemplate = createNoGuessTemplate;
exports.analyzeSolvability = analyzeSolvability;
exports.MINE = MINE;
exports.FLAGGED = FLAGGED;
exports.UNKNOWN = UNKNOWN;
exports.KNOWN = KNOWN;
exports.DEFAULT_ROWS = DEFAULT_ROWS;
exports.DEFAULT_COLS = DEFAULT_COLS;
exports.rows = DEFAULT_ROWS;
exports.cols = DEFAULT_COLS;