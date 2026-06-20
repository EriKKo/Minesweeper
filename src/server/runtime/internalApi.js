// The main↔game internal API (PHASE1_TICKETS.md P1-5). The HTTP surface the two tiers use to talk:
// main → game `allocate` (run this match), game → main `report` (persist this outcome), plus a health
// probe. Secret-guarded (not publicly callable) and only mounted in split roles, so the monolith's
// HTTP surface is unchanged. Allocate (which needs the match-run wiring) is registered by the server
// via setAllocateHandler; report + health live here.

var role = require("./role");
var results = require("./results");
var lifecycle = require("./lifecycle");

var allocateHandler = null; // set by the server (game role): function(spec) -> runs the match
function setAllocateHandler(fn) { allocateHandler = fn; }

function readJson(req, cb) {
	var body = "";
	req.on("data", function(c) { body += c; if (body.length > 5e7) req.destroy(); });
	req.on("end", function() { try { cb(null, body ? JSON.parse(body) : {}); } catch (e) { cb(e); } });
	req.on("error", function(e) { cb(e); });
}
function send(res, code, obj) {
	res.writeHead(code, { "content-type": "application/json" });
	res.end(JSON.stringify(obj));
}

// Returns true if it handled the request. Mounted before the static server, only when ROLE is split.
function handleInternalRoute(req, res, url) {
	if (url.pathname.indexOf("/internal/") !== 0) return false;
	if ((req.headers["x-internal-secret"] || "") !== role.INTERNAL_SECRET) { send(res, 403, { error: "forbidden" }); return true; }

	if (url.pathname === "/internal/health") {
		send(res, 200, { ok: true, role: role.ROLE, draining: lifecycle.isDraining(), activeMatches: lifecycle.activeMatchCount() });
		return true;
	}

	// game → main: persist a finished match's outcome (idempotent; see persistResult / P0-5).
	if (url.pathname === "/internal/report" && req.method === "POST") {
		readJson(req, function(err, report) {
			if (err) { send(res, 400, { error: "bad_json" }); return; }
			try { var r = results.persistResult(report); send(res, 200, { ok: true, applied: !!(r && r.applied) }); }
			catch (e) { console.error("internal report failed", e); send(res, 500, { error: "persist_failed" }); }
		});
		return true;
	}

	// main → game: build + run a match from an allocation spec.
	if (url.pathname === "/internal/allocate" && req.method === "POST") {
		if (!allocateHandler) { send(res, 503, { error: "no_allocate_handler" }); return true; }
		// Refuse new matches while draining (deploy in progress) — main routes them to another game
		// server. Active matches on this instance keep running until they finish (P0-7).
		if (lifecycle.isDraining()) { send(res, 503, { error: "draining" }); return true; }
		readJson(req, function(err, spec) {
			if (err) { send(res, 400, { error: "bad_json" }); return; }
			try { var info = allocateHandler(spec) || {}; send(res, 200, { ok: true, matchId: info.matchId || (spec && spec.matchId) || null }); }
			catch (e) { console.error("internal allocate failed", e); send(res, 500, { error: "allocate_failed" }); }
		});
		return true;
	}

	send(res, 404, { error: "not_found" });
	return true;
}

module.exports = { handleInternalRoute: handleInternalRoute, setAllocateHandler: setAllocateHandler };
