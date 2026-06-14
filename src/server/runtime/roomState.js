// Room serialization + broadcast, extracted from minesweeperServer. Turns a room into the
// lobby summary (room_list) and the full room_state payload the client renders, and pushes
// them over socket.io. Reads room/game/account state from appState; isBot, io, and the
// bot/rating constants are injected via init to avoid a circular require.

var appState = require("./appState");
var botPlayer = require("../engine/BotPlayer");
var gameUtil = require("./gameUtil");

var names = appState.names, rooms = appState.rooms, roundDeadlines = appState.roundDeadlines;
var games = appState.games, accounts = appState.accounts, botRating = appState.botRating, botDifficulty = appState.botDifficulty;
var isBot = gameUtil.isBot, accountRating = gameUtil.accountRating;

var io, MAX_BOTS_PER_ROOM, RANKED_BOT_RATING, PROVISIONAL_GAMES;
function init(deps) {
	io = deps.io;
	MAX_BOTS_PER_ROOM = deps.MAX_BOTS_PER_ROOM;
	RANKED_BOT_RATING = deps.RANKED_BOT_RATING;
	PROVISIONAL_GAMES = deps.PROVISIONAL_GAMES;
}

function roomSummary(room) {
	return {
		id: room.id,
		ownerName: names[room.owner] || "Anonymous",
		playerCount: room.players.length,
		humanCount: room.players.filter(function(pid) { return !isBot(pid); }).length,
		maxPlayers: room.maxPlayers,
		phase: room.phase,
		gameMode: room.gameMode || "race",
		gameCount: room.gameCount,
		gamesPlayed: room.gamesPlayed,
		roundSeconds: room.roundSeconds,
		deathPenalty: room.deathPenalty,
		boardSize: room.boardSize,
		mineDensity: room.mineDensity,
		players: room.players.map(function(pid) { return names[pid] || "Anonymous"; })
	};
}

function getRoomList() {
	return Object.keys(rooms)
		.filter(function(id) { return !rooms[id].ranked; })
		.map(function(id) { return roomSummary(rooms[id]); });
}

function broadcastRoomList() {
	io.to("lobby").emit("room_list", { rooms: getRoomList() });
}

function buildRoomState(room) {
	return {
		id: room.id,
		owner: room.owner,
		ranked: !!room.ranked,
		rankedMode: room.rankedMode || null,
		gameMode: room.gameMode || "race",
		phase: room.phase,
		gameCount: room.gameCount,
		gamesPlayed: room.gamesPlayed,
		scoreTarget: room.scoreTarget || null,
		tournamentSchedule: room.tournamentSchedule || null,
		roundSeconds: room.roundSeconds,
		deathPenalty: room.deathPenalty,
		mineDensity: room.mineDensity,
		boardSize: room.boardSize,
		rows: room.rows,
		cols: room.cols,
		roundDeadline: roundDeadlines[room.id] || null,
		lastGameWinner: room.lastGameWinner,
		lastGameWinnerName: room.lastGameWinner ? names[room.lastGameWinner] : null,
		seriesWinner: room.seriesWinner,
		seriesWinnerName: room.seriesWinner ? names[room.seriesWinner] : null,
		gameCountOptions: room.gameCountOptions,
		roundSecondsOptions: room.roundSecondsOptions,
		deathPenaltyOptions: room.deathPenaltyOptions,
		mineDensityOptions: room.mineDensityOptions,
		boardSizeOptions: room.boardSizeOptions,
		botDifficultyOptions: botPlayer.DIFFICULTIES,
		botCount: room.players.filter(function(pid) { return isBot(pid); }).length,
		maxBots: MAX_BOTS_PER_ROOM,
		players: room.players.map(function(pid) {
			var g = games[pid];
			var bot = isBot(pid);
			var rating = bot ? (botRating[pid] || RANKED_BOT_RATING)
				: accountRating(accounts[pid], room.rankedStyle);
			var provisional = bot ? false
				: (accounts[pid] ? accounts[pid].played < PROVISIONAL_GAMES : false);
			return {
				id: pid,
				name: names[pid] || "Anonymous",
				ready: room.isReady(pid),
				score: room.scores[pid] || 0,
				isOwner: pid === room.owner,
				isBot: bot,
				difficulty: bot ? (botDifficulty[pid] || null) : null,
				rating: rating,
				provisional: provisional,
				finished: g ? !!g.finished : false
			};
		})
	};
}

function broadcastRoomState(room) {
	io.to("room:" + room.id).emit("room_state", buildRoomState(room));
}

module.exports = {
	init: init,
	getRoomList: getRoomList,
	broadcastRoomList: broadcastRoomList,
	broadcastRoomState: broadcastRoomState
};
