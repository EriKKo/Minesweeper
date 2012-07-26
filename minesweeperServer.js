var app = require("http").createServer(handler)
  , io = require("socket.io").listen(app)
  , fs = require("fs")
  , path = require("path")
  , gameCreator = require("./GameCreator")
  , roomCreator = require("./RoomCreator");

var COUNT_DOWN_TIME = 3;

function handler (req, res) {
	var filePath = "." + req.url;
	if (filePath == "./") {
		filePath = "./minesweeperClient.html";
	}
	console.log(filePath);
	var extension = path.extname(filePath);
	var contentType = "text/html";
	if (extension == ".js") {
		contentType = "text/javascript";
	} else if (extension == ".css") {
		contentType = "text/css";
	}
	path.exists(filePath, function(exists) {
		if (exists) {
			fs.readFile(filePath, function(err, data) {
				if (err) {
					res.writeHead(500);
					res.end("Error while loading "+filePath);
				} else {
					console.log(data);
					res.writeHead(200, { "Content-Type" : contentType});
					res.end(data);
				}
			});
		} else {
			res.writeHead(404);
			res.end();
		}
	});
}

var games = {};
var roomMapping = {};
var rooms = [];
var numRooms = 0;
var sockets = {};

function getNextAvailableRoom() {
	for (var i = 0; i < numRooms; i++) {
		if (!rooms[i].isFull()) {
			return i;
		}
	}
	rooms.push(roomCreator.createRoom());
	numRooms++;
	return numRooms - 1;
}

function getActivePlayers(room) {
	return room.players.filter(function(playerID) {
		return games[playerID].playing;
	});
}

function getNonActivePlayers(room) {
	return room.players.filter(function(playerID) {
		return !games[playerID].playing;
	});
}

function getWinner(room) {
	var activePlayers = getActivePlayers(room);
	if (activePlayers.length == 1) {
		return activePlayers[0];
	} else {
		return null;
	}
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

app.listen(1337);

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
	endGame(roomMapping[playerID]);
}

function lose(playerID) {
	var room = roomMapping[playerID];
	games[playerID].playing = false;
	var winner = getWinner(room);
	if (winner != null) {
		games[winner].playing = false;
		sockets[winner].emit("win");
		endGame(roomMapping[playerID]);
	}
	sockets[playerID].emit("lose");
}

function startGame(room) {
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		games[playerID].init();
	}
	// Make sure everyone starts at the same time
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		sockets[playerID].emit("start_game", {time:COUNT_DOWN_TIME});
	}
	setTimeout(function() {
		for (var i = 0; i < room.players.length; i++) {
			var playerID = room.players[i];
			games[playerID].playing = true;
		}
	}, COUNT_DOWN_TIME*1000);
}

function endGame(room) {
	room.resetReady();
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		sockets[playerID].emit("game_ended");
	}
}

io.sockets.on("connection", function (socket) {
	var playerID = socket.id;
	sockets[playerID] = socket;
	console.log("player connected and given id "+playerID);
	
	var game = gameCreator.createGame();
	games[playerID] = game;
	
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
	
	socket.on("player_ready", function(data) {
		room.playerReady(playerID);
		console.log("player "+playerID+" is ready");
		if (room.players.length > 1 && room.allReady()) {
			console.log("all ready");
			startGame(room);
		}
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