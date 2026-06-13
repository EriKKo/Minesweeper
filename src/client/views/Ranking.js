// Tier + rank display helpers, shared across the home page chips, the Profile
// view, the Leaderboard, and the match result panels.
//
// MSBattle's ladder is Bronze/Silver/Gold/Platinum/Diamond with three sub-tiers
// each (I/II/III, 50 rating per step), then an open-ended Master tier above.

var TIER_BANDS = [
	{ name: "Bronze",   color: "#d08b5b" },
	{ name: "Silver",   color: "#cbd5e1" },
	{ name: "Gold",     color: "#fbbf24" },
	{ name: "Platinum", color: "#5eead4" },
	{ name: "Diamond",  color: "#60a5fa" }
];
var TIER_BASE_RATING = 1000;
var SUB_TIER_WIDTH = 50;
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

function buildRankBadge(rating) {
	var info = rankIconFor(rating);
	var badge = document.createElement("div");
	badge.className = "rank-badge tier-" + info.tierClass;
	if (info.subNum) {
		var num = document.createElement("div");
		num.className = "rank-badge-numeral";
		num.textContent = info.subNum;
		badge.appendChild(num);
		var label = document.createElement("div");
		label.className = "rank-badge-tier";
		label.textContent = info.label.toUpperCase();
		badge.appendChild(label);
	} else {
		var icon = document.createElement("div");
		icon.className = "rank-badge-icon";
		icon.textContent = "★";
		badge.appendChild(icon);
		var label2 = document.createElement("div");
		label2.className = "rank-badge-tier";
		label2.textContent = "MASTER";
		badge.appendChild(label2);
	}
	return badge;
}

// Builds the left column for showSeriesResultPanel: old → new rank badge with
// a swap animation if the tier changed, then the new rating + delta below.
function buildRankSwapColumn(oldRating, newRating, ratingDelta) {
	var col = document.createElement("div");
	col.className = "result-rank-column";

	var swap = document.createElement("div");
	swap.className = "rank-swap";
	var oldInfo = rankIconFor(oldRating);
	var newInfo = rankIconFor(newRating);
	var tierChanged = oldInfo.tierClass !== newInfo.tierClass || oldInfo.subNum !== newInfo.subNum;

	if (tierChanged) {
		var oldBadge = buildRankBadge(oldRating);
		oldBadge.classList.add("rank-badge-old");
		swap.appendChild(oldBadge);
		var newBadge = buildRankBadge(newRating);
		newBadge.classList.add("rank-badge-new");
		swap.appendChild(newBadge);
		swap.classList.add("changed");
	} else {
		swap.appendChild(buildRankBadge(newRating));
	}
	col.appendChild(swap);

	var rating = document.createElement("div");
	rating.className = "result-rank-rating";
	rating.textContent = String(oldRating);
	col.appendChild(rating);
	// Count the rating up (or down) to its new value a beat after the panel lands — the reward tick.
	if (typeof countUpNumber === "function") setTimeout(function() { countUpNumber(rating, oldRating, newRating, 950); }, 400);
	else rating.textContent = String(newRating);

	if (typeof ratingDelta === "number") {
		var delta = document.createElement("span");
		var sign = ratingDelta > 0 ? "+" : ratingDelta < 0 ? "" : "±";
		delta.textContent = sign + ratingDelta;
		delta.className = "result-rank-delta " + (ratingDelta > 0 ? "gain" : ratingDelta < 0 ? "loss" : "flat");
		col.appendChild(delta);
	}

	if (tierChanged) {
		var changed = document.createElement("div");
		var promoted = newRating > oldRating;
		changed.className = "result-rank-changed " + (promoted ? "promoted" : "demoted");
		changed.textContent = promoted ? "RANK UP" : "RANK DOWN";
		col.appendChild(changed);
	}

	return col;
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
