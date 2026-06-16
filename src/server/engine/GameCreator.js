var BoardLogic = require("../../common/BoardLogic");

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
	game.onMove = null; // optional (button, r, c) hook, fired on each APPLIED move — used for replay capture
	game.playerName = "New player";
	game.autoChordOnFlag = false; // powerup / "only flags" modifier: flagging chords its satisfied numbered neighbours
	game.noFlags = false;   // custom modifier: flagging disabled
	game.onlyFlags = false; // custom modifier: left-click disabled (flag-only play)

	function isFrozen() {
		return Date.now() < game.frozenUntil;
	}

	function handleLeftClick(r, c) {
		if (!game.playing || isFrozen()) return;
		if (game.onlyFlags) return; // "only flags" modifier: left-click (reveal/chord) is disabled
		if (game.onMove) game.onMove(0, r, c);
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
		if (game.noFlags) return; // "no flags" modifier: flagging is disabled
		if (game.onMove) game.onMove(1, r, c);
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

// The no-guess generator + solvability analyzer that used to live here are
// now in NoGuessGenerator.js. The server requires that module directly.

exports.createGame = createGame;
exports.createTemplate = createTemplate;
exports.MINE = MINE;
exports.FLAGGED = FLAGGED;
exports.UNKNOWN = UNKNOWN;
exports.KNOWN = KNOWN;
exports.DEFAULT_ROWS = DEFAULT_ROWS;
exports.DEFAULT_COLS = DEFAULT_COLS;
exports.rows = DEFAULT_ROWS;
exports.cols = DEFAULT_COLS;
