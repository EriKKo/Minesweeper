var http = require("http")
  , fs = require("fs")
  , path = require("path")
  , gameCreator = require("./GameCreator")
  , roomCreator = require("./RoomCreator");

var COUNT_DOWN_TIME = 3;

var app = http.createServer(handler);
var io = require("socket.io")(app);

function handler (req, res) {
	var filePath = "." + req.url;
	if (filePath == "./") {
		filePath = "./minesweeperClient.html";
	}
	var extension = path.extname(filePath);
	var contentType = "text/html";
	if (extension == ".js") {
		contentType = "text/javascript";
	} else if (extension == ".css") {
		contentType = "text/css";
	}
	fs.access(filePath, fs.constants.R_OK, function(err) {
		if (err) {
			res.writeHead(404);
			res.end();
			return;
		}
		fs.readFile(filePath, function(err, data) {
			if (err) {
				res.writeHead(500);
				res.end("Error while loading "+filePath);
			} else {
				res.writeHead(200, { "Content-Type" : contentType});
				res.end(data);
			}
		});
	});
}

var games = {};
var roomMapping = {};
var rooms = {};
var nextRoomId = 1;
var sockets = {};
var names = {};

function roomSummary(room) {
	return {
		id: room.id,
		playerCount: room.players.length,
		maxPlayers: room.maxPlayers,
		playing: room.playing,
		players: room.players.map(function(pid) { return names[pid] || "Anonymous"; })
	};
}

function getRoomList() {
	return Object.keys(rooms).map(function(id) { return roomSummary(rooms[id]); });
}

function broadcastRoomList() {
	io.to("lobby").emit("room_list", { rooms: getRoomList() });
}

function deleteRoomIfEmpty(room) {
	if (room.players.length === 0) {
		delete rooms[room.id];
	}
}

function getActivePlayers(room) {
	return room.players.filter(function(playerID) {
		return games[playerID].playing;
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
	var g = [];
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
		sockets[playerID].emit("draw_board", {games: getGamesWithPlayerOnTop(playerID, roomMapping[playerID].players)});
	}
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
	endGame(room);
}

function lose(playerID) {
	var room = roomMapping[playerID];
	games[playerID].playing = false;
	var winner = getWinner(room);
	if (winner != null) {
		games[winner].playing = false;
		sockets[winner].emit("win");
		endGame(room);
	}
	sockets[playerID].emit("lose");
}

function startGame(room) {
	room.playing = true;
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		games[playerID].init();
	}
	// Make sure everyone starts at the same time
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		sockets[playerID].emit("start_game", {time: COUNT_DOWN_TIME});
	}
	setTimeout(function() {
		for (var i = 0; i < room.players.length; i++) {
			var playerID = room.players[i];
			if (games[playerID]) games[playerID].playing = true;
		}
	}, COUNT_DOWN_TIME*1000);
	broadcastRoomList();
}

function endGame(room) {
	room.playing = false;
	room.resetReady();
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		sockets[playerID].emit("game_ended");
	}
	broadcastRoomList();
}

function addPlayerToRoom(socket, room) {
	var playerID = socket.id;
	var game = gameCreator.createGame();
	game.playerName = names[playerID] || "Anonymous";
	games[playerID] = game;
	roomMapping[playerID] = room;
	room.addPlayer(playerID);

	game.lose = function() { lose(playerID); };
	game.win = function() { win(playerID); };

	socket.leave("lobby");
	socket.join("room:" + room.id);
	socket.emit("joined_room", { roomId: room.id });
	updateDraw(room.players);
	broadcastRoomList();
}

function removePlayerFromRoom(playerID) {
	var room = roomMapping[playerID];
	if (!room) return;
	room.deletePlayer(playerID);
	delete roomMapping[playerID];
	delete games[playerID];
	if (sockets[playerID]) {
		sockets[playerID].leave("room:" + room.id);
	}
	if (room.players.length > 0) {
		// If a game is in progress and only one player remains, declare them the winner
		if (room.playing) {
			var winner = getWinner(room);
			if (winner != null) {
				games[winner].playing = false;
				sockets[winner].emit("win");
				endGame(room);
			} else {
				updateDraw(room.players);
			}
		} else {
			updateDraw(room.players);
		}
	}
	deleteRoomIfEmpty(room);
	broadcastRoomList();
}

io.on("connection", function (socket) {
	var playerID = socket.id;
	sockets[playerID] = socket;
	names[playerID] = "Anonymous";
	socket.join("lobby");
	console.log("player connected: " + playerID);

	socket.emit("connected", { id: playerID });
	socket.emit("room_list", { rooms: getRoomList() });

	socket.on("set_name", function(data) {
		var name = (data && typeof data.name === "string") ? data.name.trim().slice(0, 24) : "";
		names[playerID] = name || "Anonymous";
		if (games[playerID]) {
			games[playerID].playerName = names[playerID];
			updateDraw(roomMapping[playerID].players);
		}
		broadcastRoomList();
	});

	socket.on("list_rooms", function() {
		socket.emit("room_list", { rooms: getRoomList() });
	});

	socket.on("create_room", function() {
		if (roomMapping[playerID]) return;
		var id = nextRoomId++;
		var room = roomCreator.createRoom(id);
		rooms[id] = room;
		addPlayerToRoom(socket, room);
	});

	socket.on("join_room", function(data) {
		if (roomMapping[playerID]) return;
		var room = rooms[data && data.roomId];
		if (!room) {
			socket.emit("join_failed", { reason: "Room no longer exists" });
			return;
		}
		if (room.isFull()) {
			socket.emit("join_failed", { reason: "Room is full" });
			return;
		}
		if (room.playing) {
			socket.emit("join_failed", { reason: "Game already in progress" });
			return;
		}
		addPlayerToRoom(socket, room);
	});

	socket.on("leave_room", function() {
		if (!roomMapping[playerID]) return;
		removePlayerFromRoom(playerID);
		sockets[playerID] = socket;
		socket.join("lobby");
		socket.emit("left_room");
		socket.emit("room_list", { rooms: getRoomList() });
	});

	socket.on("player_ready", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		room.playerReady(playerID);
		if (room.players.length > 1 && room.allReady()) {
			startGame(room);
		}
	});

	socket.on("right_click", function (data) {
		if (!games[data.id]) return;
		games[data.id].handleRightClick(data.r, data.c);
		updateDraw(roomMapping[playerID].players);
	});

	socket.on("left_click", function(data) {
		if (!games[data.id]) return;
		games[data.id].handleLeftClick(data.r, data.c);
		updateDraw(roomMapping[playerID].players);
	});

	socket.on("restart", function() {
		if (!games[playerID]) return;
		games[playerID].init();
		updateDraw(roomMapping[playerID].players);
	});

	socket.on("disconnect", function() {
		console.log("player disconnected: " + playerID);
		if (roomMapping[playerID]) {
			removePlayerFromRoom(playerID);
		}
		delete sockets[playerID];
		delete names[playerID];
	});
});

var port = process.env.PORT || 1337;
app.listen(port, "0.0.0.0", function() {
	console.log("listening on " + port);
});
