// Elo / rating math, extracted from minesweeperServer. The pairwise-Elo formula that
// turns a round's standings into rating changes, the per-style rating reader, and the
// tournament per-player variants (so a cut player is rated the moment they're eliminated).
// Pure math over db + the in-memory accounts cache; the standings it consumes are built in
// the core (which reads game state). isBot + the rating constants are injected via init(deps)
// to avoid a circular require; accounts/botRating come from appState.

var db = require("../db");
var appState = require("./appState");
var gameUtil = require("./gameUtil");

var accounts = appState.accounts, botRating = appState.botRating;
var isBot = gameUtil.isBot;

var RANKED_BOT_RATING, PROVISIONAL_GAMES;
function init(deps) {
	RANKED_BOT_RATING = deps.RANKED_BOT_RATING;
	PROVISIONAL_GAMES = deps.PROVISIONAL_GAMES;
}

// Standard matches take far longer to play than Sprint, so a session yields far fewer of them and the
// ladder climbs slowly. Boost Standard's rating swings — extra during placement — so it moves at a pace
// closer to Sprint despite the lower game volume. 1.5× for the first game, easing to a steady 1.3×.
function styleKMultiplier(style, played) {
	if (style !== "standard") return 1;
	return 1.3 + 0.2 * Math.max(0, 1 - played / 8);
}

// K-factor: big swings for a player's first matches (placement), settling to a stable floor so an
// established rating stops bouncing. K=150 game 1 → 40 from ~game 8 on (× the per-style multiplier).
function kFactor(played, style) { return Math.max(40, 150 - played * 14) * styleKMultiplier(style, played); }

// Margin-of-victory: a dominant finish boosts the rating GAIN by up to the style's margin bonus. The
// margin is the gap between this player's progress (avg fraction of board cleared across the series) and
// the best progress among the players they outranked — so clearing far ahead of the next player pays more
// than a photo-finish. Standard rewards blowouts harder (longer games, fewer of them). Progress absent
// (e.g. territory) → factor 1 (no bonus).
var MARGIN_BONUS = 0.6;
var STANDARD_MARGIN_BONUS = 1.1;
function marginFactor(part, parts, style) {
	if (typeof part.progress !== "number") return 1;
	var below = 0;
	for (var j = 0; j < parts.length; j++) {
		var q = parts[j];
		if (q.rank > part.rank && typeof q.progress === "number" && q.progress > below) below = q.progress;
	}
	var gap = Math.max(0, Math.min(1, part.progress - below));
	var bonus = style === "standard" ? STANDARD_MARGIN_BONUS : MARGIN_BONUS;
	return 1 + bonus * gap;
}

// Read the rating column matching this match's playstyle so Sprint /
// Standard / Tournament each evolve independently.
function readUserRating(u, style) {
	if (!u) return RANKED_BOT_RATING;
	if (style === "sprint") return u.rating_sprint;
	if (style === "standard") return u.rating_standard;
	if (style === "tournament") return u.rating_tournament;
	if (style === "territory") return u.rating_territory;
	// No style → overall is the best rating across modes (there is no legacy `rating` column).
	return Math.max(u.rating_sprint || 0, u.rating_standard || 0, u.rating_tournament || 0, u.rating_territory || 0);
}

// Compute and apply Elo for a single player against a known set of standings.
// Used by tournament mode so eliminated players get their rating change the
// moment they're cut, instead of waiting for the survivor to be crowned. The
// math is the same pairwise formula as applyRankedElo. Returns the delta info
// (or null if the player isn't a persisted human).
function applyEloForPlayer(targetPid, allParts, style) {
	var target = null;
	for (var i = 0; i < allParts.length; i++) if (allParts[i].id === targetPid) { target = allParts[i]; break; }
	if (!target || target.bot || !target.userId) return null;
	var n = allParts.length;
	if (n < 2) return null;
	var sum = 0;
	for (var j = 0; j < n; j++) {
		var q = allParts[j];
		if (q.id === targetPid) continue;
		var score = target.rank < q.rank ? 1 : target.rank > q.rank ? 0 : 0.5;
		var expected = 1 / (1 + Math.pow(10, (q.rating - target.rating) / 400));
		sum += score - expected;
	}
	var delta = Math.round(kFactor(target.played, style) * sum / Math.sqrt(n - 1));
	var newRating = Math.max(0, target.rating + delta); // Bronze I floors at 0
	var provisional = (target.played + 1) < PROVISIONAL_GAMES;
	db.updateRating(target.userId, newRating, target.rank === 1, style);
	if (accounts[targetPid]) {
		// Cache the style-specific rating on the in-memory account so the
		// lobby tile updates the right tier badge.
		if (style === "sprint") accounts[targetPid].ratingSprint = newRating;
		else if (style === "standard") accounts[targetPid].ratingStandard = newRating;
		else if (style === "tournament") accounts[targetPid].ratingTournament = newRating;
			else if (style === "territory") accounts[targetPid].ratingTerritory = newRating;
		accounts[targetPid].played = target.played + 1;
	}
	return { delta: delta, newRating: newRating, provisional: provisional };
}

