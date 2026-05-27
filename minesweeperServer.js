var http = require("http")
  , fs = require("fs")
  , path = require("path")
  , gameCreator = require("./GameCreator")
  , roomCreator = require("./RoomCreator")
  , botPlayer = require("./BotPlayer");

var COUNT_DOWN_TIME = 3;
var BETWEEN_GAMES_DELAY = 3000;
var SERIES_END_DELAY = 6000;

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
var nextGameTimers = {};
var roundTimers = {};
var roundDeadlines = {};
var bots = {}; // botId -> true
var botDifficulty = {}; // botId -> "easy" | "medium" | "hard"
var botTickHandles = {}; // botId -> setTimeout handle
var botLastClick = {}; // botId -> {r, c} of the bot's most recent click in the current round
var nextBotId = 1;
var MAX_BOTS_PER_ROOM = 3;

function isBot(playerID) {
	return !!bots[playerID];
}

function roomSummary(room) {
	return {
		id: room.id,
		ownerName: names[room.owner] || "Anonymous",
		playerCount: room.players.length,
		humanCount: room.players.filter(function(pid) { return !isBot(pid); }).length,
		maxPlayers: room.maxPlayers,
		phase: room.phase,
		gameCount: room.gameCount,
		gamesPlayed: room.gamesPlayed,
		roundSeconds: room.roundSeconds,
		deathPenalty: room.deathPenalty,
		players: room.players.map(function(pid) { return names[pid] || "Anonymous"; })
	};
}

function getRoomList() {
	return Object.keys(rooms).map(function(id) { return roomSummary(rooms[id]); });
}

function broadcastRoomList() {
	io.to("lobby").emit("room_list", { rooms: getRoomList() });
}

function buildRoomState(room) {
	return {
		id: room.id,
		owner: room.owner,
		phase: room.phase,
		gameCount: room.gameCount,
		gamesPlayed: room.gamesPlayed,
		roundSeconds: room.roundSeconds,
		deathPenalty: room.deathPenalty,
		mineCount: room.mineCount,
		roundDeadline: roundDeadlines[room.id] || null,
		lastGameWinner: room.lastGameWinner,
		lastGameWinnerName: room.lastGameWinner ? names[room.lastGameWinner] : null,
		seriesWinner: room.seriesWinner,
		seriesWinnerName: room.seriesWinner ? names[room.seriesWinner] : null,
		gameCountOptions: room.gameCountOptions,
		roundSecondsOptions: room.roundSecondsOptions,
		deathPenaltyOptions: room.deathPenaltyOptions,
		mineCountOptions: room.mineCountOptions,
		botDifficultyOptions: botPlayer.DIFFICULTIES,
		botCount: room.players.filter(function(pid) { return isBot(pid); }).length,
		maxBots: MAX_BOTS_PER_ROOM,
		players: room.players.map(function(pid) {
			var g = games[pid];
			return {
				id: pid,
				name: names[pid] || "Anonymous",
				ready: room.isReady(pid),
				score: room.scores[pid] || 0,
				isOwner: pid === room.owner,
				isBot: isBot(pid),
				difficulty: isBot(pid) ? (botDifficulty[pid] || botPlayer.DEFAULT_DIFFICULTY) : null,
				finished: g ? !!g.finished : false
			};
		})
	};
}

function broadcastRoomState(room) {
	io.to("room:" + room.id).emit("room_state", buildRoomState(room));
}

function clearRoundTimer(roomId) {
	if (roundTimers[roomId]) {
		clearTimeout(roundTimers[roomId]);
		delete roundTimers[roomId];
	}
	delete roundDeadlines[roomId];
}

function clearBotTick(botId) {
	if (botTickHandles[botId]) {
		clearTimeout(botTickHandles[botId]);
		delete botTickHandles[botId];
	}
}

function clearRoomBotTicks(room) {
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (isBot(pid)) clearBotTick(pid);
	}
}

function readyAllBots(room) {
	for (var i = 0; i < room.players.length; i++) {
		if (isBot(room.players[i])) room.playerReady(room.players[i]);
	}
}

