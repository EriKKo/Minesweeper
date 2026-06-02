// All-puzzles browse page.
//
// Mirrors the Lab's data source (`GET /api/puzzles`) but presents the pool as
// a clean, sortable, filterable browse view — no generation controls. Once
// the puzzle DB exists this page is the natural place to swap the fetch over
// to it; the rest of the UI stays unchanged.

var puzzleListState = { sort: "score-asc", diff: null, method: null, page: 0, pageSize: 50 };

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
	sub.textContent = "Browse all puzzles in the pool. Sort by rating, filter by tier. Each puzzle's rating is calibrated from the solver and will move with human play once Rated mode is live.";
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
		puzzleListState.page = 0;
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
			puzzleListState.page = 0;
			updatePuzzleListFilterChips();
			refreshPuzzleList();
		});
		filter.appendChild(btn);
	});
	toolbar.appendChild(filter);

	var methodRow = document.createElement("div");
	methodRow.className = "puzzles-filter";
	var methodLabel = document.createElement("span");
	methodLabel.className = "puzzles-filter-label";
	methodLabel.textContent = "Method";
	methodRow.appendChild(methodLabel);
	[
		{ key: null, label: "Any" },
		{ key: "trivial", label: "Trivial only" },
		{ key: "subset", label: "Subset" },
		{ key: "enum", label: "Enum required" }
	].forEach(function(opt) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset.method = opt.key == null ? "any" : opt.key;
		btn.textContent = opt.label;
		if (opt.key === puzzleListState.method) btn.classList.add("active");
		btn.addEventListener("click", function() {
			puzzleListState.method = opt.key;
			puzzleListState.page = 0;
			updatePuzzleListMethodChips();
			refreshPuzzleList();
		});
		methodRow.appendChild(btn);
	});
	toolbar.appendChild(methodRow);

	view.appendChild(toolbar);

	var status = document.createElement("p");
	status.id = "puzzles_list_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var grid = document.createElement("div");
	grid.id = "puzzles_list_grid";
	grid.className = "puzzles-grid";
	view.appendChild(grid);

	var pager = document.createElement("div");
	pager.id = "puzzles_list_pager";
	pager.className = "puzzles-pager";
	view.appendChild(pager);

	var labLink = document.createElement("p");
	labLink.className = "puzzles-list-footer";
	labLink.innerHTML = '<a href="#/admin/lab">Open the Puzzle Lab →</a>';
	view.appendChild(labLink);

	refreshPuzzleList();
}

function updatePuzzleListFilterChips() {
	document.querySelectorAll("#puzzles_list_view .puzzles-filter-chip[data-diff]").forEach(function(b) {
		var d = b.dataset.diff;
		var match = (d === "all" && puzzleListState.diff == null) || (parseInt(d, 10) === puzzleListState.diff);
		b.classList.toggle("active", !!match);
	});
}

function updatePuzzleListMethodChips() {
	document.querySelectorAll("#puzzles_list_view .puzzles-filter-chip[data-method]").forEach(function(b) {
		var m = b.dataset.method;
		var match = (m === "any" && puzzleListState.method == null) || (m === puzzleListState.method);
		b.classList.toggle("active", !!match);
	});
}

function refreshPuzzleList() {
	var diff = puzzleListState.diff;
	var sort = puzzleListState.sort === "score-desc" ? "desc" : "asc";
	var page = puzzleListState.page || 0;
	var pageSize = puzzleListState.pageSize || 50;
	var method = puzzleListState.method;
	var qs = "page=" + page + "&pageSize=" + pageSize + "&sort=" + sort
		+ (diff ? "&diff=" + diff : "")
		+ (method ? "&method=" + method : "");
	var url = "/api/puzzles?" + qs;
	fetch(url).then(function(r) { return r.json(); }).then(function(data) {
		var puzzles = (data && data.puzzles) || [];
		var total = data && typeof data.total === "number" ? data.total : puzzles.length;
		var pool = data && data.pool != null ? data.pool : total;

		var status = document.getElementById("puzzles_list_status");
		if (status) {
			var bits = ["Pool: " + pool + " puzzles"];
			if (diff) bits.push("diff " + diff + " · " + total);
			var fromN = total ? (page * pageSize + 1) : 0;
			var toN = Math.min(total, (page + 1) * pageSize);
			bits.push("showing " + fromN + "–" + toN);
			status.textContent = bits.join(" · ");
		}

		var grid = document.getElementById("puzzles_list_grid");
		if (!grid) return;
		grid.innerHTML = "";
		if (puzzles.length === 0) {
			var empty = document.createElement("p");
			empty.className = "puzzles-list-empty";
			empty.textContent = page > 0
				? "No puzzles on this page — try going back."
				: "No puzzles to show — head to the Lab to generate some.";
			grid.appendChild(empty);
		} else {
			puzzles.forEach(function(p) { grid.appendChild(renderPuzzleListCard(p)); });
		}
		renderPuzzleListPager(total, page, pageSize);
	}).catch(function(e) {
		var status = document.getElementById("puzzles_list_status");
		if (status) status.textContent = "Error: " + e.message;
	});
}

function renderPuzzleListPager(total, page, pageSize) {
	var pager = document.getElementById("puzzles_list_pager");
	if (!pager) return;
	pager.innerHTML = "";
	var totalPages = Math.max(1, Math.ceil(total / pageSize));
	if (totalPages <= 1) return;

	function addBtn(label, target, opts) {
		opts = opts || {};
		var b = document.createElement("button");
		b.className = "puzzles-pager-btn" + (opts.current ? " current" : "");
		b.textContent = label;
		b.disabled = !!opts.disabled || target === page;
		b.addEventListener("click", function() {
			if (target === page) return;
			puzzleListState.page = Math.max(0, Math.min(totalPages - 1, target));
			refreshPuzzleList();
		});
		pager.appendChild(b);
	}

	addBtn("← Prev", page - 1, { disabled: page <= 0 });

	// Compact numeric range around the current page.
	var windowSize = 5;
	var start = Math.max(0, page - Math.floor(windowSize / 2));
	var end = Math.min(totalPages - 1, start + windowSize - 1);
	start = Math.max(0, end - windowSize + 1);
	if (start > 0) {
		addBtn("1", 0);
		if (start > 1) {
			var dots = document.createElement("span");
			dots.className = "puzzles-pager-dots";
			dots.textContent = "…";
			pager.appendChild(dots);
		}
	}
	for (var i = start; i <= end; i++) addBtn(String(i + 1), i, { current: i === page });
	if (end < totalPages - 1) {
		if (end < totalPages - 2) {
			var dots2 = document.createElement("span");
			dots2.className = "puzzles-pager-dots";
			dots2.textContent = "…";
			pager.appendChild(dots2);
		}
		addBtn(String(totalPages), totalPages - 1);
	}

	addBtn("Next →", page + 1, { disabled: page >= totalPages - 1 });
}

function renderPuzzleListCard(p) {
	var card = document.createElement("div");
	card.className = "puzzle-card puzzle-diff-" + p.difficulty;

	var head = document.createElement("div");
	head.className = "puzzle-card-head";
	var diffBadge = document.createElement("span");
	diffBadge.className = "puzzle-diff-badge";
	diffBadge.textContent = (p.rating != null ? p.rating : "?") + " · t" + p.difficulty;
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
