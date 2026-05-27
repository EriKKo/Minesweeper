var PLAYERS_PER_ROOM = 6;
var DEFAULT_GAME_COUNT = 5;
var GAME_COUNT_OPTIONS = [1, 3, 5, 7, 10];
var DEFAULT_ROUND_SECONDS = 120;
var ROUND_SECONDS_OPTIONS = [60, 120, 180, 300, 0]; // 0 = unlimited
var DEFAULT_DEATH_PENALTY = 5;
var DEATH_PENALTY_OPTIONS = [0, 3, 5, 10];
var DEFAULT_MINE_COUNT = 30; // out of a 15x20 = 300 cell board
var MINE_COUNT_OPTIONS = [20, 30, 45, 60];

function createRoom(id, ownerID) {
	var players = [];
	var ready = {};
	var scores = {};
	var maxPlayers = PLAYERS_PER_ROOM;

	var room = {};
	room.id = id;
	room.owner = ownerID;
	room.players = players;
	room.maxPlayers = maxPlayers;
	room.phase = "planning";
	room.gameCount = DEFAULT_GAME_COUNT;
	room.roundSeconds = DEFAULT_ROUND_SECONDS;
	room.deathPenalty = DEFAULT_DEATH_PENALTY;
	room.mineCount = DEFAULT_MINE_COUNT;
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
	room.setMineCount = setMineCount;
	room.startSeries = startSeries;
	room.recordRoundResult = recordRoundResult;
	room.resetScores = resetScores;
	room.reassignOwnerIfNeeded = reassignOwnerIfNeeded;
	room.gameCountOptions = GAME_COUNT_OPTIONS.slice();
	room.roundSecondsOptions = ROUND_SECONDS_OPTIONS.slice();
	room.deathPenaltyOptions = DEATH_PENALTY_OPTIONS.slice();
	room.mineCountOptions = MINE_COUNT_OPTIONS.slice();

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

	function setMineCount(count) {
		if (MINE_COUNT_OPTIONS.indexOf(count) === -1) return false;
		if (room.phase !== "planning") return false;
		room.mineCount = count;
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
exports.MINE_COUNT_OPTIONS = MINE_COUNT_OPTIONS;
