// Match-result persistence seam (PHASE0_TICKETS.md P0-3).
//
// The single point where a finished match becomes persisted state — ranked Elo + match history +
// the captured replay. In the target architecture (ARCHITECTURE_PLAN.md §3/§8) this is the
// game-server→main "reportResult" boundary: the game tier builds a ResultReport and main's
// persistResult applies it. For now both sides are in-process, but routing every finished match
// through here makes that boundary a single call over a single object — and gives idempotency
// (P0-5) one place to live.
//
// Scope: the racing/tournament series-end path (called from endSeries). Tournament rates players
// incrementally as they're cut (elo.applyEloForPlayer), so persistResult deliberately does NOT
// re-apply ranked Elo for tournaments — it only finalises their replay. Territory ends on its own
// path (runtime/territory.js) and will be routed through here in a later phase.

var db = require("../db");
var elo = require("./elo");
var replay = require("./replay");

// Per-process boot stamp. room.id is an in-memory counter that resets when the server restarts, so a
// bare "room:N" would collide across runs and falsely dedupe a fresh match. Prefixing with the boot
// time makes the matchId unique across restarts (and stable within a run, so a retried report still
// dedupes). In the real split this is replaced by the allocation-time matchId carried in the MatchConfig (P0-2).
var BOOT = Date.now();

// Build the report a finished match hands to persistence. `standings` is the series standings, already
// mutated with placement + cumulative score + per-series progress. `room` is carried by reference for the
// in-process replay capture (room.replay holds the input log); in the split this becomes a serialized
// roster + a prebuilt replay blob shipped in the report.
function buildResultReport(room, seriesStandings) {
	return {
		// Stable per ranked match (ranked rooms are single-match, so room.id identifies the match), and
		// unique across restarts via the boot stamp. The idempotency key for P0-5. Casual rematches reuse
		// a room id but don't persist, so collisions there are moot.
		matchId: BOOT + ":room:" + room.id,
		ranked: !!room.ranked,
		mode: room.rankedMode || null,
		style: room.rankedStyle || null,
		standings: seriesStandings,
		room: room
	};
}

// Apply a finished match's results: ranked Elo (racing only — tournament rates incrementally) + the
// captured replay (a no-op when nothing was recorded). The one call the match-end path makes into
// persistence.
function persistResult(report) {
	if (!report) return;
	if (report.ranked) {
		// Apply this match's results at most once (P0-5). A retried/duplicate report short-circuits here
		// so Elo + replay are never double-applied. Non-ranked matches persist nothing, so they skip the guard.
		if (!db.markMatchPersisted(report.matchId)) return;
		if (report.mode !== "tournament") elo.applyRankedElo(report.standings, report.style);
	}
	replay.finishMatch(report.room, report.standings);
}

module.exports = {
	buildResultReport: buildResultReport,
	persistResult: persistResult
};
