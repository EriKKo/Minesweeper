// Leaderboard list rendering. Hits two targets — the home-page top-5 strip
// (#leaderboard_list) and the full /leaderboard view (#leaderboard_full_list)
// — from the same dataset, painting tier + rating + "you" highlight per row.

// Which mode's ladder the /leaderboard page is showing. The server returns the
// chosen mode's rating as `rating`, so renderLeaderboard stays mode-agnostic.
var currentLeaderboardMode = "overall";

// Open/refresh the leaderboard for a mode: highlight the tab, show a loading row,
// and request that ladder. The `leaderboard` socket handler renders the reply.
function selectLeaderboardMode(mode) {
	currentLeaderboardMode = mode || "overall";
	var tabs = document.querySelectorAll("#leaderboard_tabs .lb-tab");
	for (var i = 0; i < tabs.length; i++) {
		tabs[i].classList.toggle("active", tabs[i].getAttribute("data-mode") === currentLeaderboardMode);
	}
	if (typeof leaderboardFullList !== "undefined" && leaderboardFullList) {
		leaderboardFullList.innerHTML = "";
		leaderboardFullList.appendChild(emptyRow("Loading…"));
	}
	if (typeof socket !== "undefined") socket.emit("get_leaderboard", { mode: currentLeaderboardMode });
}

// Wire the mode tabs once (delegated; the buttons live in static markup).
(function wireLeaderboardTabs() {
	var tabsEl = document.getElementById("leaderboard_tabs");
	if (!tabsEl) return;
	tabsEl.addEventListener("click", function(e) {
		var btn = e.target.closest(".lb-tab");
		if (btn && tabsEl.contains(btn)) selectLeaderboardMode(btn.getAttribute("data-mode"));
	});
})();

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

			if (typeof buildAvatarChip === "function") {
				var chip = buildAvatarChip(p.avatar_color || DEFAULT_AVATAR_COLOR, p.country || null, 24);
				chip.classList.add("lb-avatar");
				li.appendChild(chip);
			}

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
			rating.textContent = p.rating;
			li.appendChild(rating);

			target.appendChild(li);
		});
	});
}