// Build the pairwise-Elo parts snapshot for a tournament room from the
// perspective of a single eliminated/finishing player. Survivors are slotted
// at rank 1 (they outranked anyone already eliminated); the focused player
// keeps their just-determined rank; previously-eliminated players retain
// their stored places.
function tournamentEloParts(room, focusedPid, focusedRank) {
	var participants = room.tournamentParticipants || [];
	var style = room.rankedStyle || "tournament";
	return participants.map(function(pid) {
		var rank;
		if (pid === focusedPid) {
			rank = focusedRank;
		} else if (room.tournamentEliminated[pid]) {
			rank = room.tournamentEliminated[pid].place;
		} else {
			rank = 1; // survivor — will outrank the focused player
		}
		var bot = isBot(pid);
		var acc = accounts[pid];
		var rating = bot ? (botRating[pid] || RANKED_BOT_RATING) : RANKED_BOT_RATING;
		var userId = null, played = 0;
		if (!bot && acc) {
			var u = db.getUserById(acc.userId);
			if (u) { rating = readUserRating(u, style); userId = acc.userId; played = u.played; }
		}
		return { id: pid, rank: rank, rating: rating, bot: bot, userId: userId, played: played };
	});
}

// Pairwise Elo over the round's standings. Each pair of players is a mini-match;
// a player's delta is K * mean(score - expected) across opponents (so a round's
// swing stays ~K regardless of lobby size). Bots use a fixed rating and aren't
// persisted. Mutates human standings entries with ratingDelta/rating/provisional.
function applyRankedElo(standings, style) {
	var parts = standings.map(function(s) {
		var bot = isBot(s.id);
		var acc = accounts[s.id];
		var rating = bot ? (botRating[s.id] || RANKED_BOT_RATING) : RANKED_BOT_RATING, userId = null, played = 0;
		if (!bot && acc) {
			var u = db.getUserById(acc.userId);
			if (u) { rating = readUserRating(u, style); userId = acc.userId; played = u.played; }
		}
		return { rank: s.rank, rating: rating, progress: s.progress, bot: bot, userId: userId, played: played, delta: null, newRating: null, provisional: false };
	});
	var n = parts.length;
	if (n < 2) return;
	for (var i = 0; i < n; i++) {
		var p = parts[i];
		if (p.bot || !p.userId) continue;
		var sum = 0;
		for (var j = 0; j < n; j++) {
			if (i === j) continue;
			var q = parts[j];
			var score = p.rank < q.rank ? 1 : p.rank > q.rank ? 0 : 0.5;
			var expected = 1 / (1 + Math.pow(10, (q.rating - p.rating) / 400));
			sum += score - expected;
		}
		// Normalize by sqrt(n-1) instead of (n-1) so beating more opponents pays
		// more: 1v1 top spot ~K/2; 6-player top spot ~K*sqrt(5)/2 ≈ 2.2× as much.
		var delta = kFactor(p.played, style) * sum / Math.sqrt(n - 1);
		// Reward dominant wins: scale a positive swing by how far ahead of the field you finished.
		if (delta > 0) delta *= marginFactor(p, parts, style);
		p.delta = Math.round(delta);
		p.newRating = Math.max(0, p.rating + p.delta); // Bronze I floors at 0
		p.provisional = (p.played + 1) < PROVISIONAL_GAMES;
		db.updateRating(p.userId, p.newRating, p.rank === 1, style);
	}
	for (var k = 0; k < standings.length; k++) {
		if (!parts[k].bot && parts[k].userId) {
			standings[k].ratingDelta = parts[k].delta;
			standings[k].rating = parts[k].newRating;
			standings[k].provisional = parts[k].provisional;
			// Keep the in-memory cache in sync with what we just persisted.
			if (accounts[standings[k].id]) {
				var acc = accounts[standings[k].id];
				if (style === "sprint") acc.ratingSprint = parts[k].newRating;
				else if (style === "standard") acc.ratingStandard = parts[k].newRating;
				else if (style === "tournament") acc.ratingTournament = parts[k].newRating;
					else if (style === "territory") acc.ratingTerritory = parts[k].newRating;
				acc.played = parts[k].played + 1;
			}
		}
	}
}

module.exports = {
	init: init,
	readUserRating: readUserRating,
	applyEloForPlayer: applyEloForPlayer,
	tournamentEloParts: tournamentEloParts,
	applyRankedElo: applyRankedElo
};