function scheduleBotTick(room, botId) {
	clearBotTick(botId);
	if (!rooms[room.id]) return;
	if (roomMapping[botId] !== room) return;
	if (room.phase !== "playing") return;
	var game = games[botId];
	if (!game || !game.playing) return;

	var now = Date.now();
	if (now < game.frozenUntil) {
		botTickHandles[botId] = setTimeout(function() {
			delete botTickHandles[botId];
			scheduleBotTick(room, botId);
		}, game.frozenUntil - now + 50);
		return;
	}

	var move;
	try {
		move = botPlayer.decideMove(game);
	} catch (e) {
		console.error("bot decideMove error", e);
		return;
	}
	if (!move) return;

	var baseMs = botPlayer.speedFor(botDifficulty[botId]);
	var delay = botPlayer.computeMoveDelay(baseMs, botLastClick[botId] || null, move);
	botTickHandles[botId] = setTimeout(function() {
		delete botTickHandles[botId];
		runBotMove(room, botId, move);
	}, delay);
}

function runBotMove(room, botId, move) {
	if (!rooms[room.id]) return;
	if (roomMapping[botId] !== room) return;
	if (room.phase !== "playing") return;
	var game = games[botId];
	if (!game || !game.playing) return;
	if (Date.now() < game.frozenUntil) {
		// got frozen while waiting — re-plan after the freeze ends
		scheduleBotTick(room, botId);
		return;
	}
	try {
		if (move.type === "left") game.handleLeftClick(move.r, move.c);
		else if (move.type === "right") game.handleRightClick(move.r, move.c);
		botLastClick[botId] = { r: move.r, c: move.c };
		updateDraw(room);
	} catch (e) {
		console.error("bot runMove error", e);
	}
	if (game.playing) {
		scheduleBotTick(room, botId);
	}
}

function startBotTicksForRoom(room) {
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (isBot(pid)) {
			// New round — bot hasn't looked at the board yet
			delete botLastClick[pid];
			scheduleBotTick(room, pid);
		}
	}
}

function humanCount(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		if (!isBot(room.players[i])) n++;
	}
	return n;
}

function botCount(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		if (isBot(room.players[i])) n++;
	}
	return n;
}

function getRoomBotNames(room) {
	var ret = [];
	for (var i = 0; i < room.players.length; i++) {
		if (isBot(room.players[i])) ret.push(names[room.players[i]] || "");
	}
	return ret;
}

function addBotToRoom(room) {
	if (room.phase !== "planning") return false;
	if (room.isFull()) return false;
	if (botCount(room) >= MAX_BOTS_PER_ROOM) return false;
	var botId = "bot:" + (nextBotId++);
	bots[botId] = true;
	botDifficulty[botId] = botPlayer.DEFAULT_DIFFICULTY;
	names[botId] = botPlayer.pickBotName(getRoomBotNames(room));
	games[botId] = createPlayerGame(botId);
	games[botId].botMistakeRate = botPlayer.mistakeRateFor(botDifficulty[botId]);
	roomMapping[botId] = room;
	room.addPlayer(botId);
	room.playerReady(botId);
	return true;
}

function removeOneBotFromRoom(room) {
	for (var i = room.players.length - 1; i >= 0; i--) {
		var pid = room.players[i];
		if (isBot(pid)) {
			removeBotEntirely(pid);
			return true;
		}
	}
	return false;
}

function removeBotEntirely(botId) {
	var room = roomMapping[botId];
	clearBotTick(botId);
	if (room) room.deletePlayer(botId);
	delete roomMapping[botId];
	delete games[botId];
	delete names[botId];
	delete bots[botId];
	delete botDifficulty[botId];
	delete botLastClick[botId];
}

function deleteRoomIfEmpty(room) {
	if (room.players.length === 0) {
		if (nextGameTimers[room.id]) {
			clearTimeout(nextGameTimers[room.id]);
			delete nextGameTimers[room.id];
		}
		clearRoundTimer(room.id);
		delete rooms[room.id];
		return true;
	}
	return false;
}

function countActivePlayers(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		var g = games[room.players[i]];
		if (g && !g.finished) n++;
	}
	return n;
}

function countFinishedPlayers(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		var g = games[room.players[i]];
		if (g && g.finished) n++;
	}
	return n;
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

function updateDraw(room) {
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		if (sockets[playerID]) {
			sockets[playerID].emit("draw_board", {games: getGamesWithPlayerOnTop(playerID, room.players)});
		}
	}
}

function computeSeriesWinner(room) {
	var best = -1;
	var leaders = [];
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		var s = room.scores[pid] || 0;
		if (s > best) {
			best = s;
			leaders = [pid];
		} else if (s === best) {
			leaders.push(pid);
		}
	}
	if (leaders.length === 1 && best > 0) return leaders[0];
	return null; // tie or no winner
}

