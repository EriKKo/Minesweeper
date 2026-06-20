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
var appState = require("./appState");
var gameUtil = require("./gameUtil");
var identity = require("./identity");
var elo = require("./elo");
var replay = require("./replay");

// Per-process boot stamp. room.id is an in-memory counter that resets when the server restarts, so a
// bare "room:N" would collide across runs and falsely dedupe a fresh match. Prefixing with the boot
// time makes the matchId unique across restarts (and stable within a run, so a retried report still
// dedupes). In the real split this is replaced by the allocation-time matchId carried in the MatchConfig (P0-2).
var BOOT = Date.now();

// A stable matchId for a room (boot-stamped; see BOOT above).
function matchIdFor(room) { return BOOT + ":room:" + room.id; }

// Build the self-contained MatchConfig at match start (PHASE0_TICKETS.md P0-2). It captures everything
// the match needs so a game server would need no DB read: the rules, and a roster with each player's
// identity (name/avatar/country/skin), bot flag, userId, and **rating-before + games-played captured
// now**. In the target architecture main builds this and hands it to the allocated game server; today
// it's stashed on the room (room.matchConfig) at startSeries. The captured `rating` is the same value
// the end-of-match Elo reads (a player can't change rating mid-match), so it's the future input to
// computeRankedElo — letting the rating math run without re-reading the DB.
// The full set of AI knobs needed to rebuild a bot on a game server (P1-3): without these the game
// server couldn't recreate the same opponent from the config.
function botConfigOf(pid) {
	return {
		speedMs: appState.botSpeedMs[pid],
		difficultyMs: appState.botDifficultyMs[pid],
		distanceMult: appState.botDistanceMult[pid],
		maxDifficulty: appState.botMaxDifficulty[pid],
		mistakeRate: appState.botMistake[pid],
		chordRate: appState.botChord[pid],
		rating: appState.botRating[pid],
		difficulty: appState.botDifficulty[pid] || null
	};
}

function buildMatchConfig(room) {
	var style = room.rankedStyle || null;
	var roster = (room.players || []).map(function(pid) {
		var bot = gameUtil.isBot(pid);
		var acc = appState.accounts[pid];
		var rating = bot ? (appState.botRating[pid] || null) : null;
		var userId = null, played = 0;
		if (!bot && acc) {
			var u = db.getUserById(acc.userId);
			if (u) { rating = elo.readUserRating(u, style); userId = acc.userId; played = u.played; }
		}
		return {
			pid: pid,                              // current transport handle (socket.id) — local to this process
			playerKey: identity.playerKeyFor(pid), // stable identity across connections (P1-2); what the token carries
			name: appState.names[pid] || "Anonymous",
			avatar: appState.avatars[pid] || null,
			country: appState.countries[pid] || null,
			skin: appState.skins[pid] || null,
			isBot: bot,
			userId: userId,
			rating: rating,                        // rating-before, per match style
			played: played,
			botConfig: bot ? botConfigOf(pid) : null // AI knobs so a game server can rebuild this bot (P1-3)
		};
	});
	return {
		// A complete reconstruction spec (P1-3): everything a game server needs to rebuild + run this
		// match without touching main's state — match identity, rules, board dims, and the full roster.
		matchId: matchIdFor(room),
		roomId: room.id,
		size: room.maxPlayers || (room.players ? room.players.length : 0),
		ranked: !!room.ranked,
		mode: room.rankedMode || null,
		gameMode: room.gameMode || "race",
		style: style,
		rules: {
			rows: room.rows, cols: room.cols, mineDensity: room.mineDensity,
			roundSeconds: room.roundSeconds, deathPenalty: room.deathPenalty,
			gameCount: room.gameCount, modifier: room.modifier || null
		},
		roster: roster
	};
}

// Build the report a finished match hands to persistence. `standings` is the series standings, already
// mutated with placement + cumulative score + per-series progress. `room` is carried by reference for the
// in-process replay capture (room.replay holds the input log); in the split this becomes a serialized
// roster + a prebuilt replay blob shipped in the report.
function buildResultReport(room, seriesStandings) {
	var config = room.matchConfig || null;
	return {
		// Stable per ranked match and unique across restarts (boot stamp). The idempotency key for P0-5.
		// Tied to the MatchConfig's id when one was captured, so start + end agree on the match identity.
		matchId: (config && config.matchId) || matchIdFor(room),
		ranked: !!room.ranked,
		mode: room.rankedMode || null,
		style: room.rankedStyle || null,
		standings: seriesStandings,
		config: config, // self-contained roster + rating-before captured at start (P0-2)
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
	buildMatchConfig: buildMatchConfig,
	buildResultReport: buildResultReport,
	persistResult: persistResult
};
