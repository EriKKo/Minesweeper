var PLAYERS_PER_ROOM = 6;
var DEFAULT_GAME_COUNT = 5;
var GAME_COUNT_OPTIONS = [1, 3, 5, 7, 10];
var DEFAULT_ROUND_SECONDS = 120;
var ROUND_SECONDS_OPTIONS = [60, 120, 180, 300, 0]; // 0 = unlimited
var DEFAULT_DEATH_PENALTY = 5;
var DEATH_PENALTY_OPTIONS = [0, 3, 5, 10];
// Mines are a fraction of the board so density stays consistent across sizes.
var DEFAULT_MINE_DENSITY = 0.10;
// Custom rooms pick density on a 10%–30% slider; these bound it (whole-percent steps).
var MINE_DENSITY_MIN_PCT = 10;
var MINE_DENSITY_MAX_PCT = 30;
// Kept for any legacy consumers of the discrete list (the live UI uses the slider above).
var MINE_DENSITY_OPTIONS = [0.10, 0.15, 0.20];
var BOARD_SIZES = {
	small: { rows: 10, cols: 13 },
	medium: { rows: 15, cols: 20 },
	large: { rows: 16, cols: 30 }
};
var BOARD_SIZE_OPTIONS = ["small", "medium", "large"];
var DEFAULT_BOARD_SIZE = "medium";

function createRoom(id, ownerID, customMaxPlayers) {
	var players = [];
	var ready = {};
	var scores = {};
	var maxPlayers = customMaxPlayers || PLAYERS_PER_ROOM;

	var room = {};
	room.id = id;
	room.owner = ownerID;
	room.players = players;
	room.maxPlayers = maxPlayers;
	room.phase = "planning";
	room.gameCount = DEFAULT_GAME_COUNT;
	room.roundSeconds = DEFAULT_ROUND_SECONDS;
	room.deathPenalty = DEFAULT_DEATH_PENALTY;
	room.mineDensity = DEFAULT_MINE_DENSITY;
	room.boardSize = DEFAULT_BOARD_SIZE;
	room.rows = BOARD_SIZES[DEFAULT_BOARD_SIZE].rows;
	room.cols = BOARD_SIZES[DEFAULT_BOARD_SIZE].cols;
	room.gamesPlayed = 0;
	room.lastGameWinner = null;
	room.seriesWinner = null;
	room.ready = ready;
	room.scores = scores;

	room.addPlayer = addPlayer;
	room.deletePlayer = deletePlayer;
	room.resetReady = resetReady;
	room.playerReady = playerReady;
	room.isReady = isReady;
	room.allReady = allReady;
	room.isFull = isFull;
	room.setGameCount = setGameCount;
	room.setRoundSeconds = setRoundSeconds;
	room.setDeathPenalty = setDeathPenalty;
	room.setMineDensity = setMineDensity;
	room.setBoardSize = setBoardSize;
	room.startSeries = startSeries;
	room.recordRoundResult = recordRoundResult;
	room.resetScores = resetScores;
	room.reassignOwnerIfNeeded = reassignOwnerIfNeeded;
	room.gameCountOptions = GAME_COUNT_OPTIONS.slice();
	room.roundSecondsOptions = ROUND_SECONDS_OPTIONS.slice();
	room.deathPenaltyOptions = DEATH_PENALTY_OPTIONS.slice();
	room.mineDensityOptions = MINE_DENSITY_OPTIONS.slice();
	room.boardSizeOptions = BOARD_SIZE_OPTIONS.slice();

	function addPlayer(playerID) {
		players.push(playerID);
		ready[playerID] = false;
		scores[playerID] = 0;
	}

	function deletePlayer(playerID) {
		for (var i = 0; i < players.length; i++) {
			if (players[i] === playerID) {
				players.splice(i, 1);
				i--;
			}
		}
		delete ready[playerID];
		delete scores[playerID];
	}

	function reassignOwnerIfNeeded() {
		if (players.indexOf(room.owner) === -1 && players.length > 0) {
			room.owner = players[0];
		}
	}

	function resetReady() {
		for (var i = 0; i < players.length; i++) {
			ready[players[i]] = false;
		}
	}

	function playerReady(playerID) {
		if (room.phase !== "planning") return;
		ready[playerID] = true;
	}

	function isReady(playerID) {
		return !!ready[playerID];
	}

	function allReady() {
		if (players.length === 0) return false;
		return players.every(function(player) {
			return ready[player];
		});
	}

	function isFull() {
		return players.length >= maxPlayers;
	}

	function setGameCount(count) {
		if (GAME_COUNT_OPTIONS.indexOf(count) === -1) return false;
		if (room.phase !== "planning") return false;
		room.gameCount = count;
		return true;
	}

	function setRoundSeconds(seconds) {
		if (ROUND_SECONDS_OPTIONS.indexOf(seconds) === -1) return false;
		if (room.phase !== "planning") return false;
		room.roundSeconds = seconds;
		return true;
	}

	function setDeathPenalty(seconds) {
		if (DEATH_PENALTY_OPTIONS.indexOf(seconds) === -1) return false;
		if (room.phase !== "planning") return false;
		room.deathPenalty = seconds;
		return true;
	}

	function setMineDensity(density) {
		if (room.phase !== "planning") return false;
		if (typeof density !== "number" || isNaN(density)) return false;
		// Continuous slider on the client — accept any whole percent from 10% to 30%.
		var pct = Math.round(density * 100);
		if (pct < MINE_DENSITY_MIN_PCT || pct > MINE_DENSITY_MAX_PCT) return false;
		room.mineDensity = pct / 100;
		return true;
	}

	function setBoardSize(size) {
		if (!BOARD_SIZES[size]) return false;
		if (room.phase !== "planning") return false;
		room.boardSize = size;
		room.rows = BOARD_SIZES[size].rows;
		room.cols = BOARD_SIZES[size].cols;
		return true;
	}

	function startSeries() {
		room.phase = "playing";
		room.gamesPlayed = 0;
		room.lastGameWinner = null;
		room.seriesWinner = null;
		for (var i = 0; i < players.length; i++) {
			scores[players[i]] = 0;
		}
	}

	function recordRoundResult(standings, winnerID) {
		for (var i = 0; i < standings.length; i++) {
			var s = standings[i];
			if (scores.hasOwnProperty(s.id)) {
				scores[s.id] += s.points;
			}
		}
		room.lastGameWinner = winnerID;
		room.gamesPlayed++;
	}

	function resetScores() {
		for (var i = 0; i < players.length; i++) {
			scores[players[i]] = 0;
		}
		room.gamesPlayed = 0;
		room.lastGameWinner = null;
		room.seriesWinner = null;
	}

	return room;
}

exports.createRoom = createRoom;
exports.GAME_COUNT_OPTIONS = GAME_COUNT_OPTIONS;
exports.ROUND_SECONDS_OPTIONS = ROUND_SECONDS_OPTIONS;
exports.DEATH_PENALTY_OPTIONS = DEATH_PENALTY_OPTIONS;
exports.MINE_DENSITY_OPTIONS = MINE_DENSITY_OPTIONS;
exports.BOARD_SIZES = BOARD_SIZES;
exports.BOARD_SIZE_OPTIONS = BOARD_SIZE_OPTIONS;
