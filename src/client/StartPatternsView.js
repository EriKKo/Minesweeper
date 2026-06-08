// "Start patterns" admin page: the unique first-deduction building blocks enumerated from
// starting cascades (scripts/generate-patterns.js → /api/start-patterns), each tagged with
// the block size(s) it was found in. Reuses PatternsView.js's board renderers
// (buildPatternCanvas / paintPatternCanvas / drawSafeMarker / ratingTier).

function renderStartPatterns() {
	var view = document.getElementById("start_patterns_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Start patterns";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Unique first-deduction patterns enumerated from starting cascades, deduped across block sizes. Each shows the clue cells the first move needed plus what it deduced (flag = forced mine, checkmark = forced safe). Tagged with the size(s) it was found in.";
	view.appendChild(sub);

	var statusP = document.createElement("p");
	statusP.id = "start_patterns_status";
	statusP.className = "puzzles-list-status";
	view.appendChild(statusP);

	var grid = document.createElement("div");
	grid.id = "start_patterns_grid";
	grid.className = "patterns-grid";
	view.appendChild(grid);

	fetch("/api/start-patterns").then(function(r) { return r.json(); }).then(function(data) {
		var patterns = (data && data.patterns) || [];
		var sizes = (data && data.sizes) || [];
		statusP.textContent = patterns.length
			? (patterns.length + " unique patterns across " + sizes.join(", ") + (data.generatedAt ? " · generated " + data.generatedAt.slice(0, 10) : ""))
			: "No patterns — run scripts/generate-patterns.js to build deduction-patterns.json.";
		patterns.forEach(function(p) { grid.appendChild(renderStartPatternCard(p)); });
	}).catch(function(e) {
		statusP.textContent = "Error: " + e.message;
	});
}

function renderStartPatternCard(rec) {
	var card = document.createElement("div");
	card.className = "pattern-card";

	var head = document.createElement("div");
	head.className = "pattern-card-head";
	var rating = document.createElement("span");
	rating.className = "pattern-card-rating sp-rating-tier-" + ratingTier(rec.rating);
	rating.textContent = rec.rating;
	head.appendChild(rating);
	var method = document.createElement("span");
	method.className = "pattern-card-method pattern-method-" + rec.method;
	method.textContent = rec.method;
	head.appendChild(method);
	card.appendChild(head);

	// Adapt the catalogue record to the shape paintPatternCanvas expects.
	var pat = {
		width: rec.width,
		height: rec.height,
		rating: rec.rating,
		method: rec.method,
		cells_json: JSON.stringify({ clues: rec.clueCells, deduced: rec.deducedCells, covered: rec.coveredCells })
	};
	var canvas = buildPatternCanvas(rec.width, rec.height);
	card.appendChild(canvas);
	paintPatternCanvas(canvas, pat);

	var safe = (rec.deducedCells || []).filter(function(c) { return c[2] === "S"; }).length;
	var mine = (rec.deducedCells || []).filter(function(c) { return c[2] === "M"; }).length;
	var details = document.createElement("div");
	details.className = "pattern-card-details";
	details.textContent = (rec.clueCells ? rec.clueCells.length : 0) + " clues → " + safe + " safe · " + mine + " mine · cx " + rec.complexity;
	card.appendChild(details);

	// Source-set tags (3x3 / 3x4 / …) with the per-size position counts.
	var tags = document.createElement("div");
	tags.className = "start-pattern-tags";
	(rec.foundIn || []).forEach(function(sz) {
		var tag = document.createElement("span");
		tag.className = "start-pattern-tag";
		var n = rec.counts && rec.counts[sz];
		tag.textContent = sz + (n ? " · " + n : "");
		tags.appendChild(tag);
	});
	card.appendChild(tags);

	return card;
}
