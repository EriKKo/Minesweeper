// Ranked matchmaking — the queue, the bot-trickle filler, and match formation, extracted
// from minesweeperServer. Players queue per mode; bots "arrive" on a random trickle to fill
// the remaining seats; once a mode's seat count is met, formRankedMatch builds the room,
// seats everyone, and hands off to the core's series start.
//
// Like territory, it's coupled to the room/game core (it creates games, adds bots, starts
// the series), so those core services are injected via init(deps) to avoid a circular
// require; queue state lives in appState. The server delegates find/cancel/disconnect to
// isValidMode + enqueue + dequeue.

var appState = require("./appState");
var db = require("../db");
var botPlayer = require("../engine/BotPlayer");
var roomCreator = require("../engine/RoomCreator");
var territory = require("./territory");
var gameUtil = require("./gameUtil");

// Shared queue state (same objects the server holds).
var rankedQueues = appState.rankedQueues, pendingBotsLists = appState.pendingBotsLists;
var rankedFillTimers = appState.rankedFillTimers, rankedQueueMode = appState.rankedQueueMode;
var accounts = appState.accounts, sockets = appState.sockets, names = appState.names;
var roomMapping = appState.roomMapping, games = appState.games, rooms = appState.rooms;

// Ranked mode catalogue + timings (moved here from the server). Each playstyle carries its
// own Elo ladder. territory_* reuse the territory module's density + the territory ladder.
var RANKED_MODES = {
	sprint_duo: { size: 2, label: "1v1 Sprint", style: "sprint", mineDensity: 0.10, boardSize: "medium" },
	sprint_six: { size: 6, label: "6P Sprint",  style: "sprint", mineDensity: 0.10, boardSize: "medium" },
	standard_duo: { size: 2, label: "1v1 Standard", style: "standard", mineDensity: 0.20, boardSize: "medium" },
	standard_six: { size: 6, label: "6P Standard", style: "standard", mineDensity: 0.20, boardSize: "medium" },
	// Cut 4 per round while many players are alive (16 → 12 → 8), then 2 per round to a 1v1 final.
	tournament: { size: 16, label: "Tournament", style: "tournament", mineDensity: 0.15, boardSize: "medium", schedule: [12, 8, 6, 4, 2, 1] },
	territory_duo: { size: 2, label: "1v1 Territory", style: "territory", mineDensity: territory.density, boardSize: "medium", gameMode: "territory", roundSeconds: 0, ratingKey: "territory" }, // no clock — ends when the board is played out; bots picked by their measured territory rating
	territory_quad: { size: 4, label: "4P Territory", style: "territory", mineDensity: territory.density, boardSize: "medium", gameMode: "territory", roundSeconds: 0, ratingKey: "territory" } // 4 players, one per corner; shares the territory Elo ladder
};
// Short pause between forming a match and starting game 1 — just long enough to land in the
// game layout (covered board) before the countdown. There's no roster modal to read anymore
// (the search waiting room already showed the field), so this is brief for every mode.
var MATCH_REVEAL_MS = 1000;
// Bots "join" the queue one at a time at random intervals so it reads like real players.
// Paced slowly enough that the waiting room is clearly visible before the field fills in.
var BOT_JOIN_MIN_MS = 1200;
var BOT_JOIN_MAX_MS = 2600;

var botCount = gameUtil.botCount;
// Core services injected at boot to avoid a circular require on the server.
var io, RANKED_RULES, MAX_BOTS_PER_ROOM, PROVISIONAL_GAMES, newRoomId,
    readUserRating, createPlayerGame, addBotToRoom, broadcastRoomState, startSeries;
function init(deps) {
	io = deps.io;
	RANKED_RULES = deps.RANKED_RULES;
	MAX_BOTS_PER_ROOM = deps.MAX_BOTS_PER_ROOM;
	PROVISIONAL_GAMES = deps.PROVISIONAL_GAMES;
	newRoomId = deps.newRoomId;
	readUserRating = deps.readUserRating;
	createPlayerGame = deps.createPlayerGame;
	addBotToRoom = deps.addBotToRoom;
	broadcastRoomState = deps.broadcastRoomState;
	startSeries = deps.startSeries;
}

function isValidMode(mode) { return !!RANKED_MODES[mode]; }
function modeSize(mode) { return RANKED_MODES[mode].size; }

function rankedCount(mode) {
	return rankedQueues[mode].length + pendingBotsLists[mode].length;
}

// Average human rating in this mode's queue — used to tune freshly-arriving
// bots so the lobby's overall skill stays consistent.
function rankedTargetElo(mode) {
	var q = rankedQueues[mode];
	var style = RANKED_MODES[mode].style;
	var sum = 0, n = 0;
	for (var i = 0; i < q.length; i++) {
		var acc = accounts[q[i]];
		var u = acc ? db.getUserById(acc.userId) : null;
		if (u) { sum += readUserRating(u, style); n++; } // match on this mode's own ladder
	}
	return n ? Math.round(sum / n) : 1000;
}

