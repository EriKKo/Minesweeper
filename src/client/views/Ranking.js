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

// Rank-insignia badge — a dark service patch glowing in the tier colour, with an emblem that grows
// in prestige as you climb. The rank NAME is always shown beside it, so the emblem is pure flair.
//  • Bronze / Silver / Gold: metallic chevrons (1-3 = the sub-tier) — the foot-soldier insignia.
//  • Platinum / Diamond: a faceted gem crest whose WINGS unfurl with the sub-tier (I=2 feathers per
//    side, II=3, III=4) — it visibly levels up rather than stacking copies.
//  • Master: a crowned, fully-winged star — the pinnacle.
// The patch is sized in `em` off its font-size, so callers scale the whole badge with one rule.
function buildRankBadge(rating) {
	var info = rankIconFor(rating);
	var badge = document.createElement("div");
	badge.className = "rank-badge tier-" + info.tierClass;
	badge.innerHTML = rankEmblemSVG(info);
	return badge;
}

// Point-top hexagon plate every tier wears: a dark interior behind a tier-coloured rim, framing the
// sub-tier chevrons (a star for Master). Clean — no wings.
var RANK_HEX_PTS = "50,15 85,34 85,72 50,91 15,72 15,34";
function rankHexSVG() {
	return '<polygon class="rank-hex-fill" points="' + RANK_HEX_PTS + '"/>'
		+ '<polygon class="rank-hex-rim" points="' + RANK_HEX_PTS + '"/>';
}
// The sub-tier chevrons (1-3), stacked and centred, filled with the tier's metallic gradient.
function rankHexChevrons(n, grad) {
	var p = "", w = 28, h = 8.4, gap = 3, total = n * h + (n - 1) * gap, y0 = 53 - total / 2, x0 = 50 - w / 2;
	for (var i = 0; i < n; i++) {
		var y = y0 + i * (h + gap);
		var pts = [
			50 + "," + y.toFixed(1),
			(x0 + w) + "," + (y + 0.55 * h).toFixed(1),
			(x0 + w) + "," + (y + h).toFixed(1),
			50 + "," + (y + 0.45 * h).toFixed(1),
			x0 + "," + (y + h).toFixed(1),
			x0 + "," + (y + 0.55 * h).toFixed(1)
		];
		p += '<polygon points="' + pts.join(" ") + '" fill="url(#' + grad + ')"/>';
	}
	return p;
}
// A star centred in the hexagon for Master (tops the chevron ladder), same metallic gradient fill.
function rankHexStarSVG(grad) {
	var pts = [], cx = 50, cy = 53, ro = 19, ri = 8;
	for (var k = 0; k < 10; k++) {
		var a = (-90 + k * 36) * Math.PI / 180, r = (k % 2) ? ri : ro;
		pts.push((cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1));
	}
	return '<polygon points="' + pts.join(" ") + '" fill="url(#' + grad + ')"/>';
}
// Compose the emblem: the hexagon plate holding the sub-tier chevrons (a star for Master). Each badge
// gets its own gradient id so the tier vars resolve per-instance (a shared id would take the first
// badge's colours). The chevron/star gradient (objectBoundingBox) runs c1→c2→c3 across each shape, so
// they keep the metallic chevron look at every tier.
var _rankGradSeq = 0;
function rankEmblemSVG(info) {
	var isMaster = info.tierClass === "master";
	var subN = info.subNum ? Math.max(1, SUB_TIER_NUMERALS.indexOf(info.subNum) + 1) : 3;
	var grad = "rg" + (++_rankGradSeq);
	var svg = '<svg class="rank-emblem" viewBox="0 0 100 100" aria-hidden="true">';
	svg += '<defs><linearGradient id="' + grad + '" x1="0" y1="0" x2="0.3" y2="1">'
		+ '<stop offset="0" style="stop-color:var(--rb-c1)"/>'
		+ '<stop offset="0.55" style="stop-color:var(--rb-c2)"/>'
		+ '<stop offset="1" style="stop-color:var(--rb-c3)"/></linearGradient></defs>';
	svg += rankHexSVG();
	svg += isMaster ? rankHexStarSVG(grad) : rankHexChevrons(subN, grad);
	svg += '</svg>';
	return svg;
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
