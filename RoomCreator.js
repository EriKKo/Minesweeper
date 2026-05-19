var PLAYERS_PER_ROOM = 6;
var DEFAULT_GAME_COUNT = 5;
var GAME_COUNT_OPTIONS = [1, 3, 5, 7, 10];

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
	room.startSeries = startSeries;
	room.recordGameWin = recordGameWin;
	room.resetScores = resetScores;
	room.reassignOwnerIfNeeded = reassignOwnerIfNeeded;
	room.gameCountOptions = GAME_COUNT_OPTIONS.slice();

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

	function startSeries() {
		room.phase = "playing";
		room.gamesPlayed = 0;
		room.lastGameWinner = null;
		room.seriesWinner = null;
		for (var i = 0; i < players.length; i++) {
			scores[players[i]] = 0;
		}
	}

	function recordGameWin(playerID) {
		if (playerID && scores.hasOwnProperty(playerID)) {
			scores[playerID]++;
		}
		room.lastGameWinner = playerID;
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
