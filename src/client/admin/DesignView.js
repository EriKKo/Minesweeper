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
	note.textContent = "Chevrons throughout — bare for Bronze/Silver/Gold, framed in a hexagon plate for Platinum/Diamond, and a star in the plate for Master.";
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

	// --- Admin: set your own rank (testing) -------------------------------------------------------
	function rankLabel(r) { var info = rankIconFor(r); return info.label + (info.subNum ? " " + info.subNum : ""); }
	var setSection = document.createElement("h2");
	setSection.className = "design-section-title";
	setSection.textContent = "Set your rank (admin)";
	view.appendChild(setSection);
	var setNote = document.createElement("p");
	setNote.className = "section-page-sub";
	setNote.textContent = "Set your own rating to preview ranks and test the ranked UI at any tier. Admins only.";
	view.appendChild(setNote);

	var panel = document.createElement("div");
	panel.className = "design-rankset";

	var preview = document.createElement("div");
	preview.className = "design-rankset-current";
	if (typeof account !== "undefined" && account) {
		var ov = overallRating(account);
		var pv = buildRankBadge(ov); pv.style.fontSize = "22px";
		preview.appendChild(pv);
		var pl = document.createElement("span");
		pl.className = "design-rankset-label";
		pl.textContent = "Current: " + rankLabel(ov) + " · " + ov;
		preview.appendChild(pl);
	} else {
		preview.textContent = "Sign in to set your rank.";
	}
	panel.appendChild(preview);

	var controls = document.createElement("div");
	controls.className = "design-rankset-controls";
	var rankSel = document.createElement("select");
	rankSel.className = "design-select";
	ratings.forEach(function(r) {
		var o = document.createElement("option");
		o.value = r; o.textContent = rankLabel(r) + " (" + r + ")";
		rankSel.appendChild(o);
	});
	if (typeof account !== "undefined" && account) {
		var cur = overallRating(account), best = ratings[0];
		ratings.forEach(function(r) { if (r <= cur) best = r; });
		rankSel.value = String(best);
	}
	var styleSel = document.createElement("select");
	styleSel.className = "design-select";
	[["all", "All modes"], ["sprint", "Sprint"], ["standard", "Standard"], ["tournament", "Tournament"], ["territory", "Territory"]].forEach(function(s) {
		var o = document.createElement("option");
		o.value = s[0]; o.textContent = s[1];
		styleSel.appendChild(o);
	});
	var apply = document.createElement("button");
	apply.className = "btn btn-primary";
	apply.textContent = "Apply";
	apply.addEventListener("click", function() {
		if (typeof socket === "undefined") return;
		socket.emit("admin_set_rating", { rating: parseInt(rankSel.value, 10), style: styleSel.value });
	});
	controls.appendChild(rankSel);
	controls.appendChild(styleSel);
	controls.appendChild(apply);
	panel.appendChild(controls);
	view.appendChild(panel);
}
