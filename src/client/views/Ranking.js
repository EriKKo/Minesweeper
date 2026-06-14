// Tier + rank display helpers, shared across the home page chips, the Profile
// view, the Leaderboard, and the match result panels.
//
// MSBattle's ladder is Bronze/Silver/Gold/Platinum/Diamond with three sub-tiers
// each (I/II/III, 200 rating per step starting at 0), then an open-ended Master
// tier above (from 3000). Players reset to 0 and climb up from Bronze I.

var TIER_BANDS = [
	{ name: "Bronze",   color: "#d08b5b" },
	{ name: "Silver",   color: "#cbd5e1" },
	{ name: "Gold",     color: "#fbbf24" },
	{ name: "Platinum", color: "#5eead4" },
	{ name: "Diamond",  color: "#60a5fa" }
];
var TIER_BASE_RATING = 0;
var SUB_TIER_WIDTH = 200;
var SUB_TIERS_PER_TIER = 3;
var SUB_TIER_NUMERALS = ["I", "II", "III"];
var MASTER_THRESHOLD = TIER_BASE_RATING + TIER_BANDS.length * SUB_TIERS_PER_TIER * SUB_TIER_WIDTH;
function tierFor(rating, provisional) {
	if (rating >= MASTER_THRESHOLD) return { name: "Master", color: "#c084fc" };
	var clamped = rating < TIER_BASE_RATING ? TIER_BASE_RATING : rating;
	var subIdx = Math.floor((clamped - TIER_BASE_RATING) / SUB_TIER_WIDTH);
	var tierIdx = Math.min(TIER_BANDS.length - 1, Math.floor(subIdx / SUB_TIERS_PER_TIER));
	var t = TIER_BANDS[tierIdx];
	return { name: t.name + " " + SUB_TIER_NUMERALS[subIdx % SUB_TIERS_PER_TIER], color: t.color };
}

// Your "overall" rating: the best across all ranked styles. There is no single legacy rating —
// anything that wants one headline number (topbar chip, profile summary) uses this.
function overallRating(account) {
	if (!account) return 0;
	return Math.max(account.ratingSprint || 0, account.ratingStandard || 0,
		account.ratingTournament || 0, account.ratingTerritory || 0);
}

// Returns { tierClass: "bronze"|"silver"|.., subNum: "I"|"II"|"III"|null, label: "Bronze" }
// Used to render the round rank badges in the series-end panel.
function rankIconFor(rating) {
	if (rating >= MASTER_THRESHOLD) return { tierClass: "master", subNum: null, label: "Master" };
	var clamped = rating < TIER_BASE_RATING ? TIER_BASE_RATING : rating;
	var subIdx = Math.floor((clamped - TIER_BASE_RATING) / SUB_TIER_WIDTH);
	var tierIdx = Math.min(TIER_BANDS.length - 1, Math.floor(subIdx / SUB_TIERS_PER_TIER));
	var t = TIER_BANDS[tierIdx];
	return {
		tierClass: t.name.toLowerCase(),
		subNum: SUB_TIER_NUMERALS[subIdx % SUB_TIERS_PER_TIER],
		label: t.name
	};
}

// Military rank-insignia badge: a dark service patch with 1-3 metallic chevrons
// (the sub-tier) tinted by the tier, glowing in the tier colour. Master tops out
// with a star instead of chevrons. No tier text inside — the rank name is always
// shown beside it (modal, profile, duel HUD, mode cards). The patch is sized in
// `em` off its font-size, so callers scale the whole badge by setting font-size.
function buildRankBadge(rating) {
	var info = rankIconFor(rating);
	var badge = document.createElement("div");
	badge.className = "rank-badge tier-" + info.tierClass;
	if (info.subNum) {
		var count = SUB_TIER_NUMERALS.indexOf(info.subNum) + 1;
		if (count < 1) count = 1;
		for (var i = 0; i < count; i++) {
			var chev = document.createElement("span");
			chev.className = "rank-chev";
			badge.appendChild(chev);
		}
	} else {
		var star = document.createElement("span");
		star.className = "rank-badge-star";
		star.textContent = "★";
		badge.appendChild(star);
	}
	return badge;
}

// Progress within the current sub-tier toward the next one (the ranked result modal's bar).
// Returns { fill: 0..1, nextName, pointsToNext, atMax }.
function tierProgress(rating) {
	if (typeof rating !== "number") rating = TIER_BASE_RATING;
	if (rating >= MASTER_THRESHOLD) return { fill: 1, nextName: null, pointsToNext: 0, atMax: true };
	var clamped = rating < TIER_BASE_RATING ? TIER_BASE_RATING : rating;
	var subStart = TIER_BASE_RATING + Math.floor((clamped - TIER_BASE_RATING) / SUB_TIER_WIDTH) * SUB_TIER_WIDTH;
	var nextThreshold = subStart + SUB_TIER_WIDTH;
	return {
		fill: Math.max(0, Math.min(1, (clamped - subStart) / SUB_TIER_WIDTH)),
		nextName: tierFor(nextThreshold).name,
		pointsToNext: Math.max(0, Math.round(nextThreshold - rating)),
		atMax: false
	};
}

function ordinal(n) {
	var s = ["th", "st", "nd", "rd"];
	var v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function medal(rank) {
	return rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : ordinal(rank);
}

function formatClearTime(ms) {
	return (ms / 1000).toFixed(1) + "s";
}