// Rank players for the round. Finishers (those who cleared their board) always
// outrank non-finishers; among finishers, earlier finishedAt is better; among
// non-finishers, higher safeCount is better. Standard competition ranking on
// ties — equally-ranked players share the higher rank and the next rank skips.
// Points are N, N-1, ... down to 1 by rank.
function rankCompare(a, b) {
	if (a.finished !== b.finished) return a.finished ? 1 : -1;
	if (a.finished) {
		if (a.finishedAt !== b.finishedAt) return a.finishedAt < b.finishedAt ? 1 : -1;
		return 0;
	}
	if (a.safeCount !== b.safeCount) return a.safeCount > b.safeCount ? 1 : -1;
	return 0;
}

function buildStandings(room) {
	var N = room.players.length;
	var entries = room.players.map(function(pid) {
		var g = games[pid];
		return {
			id: pid,
			name: names[pid] || "Anonymous",
			safeCount: g ? g.revealedSafeCount() : 0,
			finished: g ? !!g.finished : false,
			finishedAt: g ? (g.finishedAt || 0) : 0
		};
	});
	for (var i = 0; i < entries.length; i++) {
		var strictlyHigher = 0;
		for (var j = 0; j < entries.length; j++) {
			if (i === j) continue;
			if (rankCompare(entries[j], entries[i]) > 0) strictlyHigher++;
		}
		entries[i].rank = strictlyHigher + 1;
		entries[i].points = N - strictlyHigher;
	}
	entries.sort(function(a, b) { return a.rank - b.rank; });
	return entries;
}

function endIndividualGame(room, reason) {
	if (room.phase !== "playing") return;
	clearRoundTimer(room.id);
	clearRoomBotTicks(room);
	for (var i = 0; i < room.players.length; i++) {
		if (games[room.players[i]]) games[room.players[i]].playing = false;
	}
	var standings = buildStandings(room);
	// Round winner = unique top-ranked player, if any.
	var winnerID = null;
	if (standings.length > 0 && standings[0].rank === 1) {
		var tiedAtTop = 0;
		for (var k = 0; k < standings.length; k++) if (standings[k].rank === 1) tiedAtTop++;
		if (tiedAtTop === 1) winnerID = standings[0].id;
	}
	room.recordRoundResult(standings, winnerID);
	io.to("room:" + room.id).emit("game_result", {
		winnerId: winnerID,
		winnerName: winnerID ? names[winnerID] : null,
		gameNumber: room.gamesPlayed,
		gameCount: room.gameCount,
		reason: reason || "cleared",
		standings: standings
	});
	broadcastRoomState(room);

	if (room.gamesPlayed >= room.gameCount) {
		endSeries(room);
	} else {
		nextGameTimers[room.id] = setTimeout(function() {
			delete nextGameTimers[room.id];
			if (rooms[room.id] && room.phase === "playing" && room.players.length > 1) {
				startGame(room);
			} else if (rooms[room.id] && room.players.length <= 1) {
				endSeries(room);
			}
		}, BETWEEN_GAMES_DELAY);
	}
}

function handleRoundTimeUp(room) {
	delete roundTimers[room.id];
	if (room.phase !== "playing") return;
	endIndividualGame(room, "timeout");
}

function reduceRoundDeadline(room, targetSeconds) {
	var newDeadline = Date.now() + targetSeconds * 1000;
	if (roundDeadlines[room.id] && roundDeadlines[room.id] <= newDeadline) return;
	roundDeadlines[room.id] = newDeadline;
	if (roundTimers[room.id]) clearTimeout(roundTimers[room.id]);
	roundTimers[room.id] = setTimeout(function() {
		handleRoundTimeUp(room);
	}, targetSeconds * 1000);
}

function endSeries(room) {
	if (nextGameTimers[room.id]) {
		clearTimeout(nextGameTimers[room.id]);
		delete nextGameTimers[room.id];
	}
	room.seriesWinner = computeSeriesWinner(room);
	room.phase = "planning";
	io.to("room:" + room.id).emit("series_ended", {
		winnerId: room.seriesWinner,
		winnerName: room.seriesWinner ? names[room.seriesWinner] : null,
		scores: room.players.map(function(pid) {
			return { id: pid, name: names[pid] || "Anonymous", score: room.scores[pid] || 0 };
		})
	});
	broadcastRoomState(room);
	broadcastRoomList();

	setTimeout(function() {
		if (!rooms[room.id]) return;
		room.resetScores();
		room.resetReady();
		readyAllBots(room);
		broadcastRoomState(room);
	}, SERIES_END_DELAY);
}

