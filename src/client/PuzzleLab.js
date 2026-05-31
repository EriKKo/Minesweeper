// Puzzle Lab — internal experimentation page.
//
// Hits /api/puzzles for a batch of small randomly-generated puzzles, sorts
// them by difficulty, and renders each as an interactive Learn-style canvas
// puzzle. Useful while we explore what "good" deduction puzzles look like
// before committing any to a curated database.

var puzzleLabState = { count: 20, diff: null };

function renderPuzzleLab() {
	var view = document.getElementById("puzzles_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Puzzle Lab";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Randomly generated small puzzles, sorted by continuous difficulty score. Each subset/enum step adds to it; trivial cell count is ignored so a big easy board doesn't outrank a small hard one. The badge shows score + tier (t1–t6).";
	view.appendChild(sub);

	var actions = document.createElement("div");
	actions.className = "puzzles-actions";
	[10, 20, 40].forEach(function(n) {
		var btn = document.createElement("button");
		btn.className = "btn " + (n === puzzleLabState.count ? "btn-primary" : "btn-secondary");
		btn.dataset.batch = String(n);
		btn.textContent = "Generate " + n;
		btn.addEventListener("click", function() {
			puzzleLabState.count = n;
			updateActionButtons();
			fetchAndRender();
		});
		actions.appendChild(btn);
	});
	view.appendChild(actions);

	// Filter row: All / 1 / 2 / 3 / 4 / 5 / 6
	var filter = document.createElement("div");
	filter.className = "puzzles-filter";
	var filterLabel = document.createElement("span");
	filterLabel.className = "puzzles-filter-label";
	filterLabel.textContent = "Difficulty";
	filter.appendChild(filterLabel);
	["all", 1, 2, 3, 4, 5, 6].forEach(function(d) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset.diff = String(d);
		btn.textContent = d === "all" ? "All" : String(d);
		if ((d === "all" && puzzleLabState.diff == null) || d === puzzleLabState.diff) btn.classList.add("active");
		if (d !== "all") btn.classList.add("puzzles-filter-chip-diff-" + d);
		btn.addEventListener("click", function() {
			puzzleLabState.diff = (d === "all") ? null : d;
			updateFilterChips();
			fetchAndRender();
		});
		filter.appendChild(btn);
	});
	view.appendChild(filter);

	var status = document.createElement("p");
	status.id = "puzzle_lab_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var grid = document.createElement("div");
	grid.id = "puzzles_grid";
	grid.className = "puzzles-grid";
	view.appendChild(grid);

	fetchAndRender();
}

function updateActionButtons() {
	document.querySelectorAll(".puzzles-actions button").forEach(function(b) {
		var n = parseInt(b.dataset.batch, 10);
		b.className = "btn " + (n === puzzleLabState.count ? "btn-primary" : "btn-secondary");
	});
}

function updateFilterChips() {
	document.querySelectorAll(".puzzles-filter-chip").forEach(function(b) {
		var d = b.dataset.diff;
		var match = (d === "all" && puzzleLabState.diff == null) || (parseInt(d, 10) === puzzleLabState.diff);
		b.classList.toggle("active", !!match);
	});
}

function fetchAndRender() {
	var count = puzzleLabState.count;
	var diff = puzzleLabState.diff;
	var status = document.getElementById("puzzle_lab_status");
	if (status) status.textContent = "Generating " + count + (diff ? " diff-" + diff : "") + " puzzles…";
	var url = "/api/puzzles?count=" + count + (diff ? "&diff=" + diff : "");
	fetch(url).then(function(r) { return r.json(); }).then(function(data) {
		var puzzles = (data && data.puzzles) || [];
		var grid = document.getElementById("puzzles_grid");
		grid.innerHTML = "";
		puzzles.sort(function(a, b) {
			return (a.score || 0) - (b.score || 0);
		});
		var byDiff = {};
		puzzles.forEach(function(p) { byDiff[p.difficulty] = (byDiff[p.difficulty] || 0) + 1; });
		var diffSummary = Object.keys(byDiff).sort().map(function(d) { return "diff " + d + ": " + byDiff[d]; }).join(" · ");
		var short = diff && puzzles.length < count ? " (couldn't find more in budget)" : "";
		if (status) status.textContent = puzzles.length + " puzzles · " + diffSummary + short;
		puzzles.forEach(function(p) { grid.appendChild(renderPuzzleCard(p)); });
	}).catch(function(e) {
		if (status) status.textContent = "Error: " + e.message;
	});
}

function renderPuzzleCard(p) {
	var card = document.createElement("div");
	card.className = "puzzle-card puzzle-diff-" + p.difficulty;

	var head = document.createElement("div");
	head.className = "puzzle-card-head";
	var diffBadge = document.createElement("span");
	diffBadge.className = "puzzle-diff-badge";
	diffBadge.textContent = (p.score != null ? p.score.toFixed(1) : "?") + " · t" + p.difficulty;
	head.appendChild(diffBadge);
	var meta = document.createElement("span");
	meta.className = "puzzle-card-meta";
	var passBits = [];
	if (p.passes.trivial) passBits.push("t×" + p.passes.trivial);
	if (p.passes.subset) passBits.push("s×" + p.passes.subset);
	if (p.passes.enum) passBits.push("e×" + p.passes.enum + (p.maxEnumSize ? "(" + p.maxEnumSize + ")" : ""));
	meta.textContent = p.rows + "×" + p.cols + " · " + p.coveredSafe + " covered · " + passBits.join(" ");
	head.appendChild(meta);
	card.appendChild(head);

	// Reuse the Learn puzzle renderer — passes are: mines list + revealed list.
	var pseudoPuzzle = {
		title: "",
		rows: p.rows,
		cols: p.cols,
		mines: p.mines,
		revealed: p.revealed
	};
	card.appendChild(buildLearnPuzzle(pseudoPuzzle, false, function() {}));

	return card;
}
