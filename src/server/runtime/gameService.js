// The game-service boundary (PHASE1_TICKETS.md P1-1).
//
// The explicit contract between the control plane (matchmaking + persistence — the future `main`) and
// the game runtime (the future game server): `allocate` runs a match, `reportResult` hands its outcome
// back to be persisted. Today both sides are in-process — allocate calls the core's startSeries and
// reportResult calls the registered persist handler — so this is pure indirection that names the seam.
// In P1-5 the in-process transport is swapped for a real internal API (main allocates over the wire;
// the game process reports back) WITHOUT changing any caller: they keep calling allocate / reportResult.

var appState = require("./appState");
var gameUtil = require("./gameUtil");

var startMatch = null;    // injected: the core's startSeries(room) — "run this match"
var resultHandler = null; // injected/registered: results.persistResult(report) — "persist this outcome"
// Construction deps (P1-3/P1-5) — injected so this module can rebuild a match from a spec without
// importing the server. On the future game server these are local; here they're the monolith's.
var _createRoom = null, _createPlayerGame = null, _addBotToRoom = null, _territoryDims = null;

function init(deps) {
	deps = deps || {};
	if (deps.startMatch) startMatch = deps.startMatch;
	if (deps.onResult) resultHandler = deps.onResult;
	if (deps.createRoom) _createRoom = deps.createRoom;
	if (deps.createPlayerGame) _createPlayerGame = deps.createPlayerGame;
	if (deps.addBotToRoom) _addBotToRoom = deps.addBotToRoom;
	if (deps.territoryDims) _territoryDims = deps.territoryDims;
}

// Build the live match (room + games + bots) from an allocation spec — the config-driven construction
// the game server runs when main hands it a match (P1-3/P1-5). Humans are seated by pid (their games
// created now); bots are created from their stored AI configs. Socket attachment (join/emit) is the
// caller's concern — building the match state is separate from binding a transport to it, which is what
// lets the same builder serve both the in-process monolith and a game server where humans attach later.
function buildMatchFromConfig(spec) {
	var room = _createRoom(spec.roomId, spec.ownerPid, spec.size);
	// Preserve the matchId main assigned (in the spec) so the result reported back correlates to the
	// allocation. results.matchIdFor prefers this over the locally-derived id.
	if (spec.matchId) room.allocatedMatchId = spec.matchId;
	room.ranked = !!spec.ranked;
	room.rankedMode = spec.mode || null;
	room.rankedStyle = spec.style || null;
	room.mineDensity = spec.rules.mineDensity;
	if (spec.boardSize) room.setBoardSize(spec.boardSize);
	room.deathPenalty = spec.rules.deathPenalty;
	room.gameCount = spec.rules.gameCount;
	if (typeof spec.rules.roundSeconds === "number") room.roundSeconds = spec.rules.roundSeconds;
	if (spec.rules.modifier && room.setModifier) room.setModifier(spec.rules.modifier);
	if (spec.gameMode === "territory") {
		room.gameMode = "territory";
		var td = _territoryDims(spec.size);
		room.rows = td.rows; room.cols = td.cols;
	}
	if (spec.tournament) {
		room.tournamentSchedule = spec.tournament.schedule.slice();
		room.tournamentParticipants = [];
		room.tournamentEliminated = {};
		room.gameCount = spec.tournament.schedule.length;
	}
	appState.rooms[spec.roomId] = room;
	(spec.humans || []).forEach(function(pid) {
		appState.games[pid] = _createPlayerGame(pid, room.rows, room.cols);
		appState.roomMapping[pid] = room;
		room.addPlayer(pid);
	});
	(spec.bots || []).forEach(function(b) {
		if (gameUtil.botCount(room) >= (spec.maxBots || Infinity)) return;
		_addBotToRoom(room, b.config, b.name);
	});
	return room;
}

function setResultHandler(fn) { resultHandler = fn; }

// Allocate + run a match. In-process the room is already built, so this starts its series; P1-3 moves
// room/game construction in here so allocate takes a MatchConfig and builds the match itself. Returns a
// small allocation handle (the matchId — and, in the split, the game server address + a join token).
function allocate(room) {
	if (typeof startMatch === "function") startMatch(room);
	return { matchId: room && room.matchConfig ? room.matchConfig.matchId : null };
}

// Called by the game runtime when a match ends; the control plane persists it. In the split this is the
// game→main reportResult network call (idempotent + retried); here it's a direct, in-process hand-off.
// Returns whatever the handler returns — in-process that's a plain object (persistResult), over the
// network it's a Promise (reportResultToMain) — so callers should `await` this either way; awaiting a
// non-Promise value just resolves immediately, so this is safe for both roles.
function reportResult(report) {
	if (typeof resultHandler === "function") return resultHandler(report);
}

module.exports = {
	init: init,
	setResultHandler: setResultHandler,
	allocate: allocate,
	buildMatchFromConfig: buildMatchFromConfig,
	reportResult: reportResult
};
