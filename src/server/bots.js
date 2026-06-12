// Racing-bot orchestration, extracted from minesweeperServer: adding/removing bots,
// applying their per-move config to the game, and the per-move tick loop that drives
// them (decideMove -> a delayed handleLeftClick, then reschedule). The bots play through
// the same game objects + move path as humans, so the game-loop services they touch
// (updateDraw, createPlayerGame) and the shared predicates (isBot/botCount/getRoomBotNames,
// which stay in the core because they're used everywhere) are injected via init(deps).
// Per-bot state lives in appState. Territory has its own bot tick (territory.js); this is
// the racing/casual/ranked one.

var appState = require("./appState");
var botPlayer = require("./BotPlayer");

// Per-bot state (same objects the server holds).
var bots = appState.bots, botTickHandles = appState.botTickHandles, botLastClick = appState.botLastClick;
var games = appState.games, rooms = appState.rooms, roomMapping = appState.roomMapping, names = appState.names;
var botDifficulty = appState.botDifficulty, botSpeedMs = appState.botSpeedMs, botDifficultyMs = appState.botDifficultyMs;
var botDistanceMult = appState.botDistanceMult, botMaxDifficulty = appState.botMaxDifficulty, botRating = appState.botRating;
var botMistake = appState.botMistake, botChord = appState.botChord;

// Core services + shared predicates injected at boot to avoid a circular require.
var isBot, botCount, getRoomBotNames, updateDraw, createPlayerGame, newBotId, RANKED_BOT_RATING, MAX_BOTS_PER_ROOM;
function init(deps) {
	isBot = deps.isBot;
	botCount = deps.botCount;
	getRoomBotNames = deps.getRoomBotNames;
	updateDraw = deps.updateDraw;
	createPlayerGame = deps.createPlayerGame;
	newBotId = deps.newBotId;
	RANKED_BOT_RATING = deps.RANKED_BOT_RATING;
	MAX_BOTS_PER_ROOM = deps.MAX_BOTS_PER_ROOM;
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

	var delay = botPlayer.computeMoveDelay(game, botLastClick[botId] || null, move);
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
// Copy a bot's stored per-move variables onto its current game object (decideMove /
// computeMoveDelay read them from there). The per-board difficulty map is set
// separately at round start (it comes from the template, not the bot).
function applyBotConfigToGame(botId) {
	var g = games[botId];
	if (!g) return;
	g.botSpeedMs = botSpeedMs[botId];
	g.botDifficultyMs = botDifficultyMs[botId];
	g.botDistanceMult = botDistanceMult[botId];
	g.botMaxDifficulty = botMaxDifficulty[botId];
	g.botMistakeRate = botMistake[botId];
	g.botChordRate = botChord[botId];
}

function addBotToRoom(room, config, prechosenName) {
	if (room.phase !== "planning") return false;
	if (room.isFull()) return false;
	if (botCount(room) >= MAX_BOTS_PER_ROOM) return false;
	var botId = "bot:" + newBotId();
	bots[botId] = true;
	names[botId] = prechosenName || botPlayer.pickBotName(getRoomBotNames(room));
	games[botId] = createPlayerGame(botId, room.rows, room.cols);
	if (config) {
		// Elo-tuned bot (ranked, from the pool): explicit per-move variables + rating.
		botDifficulty[botId] = null;
	} else {
		// Casual room: derive the variable set from the difficulty preset.
		botDifficulty[botId] = botPlayer.DEFAULT_DIFFICULTY;
		config = botPlayer.configForDifficulty(botDifficulty[botId]);
		config.rating = RANKED_BOT_RATING;
	}
	botSpeedMs[botId] = config.speedMs;
	botDifficultyMs[botId] = config.difficultyMs;
	botDistanceMult[botId] = config.distanceMult;
	botMaxDifficulty[botId] = config.maxDifficulty;
	botMistake[botId] = config.mistakeRate;
	botChord[botId] = (typeof config.chordRate === "number") ? config.chordRate : 0;
	botRating[botId] = config.rating || RANKED_BOT_RATING;
	applyBotConfigToGame(botId);
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
	delete botSpeedMs[botId];
	delete botDifficultyMs[botId];
	delete botDistanceMult[botId];
	delete botMaxDifficulty[botId];
	delete botRating[botId];
	delete botMistake[botId];
	delete botChord[botId];
	delete botLastClick[botId];
}

module.exports = {
	init: init,
	addBotToRoom: addBotToRoom,
	removeOneBotFromRoom: removeOneBotFromRoom,
	startBotTicksForRoom: startBotTicksForRoom,
	clearRoomBotTicks: clearRoomBotTicks,
	clearBotTick: clearBotTick,
	readyAllBots: readyAllBots,
	applyBotConfigToGame: applyBotConfigToGame
};
