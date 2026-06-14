// Admin "Design" page — a living reference for the visual design system, rendered with the real
// components. Right now it shows the full rank ladder (every tier + sub-tier through Master) using
// the live buildRankBadge(), so the insignia can be reviewed in one place without grinding the ladder.
function renderDesign() {
	var view = document.getElementById("design_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Design";
	view.appendChild(title);
	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "A living reference for the visual design system, rendered with the live components.";
	view.appendChild(sub);

	var section = document.createElement("h2");
	section.className = "design-section-title";
	section.textContent = "Rank ladder";
	view.appendChild(section);
	var note = document.createElement("p");
	note.className = "section-page-sub";
	note.textContent = "Chevrons through Gold, faceted gems whose wings unfurl per sub-tier for Platinum/Diamond, a crowned winged star at Master.";
	view.appendChild(note);

	// Build one rating per sub-tier (Bronze I … Diamond III) plus Master, from the ladder constants.
	var subs = (typeof SUB_TIERS_PER_TIER === "number") ? SUB_TIERS_PER_TIER : 3;
	var width = (typeof SUB_TIER_WIDTH === "number") ? SUB_TIER_WIDTH : 200;
	var base = (typeof TIER_BASE_RATING === "number") ? TIER_BASE_RATING : 0;
	var master = (typeof MASTER_THRESHOLD === "number") ? MASTER_THRESHOLD : 3000;
	var bands = (typeof TIER_BANDS !== "undefined" && TIER_BANDS.length) ? TIER_BANDS.length : 5;

	var ratings = [];
	for (var i = 0; i < bands * subs; i++) ratings.push(base + i * width);
	ratings.push(master);

	var grid = document.createElement("div");
	grid.className = "design-ranks";
	ratings.forEach(function(rating) {
		var info = rankIconFor(rating);
		var cell = document.createElement("div");
		cell.className = "design-rank";
		var badge = buildRankBadge(rating);
		badge.style.fontSize = "26px";
		cell.appendChild(badge);
		var name = document.createElement("div");
		name.className = "design-rank-name";
		name.textContent = info.label + (info.subNum ? " " + info.subNum : "");
		var tier = (typeof tierFor === "function") ? tierFor(rating) : null;
		if (tier && tier.color) name.style.color = tier.color;
		cell.appendChild(name);
		var rt = document.createElement("div");
		rt.className = "design-rank-rating";
		rt.textContent = rating + (rating >= master ? "+" : "");
		cell.appendChild(rt);
		grid.appendChild(cell);
	});
	view.appendChild(grid);
}
