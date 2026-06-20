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

var elo = require("./elo");
var replay = require("./replay");

// Build the report a finished match hands to persistence. `standings` is the series standings, already
// mutated with placement + cumulative score + per-series progress. `room` is carried by reference for the
// in-process replay capture (room.replay holds the input log); in the split this becomes a serialized
// roster + a prebuilt replay blob shipped in the report.
function buildResultReport(room, seriesStandings) {
	return {
		// Stable per ranked match (ranked rooms are single-match, so room.id identifies the match). Used
		// as the idempotency key in P0-5. Casual rematches reuse a room id but don't persist, so it's moot.
		matchId: "room:" + room.id,
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
	if (report.ranked && report.mode !== "tournament") {
		elo.applyRankedElo(report.standings, report.style);
	}
	replay.finishMatch(report.room, report.standings);
}

module.exports = {
	buildResultReport: buildResultReport,
	persistResult: persistResult
};
