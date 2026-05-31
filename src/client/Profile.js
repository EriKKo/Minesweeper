// Profile view: rating + tier + win-rate summary card.
//
// Renders from `account` (populated by the server on sign-in) and the cached
// rating fields the server updates after each ranked match. The rank chips on
// the home page (renderHomeRankChips) read the same data.

// Profile renders from the account cache plus the most recent leaderboard snapshot.
function renderProfile() {
	var card = document.getElementById("profile_card");
	if (!card) return;
	if (!account) {
		card.innerHTML = "";
		var p = document.createElement("p");
		p.textContent = "Sign in to see your rating, win rate, and recent matches.";
		card.appendChild(p);
		return;
	}
	card.innerHTML = "";
	var summary = document.createElement("div");
	summary.className = "profile-summary";
	summary.appendChild(buildRankBadge(account.rating));
	var text = document.createElement("div");
	text.className = "profile-summary-text";
	var nameLine = document.createElement("div");
	nameLine.className = "profile-summary-name";
	nameLine.textContent = myName || (account.name || "You");
	text.appendChild(nameLine);
	var ratingLine = document.createElement("div");
	ratingLine.className = "profile-summary-rating";
	var t = tierFor(account.rating, account.provisional);
	ratingLine.textContent = t.name + " · " + (account.provisional ? "~" : "") + account.rating + (account.provisional ? " (provisional)" : "");
	ratingLine.style.color = t.color;
	text.appendChild(ratingLine);
	summary.appendChild(text);
	card.appendChild(summary);

	var stats = document.createElement("div");
	stats.className = "profile-stats";
	var played = (account.played != null) ? account.played : 0;
	var wins = (account.wins != null) ? account.wins : 0;
	var winRate = played > 0 ? Math.round((wins / played) * 100) + "%" : "—";
	stats.appendChild(profileStat("Played", String(played)));
	stats.appendChild(profileStat("Wins", String(wins)));
	stats.appendChild(profileStat("Win rate", winRate));
	card.appendChild(stats);

	var note = document.createElement("p");
	note.className = "section-stub-note";
	note.style.marginTop = "1rem";
	note.textContent = "Per-mode breakdown, match history, and rating chart are coming next.";
	card.appendChild(note);
}

function profileStat(label, value) {
	var box = document.createElement("div");
	box.className = "profile-stat";
	var l = document.createElement("div");
	l.className = "profile-stat-label";
	l.textContent = label;
	box.appendChild(l);
	var v = document.createElement("div");
	v.className = "profile-stat-value";
	v.textContent = value;
	box.appendChild(v);
	return box;
}

function renderHomeRankChips() {
	function applyTo(tierEl, ratingEl) {
		if (!tierEl || !ratingEl) return;
		if (!account) { tierEl.textContent = "—"; tierEl.style.color = ""; ratingEl.textContent = ""; return; }
		var t = tierFor(account.rating, account.provisional);
		tierEl.textContent = t.name;
		tierEl.style.color = t.color;
		ratingEl.textContent = (account.provisional ? "~" : "") + account.rating;
	}
	applyTo(rankTierDuo, rankRatingDuo);
	applyTo(rankTierSix, rankRatingSix);
	applyTo(rankTierTournament, rankRatingTournament);
}
