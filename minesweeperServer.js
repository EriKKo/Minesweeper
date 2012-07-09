var app = require('http').createServer(handler)
  , io = require('socket.io').listen(app)
  , fs = require('fs');

/* GAME CODE */

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
	
	var game = {};
	game.board = board;
	game.state = state;
	game.playing = false;
	game.handleLeftClick = handleLeftClick;
	game.handleRightClick = handleRightClick;
	game.init = init;
	game.win = win;
	game.lose = lose;
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

	function init() {
		for (var i = 0; i < rows; i++) {
			for (var j = 0; j < cols; j++) {
				board[i][j] = 0;
				state[i][j] = UNKNOWN;
			}
		}
		for (var i = 0; i < numMines; i++) {
			while (true) {
				var r = randInt(rows);
				var c = randInt(cols);
				if (board[r][c] != MINE) {
					putMine(r, c);
					break;
				}
			}
		}
		squaresLeft = rows*cols;
		game.playing = true;
	}

	function dfs(r, c) {
		if (state[r][c] == KNOWN) return;
		if (board[r][c] != MINE) {
			squaresLeft--;
		}
		state[r][c] = KNOWN;
		if (board[r][c] == 0) {
			var adjacentUnknown = getAdjacentSquares(r, c, UNKNOWN);
			for (var i = 0; i < adjacentUnknown.length; i++) {
				dfs(adjacentUnknown[i][0], adjacentUnknown[i][1]);
			}
		} else if (board[r][c] == MINE) {
			game.lose();
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

/* END OF GAME CODE */

var PLAYERS_PER_ROOM = 2;

var games = {};
var roomMapping = {};
var rooms = [];
var numRooms = 0;
var sockets = {};

function createRoom() {
	var players = [];
	var maxPlayers = PLAYERS_PER_ROOM;
	
	var room = {};
	room.players = players;
	room.addPlayer = addPlayer;
	room.deletePlayer = deletePlayer;
	room.isFull = isFull;
	room.getWinner = getWinner;
	room.getLoosers = getLoosers;
	
	function addPlayer(playerID) {
		players.push(playerID);
	}
	
	function deletePlayer(playerID) {
		for (var i = 0; i < players.length; i++) {
			if (players[i] === playerID) {
				players.splice(i, 1);
				i--;
			}
		}
	}
	
	function isFull() {
		return players.length >= maxPlayers;
	}
	
	function getActivePlayers() {
		return players.filter(function(playerID) {
			return games[playerID].playing;
		});
	}
	
	function getWinner() {
		var activePlayers = getActivePlayers();
		if (activePlayers.length == 1) {
			return activePlayers[0];
		} else {
			return null;
		}
	}
	
	function getLoosers() {
		return players.filter(function(playerID) {
			return !games[playerID].playing;
		});
	}
	
	return room;
}

function getNextAvailableRoom() {
	for (var i = 0; i < numRooms; i++) {
		if (!rooms[i].isFull()) {
			return i;
		}
	}
	rooms.push(createRoom());
	numRooms++;
	return numRooms - 1;
}

function getGamesWithPlayerOnTop(playerID, players) {
	g = [];
	g.push(games[playerID]);
	for (var i = 0; i < players.length; i++) {
		if (players[i] != playerID) {
			g.push(games[players[i]]);
		}
	}
	return g;
}

function updateDraw(players) {
	for (var i = 0; i < players.length; i++) {
		var playerID = players[i];
		sockets[playerID].emit("draw_board", {games:getGamesWithPlayerOnTop(playerID, roomMapping[playerID].players)});
	}
}

io.set("log level", 1);

app.listen(81);

function handler (req, res) {
  fs.readFile(__dirname + '/minesweeperClient.html',
  function (err, data) {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading minesweeperClient.html');
    }

    res.writeHead(200);
    res.end(data);
  });
}

function win(playerID) {
	var room = roomMapping[playerID];
	for (var i = 0; i < room.players.length; i++) {
		if (room.players[i] != playerID) {
			games[room.players[i]].playing = false;
			sockets[room.players[i]].emit("lose");
		}
	}
	games[playerID].playing = false;
	sockets[playerID].emit("win");
}

function lose(playerID) {
	var room = roomMapping[playerID];
	games[playerID].playing = false;
	var winner = room.getWinner();
	if (winner != null) {
		games[winner].playing = false;
		sockets[winner].emit("win");
	}
	sockets[playerID].emit("lose");
}

io.sockets.on("connection", function (socket) {
	var playerID = socket.id;
	sockets[playerID] = socket;
	console.log("player connected and given id "+playerID);
	
	var game = createGame();
	games[playerID] = game;
	game.init();
	
	var roomID = getNextAvailableRoom();
	var room = rooms[roomID];
	roomMapping[playerID] = room;
	room.addPlayer(playerID);
	console.log("Room "+roomID+": "+room.players);
	
	socket.emit("new_player", { id: playerID});
	updateDraw(roomMapping[playerID].players);
	
	game.lose = function() {
		lose(playerID);
	};
	game.win = function() {
		win(playerID);
	};
	
	socket.on("player_name", function(data) {
		games[playerID].playerName = data.name;
		updateDraw(room.players);
	});
	
	socket.on("right_click", function (data) {
		games[data.id].handleRightClick(data.r, data.c);
		updateDraw(room.players);
	});
	
	socket.on("left_click", function(data) {
		games[data.id].handleLeftClick(data.r, data.c);
		updateDraw(room.players);
	});
	
	socket.on("restart", function(data) {
		game.init();
		updateDraw(room.players);
	});
	
	socket.on("disconnect", function() {
		delete games[playerID];
		delete roomMapping[playerID];
		room.deletePlayer(playerID);
		console.log("user with id "+playerID+" disconnected");
	});
});