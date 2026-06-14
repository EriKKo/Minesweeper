// Small shared game helpers, extracted from minesweeperServer so the modules that need
// them require them directly (instead of receiving them through init(deps)): the bot/player
// predicates, the board obfuscator, the per-game broadcast payload, and updateDraw (push
// each player their draw_board frame). Depend only on appState + crypto.

var crypto = require("node:crypto");
var appState = require("./appState");

var bots = appState.bots, games = appState.games, sockets = appState.sockets, names = appState.names;

// Pack the full board into a XOR-masked byte blob the client decodes lazily from inside a
// closure. Not real anti-cheat, but the over-the-wire bytes aren't a readable JSON board.
function obfuscateBoard(board, rows, cols) {
	var bytes = Buffer.alloc(rows * cols);
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			bytes[r * cols + c] = board[r][c] === -1 ? 9 : board[r][c];
		}
	}
	var mask = crypto.randomBytes(256);
	for (var j = 0; j < bytes.length; j++) bytes[j] = bytes[j] ^ mask[j % mask.length];
	return { data: bytes.toString("base64"), mask: mask.toString("base64") };
}

// Per-game snapshot for a draw_board frame (no board — the client got the obfuscated board once).
function gameForBroadcast(g, pid) {
	if (!g) return null;
	var safeCount = g.revealedSafeCount ? g.revealedSafeCount() : 0;
	var totalSafe = g.totalSafeSquares || 0;
	return {
		id: pid,
		playerName: g.playerName,
		state: g.state,
		finished: g.finished,
		finishedAt: g.finishedAt,
		safeCount: safeCount,
		totalSafe: totalSafe,
		progress: totalSafe > 0 ? safeCount / totalSafe : 0,
		frozenUntil: g.frozenUntil,
		playing: g.playing
	};
}

function isBot(playerID) { return !!bots[playerID]; }

// The rating to show for an in-memory account: the per-style rating for a given ranked style,
// or — with no style (casual rooms, an "overall" view) — the player's best rating across modes.
// There is no single legacy `rating` field any more; "overall" always means max-across-modes.
function maxAccountRating(acc) {
	if (!acc) return null;
	return Math.max(acc.ratingSprint || 0, acc.ratingStandard || 0, acc.ratingTournament || 0, acc.ratingTerritory || 0);
}
function accountRating(acc, style) {
	if (!acc) return null;
	if (style === "sprint") return acc.ratingSprint;
	if (style === "standard") return acc.ratingStandard;
	if (style === "tournament") return acc.ratingTournament;
	if (style === "territory") return acc.ratingTerritory;
	return maxAccountRating(acc);
}

function humanCount(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) if (!isBot(room.players[i])) n++;
	return n;
}

function botCount(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) if (isBot(room.players[i])) n++;
	return n;
}

function getRoomBotNames(room) {
	var ret = [];
	for (var i = 0; i < room.players.length; i++) if (isBot(room.players[i])) ret.push(names[room.players[i]] || "");
	return ret;
}

// Push each player in the room their own draw_board frame (their board first, then opponents),
// and feed tournament spectators (cut players) a frame of the surviving boards.
function updateDraw(room) {
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		if (sockets[playerID]) {
			var orderedIds = [playerID];
			for (var k = 0; k < room.players.length; k++) {
				if (room.players[k] !== playerID) orderedIds.push(room.players[k]);
			}
			var stripped = orderedIds.map(function(pid) { return gameForBroadcast(games[pid], pid); });
			sockets[playerID].emit("draw_board", { games: stripped });
		}
	}
	if (room.tournamentEliminated) {
		var elimIds = Object.keys(room.tournamentEliminated);
		if (elimIds.length) {
			var spectatorGames = [null];
			for (var sp = 0; sp < room.players.length; sp++) {
				spectatorGames.push(gameForBroadcast(games[room.players[sp]], room.players[sp]));
			}
			for (var e = 0; e < elimIds.length; e++) {
				var elimSock = sockets[elimIds[e]];
				if (elimSock) elimSock.emit("draw_board", { games: spectatorGames });
			}
		}
	}
}

module.exports = {
	obfuscateBoard: obfuscateBoard,
	gameForBroadcast: gameForBroadcast,
	isBot: isBot,
	humanCount: humanCount,
	botCount: botCount,
	getRoomBotNames: getRoomBotNames,
	accountRating: accountRating,
	maxAccountRating: maxAccountRating,
	updateDraw: updateDraw
};