function gameWin(playerID) {
	var room = roomMapping[playerID];
	if (!room || room.phase !== "playing") return;
	var game = games[playerID];
	if (!game || !game.playing || game.finished) return;

	game.finished = true;
	game.finishedAt = Date.now();
	game.playing = false;

	// First finish in this round? Pull the remaining time down to 20s so others
	// still in play have a hard deadline to also clear.
	if (countFinishedPlayers(room) === 1) {
		reduceRoundDeadline(room, 20);
	}

	if (isBot(playerID)) {
		clearBotTick(playerID);
	}

	updateDraw(room);
	broadcastRoomState(room);

	// As soon as only one (or zero) players are still active, end the round.
	// The 20s timer reduction above still applies as a safety for the case where
	// the last active player(s) don't finish in time.
	if (countActivePlayers(room) <= 1) {
		endIndividualGame(room, "cleared");
	}
}

function gameMineHit(playerID) {
	var room = roomMapping[playerID];
	if (!room || room.phase !== "playing") return;
	var game = games[playerID];
	if (!game) return;
	var penaltyMs = room.deathPenalty * 1000;
	game.frozenUntil = Date.now() + penaltyMs;
	if (sockets[playerID]) {
		sockets[playerID].emit("mine_hit", { frozenUntil: game.frozenUntil, penaltySeconds: room.deathPenalty });
	}
}

function startGame(room) {
	clearRoundTimer(room.id);
	var centerR = Math.floor(gameCreator.rows / 2);
	var centerC = Math.floor(gameCreator.cols / 2);
	var template = gameCreator.createTemplate(centerR, centerC, room.mineCount);
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (!games[pid]) {
			games[pid] = createPlayerGame(pid);
		}
		games[pid].init(template);
	}
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (sockets[pid]) {
			sockets[pid].emit("start_game", {
				time: COUNT_DOWN_TIME,
				gameNumber: room.gamesPlayed + 1,
				gameCount: room.gameCount,
				roundSeconds: room.roundSeconds,
				deathPenalty: room.deathPenalty
			});
		}
	}
	setTimeout(function() {
		if (!rooms[room.id] || room.phase !== "playing") return;
		for (var i = 0; i < room.players.length; i++) {
			var pid = room.players[i];
			if (games[pid]) games[pid].playing = true;
		}
		if (room.roundSeconds > 0) {
			roundDeadlines[room.id] = Date.now() + room.roundSeconds * 1000;
			roundTimers[room.id] = setTimeout(function() {
				handleRoundTimeUp(room);
			}, room.roundSeconds * 1000);
		}
		broadcastRoomState(room);
		updateDraw(room);
		startBotTicksForRoom(room);
	}, COUNT_DOWN_TIME * 1000);
}

function startSeries(room) {
	room.startSeries();
	broadcastRoomState(room);
	broadcastRoomList();
	startGame(room);
}

function createPlayerGame(playerID) {
	var game = gameCreator.createGame();
	game.playerName = names[playerID] || "Anonymous";
	game.win = function() { gameWin(playerID); };
	game.mineHit = function() { gameMineHit(playerID); };
	return game;
}

function addPlayerToRoom(socket, room) {
	var playerID = socket.id;
	games[playerID] = createPlayerGame(playerID);
	roomMapping[playerID] = room;
	room.addPlayer(playerID);

	socket.leave("lobby");
	socket.join("room:" + room.id);
	socket.emit("joined_room", { roomId: room.id });
	broadcastRoomState(room);
	broadcastRoomList();
}

function removePlayerFromRoom(playerID) {
	var room = roomMapping[playerID];
	if (!room) return;
	var wasPlaying = room.phase === "playing";
	room.deletePlayer(playerID);
	delete roomMapping[playerID];
	delete games[playerID];
	if (sockets[playerID]) {
		sockets[playerID].leave("room:" + room.id);
	}

	// If no humans remain, evict all bots so the room can be cleaned up.
	if (humanCount(room) === 0) {
		while (botCount(room) > 0) {
			removeOneBotFromRoom(room);
		}
	}

	if (deleteRoomIfEmpty(room)) {
		broadcastRoomList();
		return;
	}

	// Prefer a human as the new owner if the previous owner left.
	if (room.players.indexOf(room.owner) === -1) {
		var newOwner = null;
		for (var i = 0; i < room.players.length; i++) {
			if (!isBot(room.players[i])) { newOwner = room.players[i]; break; }
		}
		if (newOwner) room.owner = newOwner;
		else room.reassignOwnerIfNeeded();
	}

	if (wasPlaying) {
		// Down to a single player mid-round — end the round so the series can advance.
		if (room.players.length === 1) {
			endIndividualGame(room, "cleared");
		} else {
			updateDraw(room);
			// Only one (or zero) players still actively playing — end the round.
			if (countActivePlayers(room) <= 1) {
				endIndividualGame(room, "cleared");
			}
		}
	} else {
		broadcastRoomState(room);
	}
	broadcastRoomList();
}