// What each player should see in the search-screen slots: humans in the queue
// plus already-arrived pending bots, ordered humans-first. `isYou` is per-viewer.
function rankedSearchMembers(viewerID, mode) {
	var members = [];
	var q = rankedQueues[mode], pending = pendingBotsLists[mode];
	// Show each player's rating on THIS mode's ladder (rating_sprint/standard/…), read fresh from
	// the db, not the legacy `rating` column — style games only update the per-style column, so the
	// legacy field is stale and would show an old rank after you've played some games.
	var style = (RANKED_MODES[mode] && RANKED_MODES[mode].style) || mode;
	for (var i = 0; i < q.length; i++) {
		var pid = q[i];
		var acc = accounts[pid];
		var u = acc ? db.getUserById(acc.userId) : null;
		members.push({
			id: pid,
			name: names[pid] || (u && u.name) || "Anonymous",
			rating: u ? readUserRating(u, style) : 0,
			provisional: u ? (u.played < PROVISIONAL_GAMES) : true,
			isYou: pid === viewerID,
			isBot: false
		});
	}
	for (var j = 0; j < pending.length; j++) {
		var b = pending[j];
		members.push({
			id: "pending_bot_" + mode + "_" + j,
			name: b.name,
			rating: b.config.rating,
			provisional: false,
			isYou: false,
			isBot: true
		});
	}
	return members;
}

function broadcastRankedQueue(mode) {
	var q = rankedQueues[mode];
	for (var i = 0; i < q.length; i++) {
		var pid = q[i];
		var s = sockets[pid];
		if (s) s.emit("ranked_searching", {
			mode: mode,
			count: rankedCount(mode),
			size: modeSize(mode),
			members: rankedSearchMembers(pid, mode)
		});
	}
}

function clearRankedFill(mode) {
	if (rankedFillTimers[mode]) { clearTimeout(rankedFillTimers[mode]); rankedFillTimers[mode] = null; }
}

// How many bots "arrive" on this trickle tick. Mostly one, but occasionally a
// pair or a small cluster — feels more like real players spawning in.
function pickBotBatchSize() {
	var r = Math.random();
	if (r < 0.10) return 3;
	if (r < 0.35) return 2;
	return 1;
}

function scheduleBotArrival(mode) {
	if (RANKED_MODES[mode].noBots) return; // human-only mode — never fill with bots
	if (rankedFillTimers[mode]) return;
	var delay = BOT_JOIN_MIN_MS + Math.floor(Math.random() * (BOT_JOIN_MAX_MS - BOT_JOIN_MIN_MS));
	rankedFillTimers[mode] = setTimeout(function() {
		rankedFillTimers[mode] = null;
		if (rankedQueues[mode].length === 0) { pendingBotsLists[mode] = []; return; }
		var slotsLeft = modeSize(mode) - rankedCount(mode);
		if (slotsLeft <= 0) return;
		var batch = Math.min(slotsLeft, pickBotBatchSize());
		for (var b = 0; b < batch; b++) {
			var taken = pendingBotsLists[mode].map(function(p) { return p.name; });
			pendingBotsLists[mode].push({
				name: botPlayer.pickBotName(taken),
				config: botPlayer.pickBotFromPool(rankedTargetElo(mode), 0, RANKED_MODES[mode].ratingKey)
			});
		}
		if (rankedCount(mode) >= modeSize(mode)) {
			formRankedMatch(mode);
		} else {
			broadcastRankedQueue(mode);
			scheduleBotArrival(mode);
		}
	}, delay);
}

function enqueueRanked(playerID, mode) {
	if (!isValidMode(mode)) return;
	if (!accounts[playerID]) return;          // ranked requires a signed-in account
	if (roomMapping[playerID]) return;         // already in a room
	// Player can only be in one ranked queue at a time.
	if (rankedQueueMode[playerID]) dequeueRanked(playerID);
	rankedQueues[mode].push(playerID);
	rankedQueueMode[playerID] = mode;
	if (rankedCount(mode) >= modeSize(mode)) {
		formRankedMatch(mode);
	} else {
		broadcastRankedQueue(mode);
		scheduleBotArrival(mode);
	}
}

function dequeueRanked(playerID) {
	var mode = rankedQueueMode[playerID];
	if (!mode) return;
	delete rankedQueueMode[playerID];
	var q = rankedQueues[mode];
	var idx = q.indexOf(playerID);
	if (idx !== -1) q.splice(idx, 1);
	if (q.length === 0) {
		clearRankedFill(mode);
		pendingBotsLists[mode] = [];
	} else {
		broadcastRankedQueue(mode);
	}
}

