// All-puzzles browse page.
//
// Mirrors the Lab's data source (`GET /api/puzzles`) but presents the pool as
// a clean, sortable, filterable browse view — no generation controls. Once
// the puzzle DB exists this page is the natural place to swap the fetch over
// to it; the rest of the UI stays unchanged.

var puzzleListState = { sort: "score-asc", diff: null };

function renderPuzzlesList() {
	var view = document.getElementById("puzzles_list_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "All puzzles";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Browse the current puzzle pool. Sort by difficulty rating, filter by tier.";
	view.appendChild(sub);

	var toolbar = document.createElement("div");
	toolbar.className = "puzzles-toolbar";

	var sortWrap = document.createElement("div");
	sortWrap.className = "puzzles-sort-wrap";
	var sortLabel = document.createElement("span");
	sortLabel.className = "puzzles-filter-label";
	sortLabel.textContent = "Sort";
	sortWrap.appendChild(sortLabel);
	var sortSelect = document.createElement("select");
	sortSelect.className = "puzzles-sort-select";
	[
		{ value: "score-asc", label: "Easiest first" },
		{ value: "score-desc", label: "Hardest first" }
	].forEach(function(opt) {
		var o = document.createElement("option");
		o.value = opt.value;
		o.textContent = opt.label;
		if (opt.value === puzzleListState.sort) o.selected = true;
		sortSelect.appendChild(o);
	});
	sortSelect.addEventListener("change", function() {
		puzzleListState.sort = sortSelect.value;
		refreshPuzzleList();
	});
	sortWrap.appendChild(sortSelect);
	toolbar.appendChild(sortWrap);

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
		if ((d === "all" && puzzleListState.diff == null) || d === puzzleListState.diff) btn.classList.add("active");
		if (d !== "all") btn.classList.add("puzzles-filter-chip-diff-" + d);
		btn.addEventListener("click", function() {
			puzzleListState.diff = (d === "all") ? null : d;
			updatePuzzleListFilterChips();
			refreshPuzzleList();
		});
		filter.appendChild(btn);
	});
	toolbar.appendChild(filter);
	view.appendChild(toolbar);

	var status = document.createElement("p");
	status.id = "puzzles_list_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var grid = document.createElement("div");
	grid.id = "puzzles_list_grid";
	grid.className = "puzzles-grid";
	view.appendChild(grid);

	var labLink = document.createElement("p");
	labLink.className = "puzzles-list-footer";
	labLink.innerHTML = '<a href="#/puzzles">Open the Puzzle Lab →</a>';
	view.appendChild(labLink);

	refreshPuzzleList();
}

function updatePuzzleListFilterChips() {
	document.querySelectorAll("#puzzles_list_view .puzzles-filter-chip").forEach(function(b) {
		var d = b.dataset.diff;
		var match = (d === "all" && puzzleListState.diff == null) || (parseInt(d, 10) === puzzleListState.diff);
		b.classList.toggle("active", !!match);
	});
}

function refreshPuzzleList() {
	var diff = puzzleListState.diff;
	var url = "/api/puzzles" + (diff ? "?diff=" + diff : "");
	fetch(url).then(function(r) { return r.json(); }).then(function(data) {
		var puzzles = (data && data.puzzles) || [];
		var dir = (puzzleListState.sort === "score-desc") ? -1 : 1;
		puzzles.sort(function(a, b) { return dir * ((a.score || 0) - (b.score || 0)); });

		var status = document.getElementById("puzzles_list_status");
		if (status) {
			var bits = ["Pool: " + (data.pool != null ? data.pool : puzzles.length) + " puzzles"];
			if (diff) bits.push("showing diff " + diff + " · " + puzzles.length);
			status.textContent = bits.join(" · ");
		}

		var grid = document.getElementById("puzzles_list_grid");
		if (!grid) return;
		grid.innerHTML = "";
		if (puzzles.length === 0) {
			var empty = document.createElement("p");
			empty.className = "puzzles-list-empty";
			empty.textContent = "No puzzles to show — head to the Lab to generate some.";
			grid.appendChild(empty);
			return;
		}
		puzzles.forEach(function(p) { grid.appendChild(renderPuzzleListCard(p)); });
	}).catch(function(e) {
		var status = document.getElementById("puzzles_list_status");
		if (status) status.textContent = "Error: " + e.message;
	});
}

function renderPuzzleListCard(p) {
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
	var density = Math.round((p.mines.length / (p.rows * p.cols)) * 100);
	meta.textContent = p.rows + "×" + p.cols + " · " + p.coveredSafe + " covered · " + density + "%";
	head.appendChild(meta);
	card.appendChild(head);

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
