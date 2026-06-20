// The game-service boundary (PHASE1_TICKETS.md P1-1).
//
// The explicit contract between the control plane (matchmaking + persistence — the future `main`) and
// the game runtime (the future game server): `allocate` runs a match, `reportResult` hands its outcome
// back to be persisted. Today both sides are in-process — allocate calls the core's startSeries and
// reportResult calls the registered persist handler — so this is pure indirection that names the seam.
// In P1-5 the in-process transport is swapped for a real internal API (main allocates over the wire;
// the game process reports back) WITHOUT changing any caller: they keep calling allocate / reportResult.

var startMatch = null;    // injected: the core's startSeries(room) — "run this match"
var resultHandler = null; // injected/registered: results.persistResult(report) — "persist this outcome"

function init(deps) {
	deps = deps || {};
	if (deps.startMatch) startMatch = deps.startMatch;
	if (deps.onResult) resultHandler = deps.onResult;
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
function reportResult(report) {
	if (typeof resultHandler === "function") resultHandler(report);
}

module.exports = {
	init: init,
	setResultHandler: setResultHandler,
	allocate: allocate,
	reportResult: reportResult
};
