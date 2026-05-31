// Puzzle Lab — internal experimentation page.
//
// Hits /api/puzzles for a batch of small randomly-generated puzzles, sorts
// them by difficulty, and renders each as an interactive Learn-style canvas
// puzzle. Useful while we explore what "good" deduction puzzles look like
// before committing any to a curated database.

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
	sub.textContent = "Randomly generated small puzzles, sorted by difficulty. 1 = forced/satisfied only · 2 = one subset deduction · 3 = chain of subset · 4 = case analysis on ≤4 cells · 5 = case analysis on ≥5 cells (or chain).";
	view.appendChild(sub);

	var actions = document.createElement("div");
	actions.className = "puzzles-actions";
	[10, 20, 40].forEach(function(n) {
		var btn = document.createElement("button");
		btn.className = "btn " + (n === 20 ? "btn-primary" : "btn-secondary");
		btn.textContent = "Generate " + n;
		btn.addEventListener("click", function() { fetchAndRender(n); });
		actions.appendChild(btn);
	});
	view.appendChild(actions);

	var status = document.createElement("p");
	status.id = "puzzle_lab_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var grid = document.createElement("div");
	grid.id = "puzzles_grid";
	grid.className = "puzzles-grid";
	view.appendChild(grid);

	fetchAndRender(20);
}

function fetchAndRender(count) {
	var status = document.getElementById("puzzle_lab_status");
	if (status) status.textContent = "Generating " + count + " puzzles…";
	fetch("/api/puzzles?count=" + count).then(function(r) { return r.json(); }).then(function(data) {
		var puzzles = (data && data.puzzles) || [];
		var grid = document.getElementById("puzzles_grid");
		grid.innerHTML = "";
		puzzles.sort(function(a, b) {
			return a.difficulty - b.difficulty || a.coveredSafe - b.coveredSafe;
		});
		var byDiff = {};
		puzzles.forEach(function(p) { byDiff[p.difficulty] = (byDiff[p.difficulty] || 0) + 1; });
		var diffSummary = Object.keys(byDiff).sort().map(function(d) { return "diff " + d + ": " + byDiff[d]; }).join(" · ");
		if (status) status.textContent = puzzles.length + " puzzles · " + diffSummary;
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
	diffBadge.textContent = "Difficulty " + p.difficulty;
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
