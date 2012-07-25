var PLAYERS_PER_ROOM = 6;

function createRoom() {
	var players = [];
	var ready = {};
	var maxPlayers = PLAYERS_PER_ROOM;
	
	var room = {};
	room.players = players;
	room.addPlayer = addPlayer;
	room.deletePlayer = deletePlayer;
	room.resetReady = resetReady;
	room.playerReady = playerReady;
	room.allReady = allReady;
	room.isFull = isFull;
	
	function addPlayer(playerID) {
		players.push(playerID);
		ready[players[players.length-1]] = false;
	}
	
	function deletePlayer(playerID) {
		for (var i = 0; i < players.length; i++) {
			if (players[i] === playerID) {
				players.splice(i, 1);
				i--;
			}
		}
	}
	
	function resetReady() {
		for (var i = 0; i < players.length; i++) {
			ready[players[i]] = false;
		}
	}
	
	function playerReady(playerID) {
		ready[playerID] = true;
	}
	
	function allReady() {
		return players.every(function(player) {
			return ready[player];
		});
	}
	
	function isFull() {
		return players.length >= maxPlayers;
	}
	
	return room;
}

exports.createRoom = createRoom;