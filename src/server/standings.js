// Standings computation, extracted from minesweeperServer. Turns a room's game results
// into ranked arrays: the per-round standings (rankCompare — finishers first, then by
// finish time / safe count), the series winner, the cumulative-score series standings,
// and the tournament final standings (by elimination place, pulling through stored Elo
// deltas). Reads game/room state + the accounts cache; isBot + the rating constants are
// injected via init to avoid a circular require.

var appState = require("./appState");
var db = require("./db");
var gameUtil = require("./gameUtil");

var roundStarts = appState.roundStarts, games = appState.games, accounts = appState.accounts;
var names = appState.names, botRating = appState.botRating;
var isBot = gameUtil.isBot;

var RANKED_BOT_RATING, PROVISIONAL_GAMES;
function init(deps) { RANKED_BOT_RATING = deps.RANKED_BOT_RATING; PROVISIONAL_GAMES = deps.PROVISIONAL_GAMES; }

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
	var roundStart = roundStarts[room.id] || 0;
	var entries = room.players.map(function(pid) {
		var g = games[pid];
		var finished = g ? !!g.finished : false;
		var finishedAt = g ? (g.finishedAt || 0) : 0;
		var bot = isBot(pid);
		var rating = bot ? (botRating[pid] || RANKED_BOT_RATING) : (accounts[pid] ? accounts[pid].rating : null);
		var provisional = bot ? false : (accounts[pid] ? accounts[pid].played < PROVISIONAL_GAMES : false);
		return {
			id: pid,
			name: names[pid] || "Anonymous",
			safeCount: g ? g.revealedSafeCount() : 0,
			finished: finished,
			finishedAt: finishedAt,
			finishMs: (finished && roundStart && finishedAt) ? (finishedAt - roundStart) : null,
			rating: rating,
			provisional: provisional
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

// Rank players for series-end purposes: highest cumulative score wins, ties share
// a rank. Mirrors the per-round ranking logic but reads from room.scores.
function buildSeriesStandings(room) {
	var N = room.players.length;
	var entries = room.players.map(function(pid) {
		return { id: pid, name: names[pid] || "Anonymous", score: room.scores[pid] || 0 };
	});
	for (var i = 0; i < entries.length; i++) {
		var strictlyHigher = 0;
		for (var j = 0; j < entries.length; j++) {
			if (i !== j && entries[j].score > entries[i].score) strictlyHigher++;
		}
		entries[i].rank = strictlyHigher + 1;
		entries[i].points = N - strictlyHigher;
	}
	entries.sort(function(a, b) { return a.rank - b.rank; });
	return entries;
}

// Tournament final standings: each participant's rank is their tournament-
// elimination place (1 = winner, last = first eliminated). Eliminated players'
// rating deltas were applied at elimination time and stored in room.tournamentElo
// — pull them through so the final panel can show each row's delta.
function buildTournamentStandings(room) {
	var N = room.tournamentParticipants.length;
	var entries = room.tournamentParticipants.map(function(pid) {
		var elim = room.tournamentEliminated[pid];
		var rank = elim ? elim.place : 1;
		var entry = {
			id: pid,
			name: names[pid] || "Anonymous",
			score: 0,
			rank: rank,
			points: N - rank + 1,
			eliminatedRound: elim ? elim.round : null
		};
		var eloInfo = (room.tournamentElo || {})[pid];
		if (eloInfo) {
			entry.ratingDelta = eloInfo.delta;
			entry.rating = eloInfo.newRating;
			entry.provisional = eloInfo.provisional;
		} else if (!isBot(pid)) {
			// No stored Elo yet (likely the winner) — fall back to the persisted rating.
			var acc = accounts[pid];
			var u = acc ? db.getUserById(acc.userId) : null;
			if (u) { entry.rating = u.rating; entry.provisional = u.played < PROVISIONAL_GAMES; }
		}
		return entry;
	});
	entries.sort(function(a, b) { return a.rank - b.rank; });
	return entries;
}

module.exports = {
	init: init,
	computeSeriesWinner: computeSeriesWinner,
	buildStandings: buildStandings,
	buildSeriesStandings: buildSeriesStandings,
	buildTournamentStandings: buildTournamentStandings
};