io.on("connection", function (socket) {
	var playerID = socket.id;
	sockets[playerID] = socket;
	socket.join("lobby");
	socket.emit("connected", { id: playerID });

	socket.on("set_name", function(data) {
		var name = (data && typeof data.name === "string") ? data.name.trim().slice(0, 24) : "";
		if (!name) {
			socket.emit("name_rejected", { reason: "Name cannot be empty" });
			return;
		}
		var isFirst = !names[playerID];
		names[playerID] = name;
		if (games[playerID]) {
			games[playerID].playerName = name;
			updateDraw(roomMapping[playerID]);
		}
		socket.emit("name_accepted", { name: name });
		if (isFirst) {
			socket.emit("room_list", { rooms: getRoomList() });
		} else {
			if (roomMapping[playerID]) broadcastRoomState(roomMapping[playerID]);
			broadcastRoomList();
		}
	});

	socket.on("list_rooms", function() {
		socket.emit("room_list", { rooms: getRoomList() });
	});

	socket.on("create_room", function() {
		if (!names[playerID]) return;
		if (roomMapping[playerID]) return;
		var id = nextRoomId++;
		var room = roomCreator.createRoom(id, playerID);
		rooms[id] = room;
		addPlayerToRoom(socket, room);
	});

	socket.on("join_room", function(data) {
		if (!names[playerID]) return;
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
		if (room.phase !== "planning") {
			socket.emit("join_failed", { reason: "Series in progress" });
			return;
		}
		addPlayerToRoom(socket, room);
	});

	socket.on("leave_room", function() {
		if (!roomMapping[playerID]) return;
		var socketRef = sockets[playerID];
		removePlayerFromRoom(playerID);
		if (socketRef) {
			socketRef.join("lobby");
			socketRef.emit("left_room");
			socketRef.emit("room_list", { rooms: getRoomList() });
		}
	});

	socket.on("set_game_count", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var count = data && parseInt(data.count, 10);
		if (room.setGameCount(count)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_round_seconds", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var seconds = data && parseInt(data.seconds, 10);
		if (room.setRoundSeconds(seconds)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_death_penalty", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var seconds = data && parseInt(data.seconds, 10);
		if (room.setDeathPenalty(seconds)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_mine_count", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var count = data && parseInt(data.count, 10);
		if (room.setMineCount(count)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_bot_difficulty", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (room.phase !== "planning") return;
		var botId = data && data.botId;
		var difficulty = data && data.difficulty;
		if (!isBot(botId) || roomMapping[botId] !== room) return;
		if (botPlayer.DIFFICULTIES.indexOf(difficulty) === -1) return;
		botDifficulty[botId] = difficulty;
		if (games[botId]) games[botId].botMistakeRate = botPlayer.mistakeRateFor(difficulty);
		broadcastRoomState(room);
	});

	socket.on("add_bot", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (!addBotToRoom(room)) return;
		broadcastRoomState(room);
		broadcastRoomList();
		// If the owner had already readied before adding the bot, start now.
		if (room.players.length > 1 && room.allReady() && humanCount(room) > 0) {
			startSeries(room);
		}
	});

	socket.on("remove_bot", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (room.phase !== "planning") return;
		if (!removeOneBotFromRoom(room)) return;
		broadcastRoomState(room);
		broadcastRoomList();
	});

	socket.on("player_ready", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.phase !== "planning") return;
		room.playerReady(playerID);
		broadcastRoomState(room);
		if (room.players.length > 1 && room.allReady()) {
			startSeries(room);
		}
	});

	socket.on("right_click", function (data) {
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleRightClick(data.r, data.c);
		updateDraw(room);
	});

	socket.on("left_click", function(data) {
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleLeftClick(data.r, data.c);
		updateDraw(room);
	});

	socket.on("disconnect", function() {
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