function formRankedMatch(mode) {
	clearRankedFill(mode);
	var matchSize = modeSize(mode);
	var queuedBots = pendingBotsLists[mode];
	pendingBotsLists[mode] = [];

	var humans = [];
	while (rankedQueues[mode].length && humans.length < matchSize) {
		var pid = rankedQueues[mode].shift();
		delete rankedQueueMode[pid];
		if (sockets[pid] && accounts[pid] && !roomMapping[pid]) humans.push(pid);
	}
	if (humans.length === 0) return;

	var id = newRoomId();
	var modeDef = RANKED_MODES[mode];
	var room = roomCreator.createRoom(id, humans[0], matchSize);
	room.ranked = true;
	room.rankedMode = mode;
	room.rankedStyle = modeDef.style; // sprint / standard / tournament
	room.roundSeconds = RANKED_RULES.roundSeconds;
	room.deathPenalty = RANKED_RULES.deathPenalty;
	room.mineDensity = modeDef.mineDensity;
	room.setBoardSize(modeDef.boardSize);
	if (typeof modeDef.roundSeconds === "number") room.roundSeconds = modeDef.roundSeconds; // honor an explicit 0 (territory has no clock)
	if (modeDef.gameMode === "territory") {
		room.gameMode = "territory";
		var td = territory.dims(modeDef.size); room.rows = td.rows; room.cols = td.cols;
	}
	if (mode === "tournament") {
		room.tournamentSchedule = modeDef.schedule.slice();
		room.tournamentParticipants = [];   // populated after players join
		room.tournamentEliminated = {};      // pid -> { round, place }
		room.gameCount = modeDef.schedule.length;
	} else {
		room.gameCount = RANKED_RULES.gameCount;
	}
	rooms[id] = room;

	for (var i = 0; i < humans.length; i++) {
		var hid = humans[i];
		var socket = sockets[hid];
		games[hid] = createPlayerGame(hid, room.rows, room.cols);
		roomMapping[hid] = room;
		room.addPlayer(hid);
		socket.leave("lobby");
		socket.join("room:" + room.id);
		socket.emit("joined_room", { roomId: room.id, ranked: true, mode: mode });
	}

	// Use the bot identities already shown to the player during the search so the
	// opponents who appear in the lobby slot list are the same who join the match.
	for (var b = 0; b < queuedBots.length && room.players.length < matchSize; b++) {
		if (botCount(room) >= MAX_BOTS_PER_ROOM) break;
		addBotToRoom(room, queuedBots[b].config, queuedBots[b].name);
	}
	// If queued bots weren't enough (e.g. a player joined late and the queue size
	// jumped without enough bot timers firing), top up with fresh bots tuned to
	// the lobby's average human rating.
	if (!modeDef.noBots && room.players.length < matchSize) {
		var sumElo = 0, eloCount = 0;
		for (var h = 0; h < humans.length; h++) {
			var acc = accounts[humans[h]];
			var u = acc ? db.getUserById(acc.userId) : null;
			if (u) { sumElo += readUserRating(u, modeDef.style); eloCount++; }
		}
		var targetElo = eloCount ? Math.round(sumElo / eloCount) : 1000;
		while (room.players.length < matchSize && botCount(room) < MAX_BOTS_PER_ROOM) {
			if (!addBotToRoom(room, botPlayer.pickBotFromPool(targetElo))) break;
		}
	}

	// Human-only mode that couldn't reach full size (rare race): re-queue the lone player
	// and tear the room down rather than start a game that can't run.
	if (modeDef.noBots && room.players.length < matchSize) {
		var leftover = room.players.slice();
		leftover.forEach(function(pid) {
			delete roomMapping[pid]; delete games[pid];
			if (sockets[pid]) sockets[pid].leave("room:" + room.id);
		});
		delete rooms[room.id];
		leftover.forEach(function(pid) { if (sockets[pid] && accounts[pid]) enqueueRanked(pid, mode); });
		return;
	}

	for (var j = 0; j < room.players.length; j++) room.playerReady(room.players[j]);
	if (mode === "tournament") room.tournamentParticipants = room.players.slice();
	broadcastRoomState(room);

	// Drop the players into the game layout (covered board) for a brief beat, then start the
	// countdown. The room is in planning phase during this window.
	io.to("room:" + room.id).emit("match_reveal", {});
	setTimeout(function() {
		if (!rooms[room.id] || room.phase !== "planning") return;
		startSeries(room);
	}, MATCH_REVEAL_MS);

	if (rankedQueues[mode].length > 0) {
		broadcastRankedQueue(mode);
		scheduleBotArrival(mode);
	}
}

module.exports = {
	init: init,
	isValidMode: isValidMode,
	enqueue: enqueueRanked,
	dequeue: dequeueRanked
};
