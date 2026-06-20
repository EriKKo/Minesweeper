// Stable player identity (PHASE1_TICKETS.md P1-2).
//
// Today the live-game runtime uses socket.id as a player's local handle, which is fine in one process.
// But a split player holds TWO sockets (one to main for the lobby, one to the game server for the
// match) with different ids — so the identity that crosses the main↔game boundary (the MatchConfig
// roster and the future join token) must NOT be a socket id. playerKeyFor resolves a transport-
// independent key: signed-in users and guests key off their account (stable across reconnects/both
// sockets), bots off their bot id. The full runtime rekey (collections addressed by playerKey instead
// of socket.id) lands with the game-server extraction in P1-5, where state is built fresh from the
// config keyed by these keys; P1-2 just establishes the identity in the contract.

var appState = require("./appState");
var gameUtil = require("./gameUtil");

function playerKeyFor(pid) {
	var acc = appState.accounts[pid];
	if (acc && acc.userId != null) return "u:" + acc.userId;   // real user OR guest (both have a userId)
	if (gameUtil.isBot(pid)) return "bot:" + pid;
	return "s:" + pid; // fallback: a socket with no account yet (not expected for a seated match player)
}

module.exports = { playerKeyFor: playerKeyFor };
