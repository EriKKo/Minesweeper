// Leaderboard list rendering. Hits two targets — the home-page top-5 strip
// (#leaderboard_list) and the full /leaderboard view (#leaderboard_full_list)
// — from the same dataset, painting tier + rating + "you" highlight per row.

function renderLeaderboard(players) {
	var targets = [leaderboardList, leaderboardFullList].filter(Boolean);
	targets.forEach(function(target) { target.innerHTML = ""; });
	if (!players.length) {
		targets.forEach(function(target) { target.appendChild(emptyRow("No ranked players yet.")); });
		return;
	}
	players.forEach(function(p, i) {
		var prov = p.played < leaderboardProvisional;
		var t = tierFor(p.rating, prov);
		targets.forEach(function(target) {
			var li = document.createElement("li");
			li.className = "lb-row";
			if (account && p.name === account.name) li.classList.add("lb-row-me");

			var rank = document.createElement("span");
			rank.className = "lb-rank";
			rank.textContent = (i + 1);
			li.appendChild(rank);

			var name = document.createElement("span");
			name.className = "lb-name";
			name.textContent = p.name;
			li.appendChild(name);

			var tier = document.createElement("span");
			tier.className = "lb-tier";
			tier.textContent = t.name;
			tier.style.color = t.color;
			li.appendChild(tier);

			var rating = document.createElement("span");
			rating.className = "lb-rating";
			rating.textContent = (prov ? "~" : "") + p.rating;
			li.appendChild(rating);

			target.appendChild(li);
		});
	});
}
