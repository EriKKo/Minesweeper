var numMines = 30;
var rows = 15;
var cols = 20;

var dr = [0, 1, 0, -1, -1, 1, -1, 1];
var dc = [-1, 0, 1, 0, -1, -1, 1, 1];

var MINE = -1;
var FLAGGED = -2;
var UNKNOWN = -3;
var KNOWN = -4;

function createGame() {	
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
	game.playing = false;
	game.handleLeftClick = handleLeftClick;
	game.handleRightClick = handleRightClick;
	game.init = init;
	game.win = null;
	game.lose = null;
	game.playerName = "New player";

	function handleLeftClick(r, c) {
		if (!game.playing) return;
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
		if (!game.playing) return;
		if (state[r][c] == UNKNOWN) {
			state[r][c] = FLAGGED;
		} else if (state[r][c] == FLAGGED) {
			state[r][c] = UNKNOWN;
		} else if (state[r][c] == KNOWN) {
			clearAdjacentIfEnoughFlags(r, c);
		}
	}

	function clearAdjacentIfEnoughFlags(r, c) {
		var adjacentFlagged = getAdjacentSquares(r, c, FLAGGED);
		if (adjacentFlagged.length == board[r][c]) {
			var adjacentUnknown = getAdjacentSquares(r, c, UNKNOWN);
			for (var i = 0; i < adjacentUnknown.length; i++) {
				dfs(adjacentUnknown[i][0], adjacentUnknown[i][1]);
			}
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

	function init() {
		for (var i = 0; i < rows; i++) {
			for (var j = 0; j < cols; j++) {
				board[i][j] = 0;
				state[i][j] = UNKNOWN;
			}
		}
		for (var i = 0; i < numMines; i++) {
			randomizeMine();
		}
		squaresLeft = rows*cols;
		firstClick = true;
	}

	function dfs(r, c) {
		if (state[r][c] == KNOWN) return;
		state[r][c] = KNOWN;
		if (firstClick) {
			handleFirstClick(r, c);
			firstClick = false;
		}
		if (board[r][c] != MINE) {
			squaresLeft--;
		} else {
			game.lose();
		}
		if (board[r][c] == 0) {
			var adjacentUnknown = getAdjacentSquares(r, c, UNKNOWN);
			for (var i = 0; i < adjacentUnknown.length; i++) {
				dfs(adjacentUnknown[i][0], adjacentUnknown[i][1]);
			}
		}
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

exports.createGame = createGame;