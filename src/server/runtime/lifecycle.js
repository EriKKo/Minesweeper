// Game-runtime lifecycle / draining (PHASE0_TICKETS.md P0-7, ARCHITECTURE_PLAN.md §7).
//
// A deploy must never cut a live match. The model: an instance is `active` or `draining`. On shutdown
// (SIGTERM) it begins draining — stops accepting NEW matches but lets in-flight ones finish — and only
// exits once no match is active. In the split, the fleet runs many game servers and main simply stops
// routing new matches to a draining one; in today's monolith the same hooks make `npm run stop` / a
// `fly deploy` graceful instead of abrupt.
//
// This module is the in-process stand-in: the lifecycle state + an `activeMatchCount` read + a SIGTERM
// handler that drains then exits. The matchmaker checks canAcceptNewMatch() before forming a match.

var appState = require("./appState");

var draining = false;

function isDraining() { return draining; }
function canAcceptNewMatch() { return !draining; }

// Live matches currently running = rooms in the "playing" phase. (A draining instance keeps serving
// these — including reconnections — until they end.)
function activeMatchCount() {
	var rooms = appState.rooms, n = 0;
	for (var id in rooms) { if (rooms[id] && rooms[id].phase === "playing") n++; }
	return n;
}

// Enter draining and invoke onEmpty() once no match is active — immediately if already idle, else polled.
// Bounded by maxWaitMs so a stuck match can't block shutdown forever. Non-blocking; the poll timer is
// unref'd so it never keeps the process alive on its own (the live matches' own timers do that).
function beginDrain(onEmpty, opts) {
	opts = opts || {};
	var pollMs = opts.pollMs || 1000;
	var maxWaitMs = (opts.maxWaitMs != null) ? opts.maxWaitMs : 4 * 60 * 1000;
	draining = true;
	var waited = 0;
	function tick() {
		if (activeMatchCount() <= 0 || waited >= maxWaitMs) { if (onEmpty) onEmpty(); return; }
		waited += pollMs;
		var t = setTimeout(tick, pollMs);
		if (t && t.unref) t.unref();
	}
	tick();
}

// Drain on SIGTERM, then exit. Idempotent. (Tests use SIGKILL, which can't be trapped, so this never
// interferes with the harness.)
var installed = false;
function installShutdownHandler(opts) {
	if (installed) return;
	installed = true;
	process.on("SIGTERM", function() {
		console.log("[lifecycle] SIGTERM — draining (" + activeMatchCount() + " active match(es))");
		beginDrain(function() {
			console.log("[lifecycle] drained — exiting");
			process.exit(0);
		}, opts);
	});
}

// Test-only: reset the module state between cases in a single test process.
function _reset() { draining = false; }

module.exports = {
	isDraining: isDraining,
	canAcceptNewMatch: canAcceptNewMatch,
	activeMatchCount: activeMatchCount,
	beginDrain: beginDrain,
	installShutdownHandler: installShutdownHandler,
	_reset: _reset
};
