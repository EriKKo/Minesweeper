// All-puzzles browse page.
//
// Mirrors the Lab's data source (`GET /api/puzzles`) but presents the pool as
// a clean, sortable, filterable browse view — no generation controls. Once
// the puzzle DB exists this page is the natural place to swap the fetch over
// to it; the rest of the UI stays unchanged.

var puzzleListState = { sort: "score-asc", diff: null, method: null, scoreBand: null, source: null, page: 0, pageSize: 50 };

var SOURCE_OPTIONS = [
	{ key: null, label: "Any" },
	{ key: "random", label: "Random" },
	{ key: "inside_out", label: "Inside-out" }
];

// Complexity bands shown in the All Puzzles filter. The score column
// already carries CSP maxComplexity + total/20, so these map directly to
// the difficulty bands the user sees in the rating curve.
var SCORE_BANDS = [
	{ key: null, label: "Any" },
	{ key: "0-1", label: "0–1" },
	{ key: "1-2", label: "1–2" },
	{ key: "2-3", label: "2–3" },
	{ key: "3-4", label: "3–4" },
	{ key: "4-5", label: "4–5" },
	{ key: "5-6", label: "5–6" },
	{ key: "6-8", label: "6–8" },
	{ key: "8-10", label: "8–10" },
	{ key: "10+", label: "10+" }
];

// Filters persist via the URL hash so reloading keeps the view. The hash
// after the path can carry a query string like
// #/admin/puzzles?diff=3&method=overlap&sort=desc&page=2.
function readPuzzleListStateFromHash() {
	var hash = location.hash || "";
	var qi = hash.indexOf("?");
	if (qi < 0) return;
	var params = new URLSearchParams(hash.slice(qi + 1));
	var sort = params.get("sort");
	if (sort === "score-asc" || sort === "score-desc") puzzleListState.sort = sort;
	var diff = parseInt(params.get("diff"), 10);
	puzzleListState.diff = (diff >= 1 && diff <= 6) ? diff : null;
	var method = params.get("method");
	puzzleListState.method = (method === "trivial" || method === "subset" || method === "union" || method === "intersect" || method === "case" || method === "enum") ? method : null;
	var score = params.get("score");
	var validBand = SCORE_BANDS.some(function(b) { return b.key === score; });
	puzzleListState.scoreBand = (validBand && score) ? score : null;
	var source = params.get("source");
	puzzleListState.source = (source === "random" || source === "inside_out") ? source : null;
	var page = parseInt(params.get("page"), 10);
	puzzleListState.page = (page > 0) ? page : 0;
}

function writePuzzleListStateToHash() {
	var bits = [];
	if (puzzleListState.sort && puzzleListState.sort !== "score-asc") bits.push("sort=" + puzzleListState.sort);
	if (puzzleListState.diff) bits.push("diff=" + puzzleListState.diff);
	if (puzzleListState.method) bits.push("method=" + puzzleListState.method);
	if (puzzleListState.scoreBand) bits.push("score=" + puzzleListState.scoreBand);
	if (puzzleListState.source) bits.push("source=" + puzzleListState.source);
	if (puzzleListState.page) bits.push("page=" + puzzleListState.page);
	var qs = bits.length ? "?" + bits.join("&") : "";
	var newHash = "#/admin/puzzles" + qs;
	if (location.hash !== newHash) history.replaceState(null, "", newHash);
}

function renderPuzzlesList() {
	var view = document.getElementById("puzzles_list_view");
	if (!view) return;
	readPuzzleListStateFromHash();
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "All puzzles";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Browse all puzzles in the pool. Sort by rating, filter by tier. Each puzzle's rating is calibrated from the solver and will move with human play once Rated mode is live.";
	view.appendChild(sub);

	var statsContainer = document.createElement("div");
	statsContainer.id = "puzzles_list_stats";
	statsContainer.className = "puzzles-stats";
	view.appendChild(statsContainer);
	renderPuzzleStatsPanel(statsContainer);

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
		writePuzzleListStateToHash();
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
			writePuzzleListStateToHash();
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
		{ key: "trivial", label: "Trivial" },
		{ key: "subset", label: "Subset" },
		{ key: "union", label: "Union" },
		{ key: "intersect", label: "Intersection" },
		{ key: "case", label: "Case-split" },
		{ key: "enum", label: "Enum" }
	].forEach(function(opt) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset.method = opt.key == null ? "any" : opt.key;
		btn.textContent = opt.label;
		if (opt.key === puzzleListState.method) btn.classList.add("active");
		btn.addEventListener("click", function() {
			puzzleListState.method = opt.key;
			puzzleListState.page = 0;
			writePuzzleListStateToHash();
			updatePuzzleListMethodChips();
			refreshPuzzleList();
		});
		methodRow.appendChild(btn);
	});
	toolbar.appendChild(methodRow);

	var bandRow = document.createElement("div");
	bandRow.className = "puzzles-filter";
	var bandLabel = document.createElement("span");
	bandLabel.className = "puzzles-filter-label";
	bandLabel.textContent = "Complexity";
	bandRow.appendChild(bandLabel);
	SCORE_BANDS.forEach(function(opt) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset.band = opt.key == null ? "any" : opt.key;
		btn.textContent = opt.label;
		if (opt.key === puzzleListState.scoreBand) btn.classList.add("active");
		btn.addEventListener("click", function() {
			puzzleListState.scoreBand = opt.key;
			puzzleListState.page = 0;
			writePuzzleListStateToHash();
			updatePuzzleListBandChips();
			refreshPuzzleList();
		});
		bandRow.appendChild(btn);
	});
	toolbar.appendChild(bandRow);

	var sourceRow = document.createElement("div");
	sourceRow.className = "puzzles-filter";
	var sourceLabel = document.createElement("span");
	sourceLabel.className = "puzzles-filter-label";
	sourceLabel.textContent = "Source";
	sourceRow.appendChild(sourceLabel);
	SOURCE_OPTIONS.forEach(function(opt) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset.source = opt.key == null ? "any" : opt.key;
		btn.textContent = opt.label;
		if (opt.key === puzzleListState.source) btn.classList.add("active");
		btn.addEventListener("click", function() {
			puzzleListState.source = opt.key;
			puzzleListState.page = 0;
			writePuzzleListStateToHash();
			updatePuzzleListSourceChips();
			refreshPuzzleList();
		});
		sourceRow.appendChild(btn);
	});
	toolbar.appendChild(sourceRow);

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

function updatePuzzleListSourceChips() {
	document.querySelectorAll("#puzzles_list_view .puzzles-filter-chip[data-source]").forEach(function(b) {
		var s = b.dataset.source;
		var match = (s === "any" && puzzleListState.source == null) || (s === puzzleListState.source);
		b.classList.toggle("active", !!match);
	});
}

// Stats panel above the listing: rating histogram, tier breakdown, board-
// size mix, density mix. Collapsed by default to keep the listing prime.
var puzzleStatsExpanded = false;

function renderPuzzleStatsPanel(container) {
	container.innerHTML = "";
	var head = document.createElement("button");
	head.className = "puzzles-stats-toggle";
	head.textContent = (puzzleStatsExpanded ? "▼" : "▶") + " Stats";
	container.appendChild(head);
	var body = document.createElement("div");
	body.className = "puzzles-stats-body";
	body.style.display = puzzleStatsExpanded ? "block" : "none";
	container.appendChild(body);
	head.addEventListener("click", function() {
		puzzleStatsExpanded = !puzzleStatsExpanded;
		head.textContent = (puzzleStatsExpanded ? "▼" : "▶") + " Stats";
		body.style.display = puzzleStatsExpanded ? "block" : "none";
		if (puzzleStatsExpanded && !body.dataset.loaded) {
			body.dataset.loaded = "1";
			loadPuzzleStatsInto(body);
		}
	});
	if (puzzleStatsExpanded && !body.dataset.loaded) {
		body.dataset.loaded = "1";
		loadPuzzleStatsInto(body);
	}
}

function loadPuzzleStatsInto(body) {
	body.textContent = "Loading…";
	fetch("/api/puzzles/stats").then(function(r) { return r.json(); }).then(function(data) {
		body.innerHTML = "";
		if (!data.total) {
			body.textContent = "Pool empty.";
			return;
		}
		body.appendChild(renderStatBlock("Rating distribution", buildRatingChart(data.ratingHistogram, data.total)));
		body.appendChild(renderStatBlock("Tier breakdown", buildTierChart(data.tierBreakdown, data.total)));
		body.appendChild(renderStatBlock("Board sizes", buildSizeChart(data.sizeMix, data.total)));
		body.appendChild(renderStatBlock("Mine density", buildDensityChart(data.densityMix, data.total)));
		if (data.needsCaseSplit > 0) {
			var note = document.createElement("p");
			note.className = "puzzles-stats-note";
			note.textContent = data.needsCaseSplit + " puzzles need case-split (" + Math.round(100 * data.needsCaseSplit / data.total) + "% of pool)";
			body.appendChild(note);
		}
	}).catch(function(e) {
		body.textContent = "Error: " + e.message;
	});
}

function renderStatBlock(title, contentEl) {
	var wrap = document.createElement("div");
	wrap.className = "puzzles-stats-block";
	var h = document.createElement("h3");
	h.className = "puzzles-stats-block-title";
	h.textContent = title;
	wrap.appendChild(h);
	wrap.appendChild(contentEl);
	return wrap;
}

function maxOf(arr, getter) {
	var m = 0;
	for (var i = 0; i < arr.length; i++) { var v = getter(arr[i]); if (v > m) m = v; }
	return m || 1;
}

function buildRatingChart(buckets, total) {
	var tbl = document.createElement("div");
	tbl.className = "puzzles-stats-chart";
	var max = maxOf(buckets, function(b) { return b.n; });
	buckets.forEach(function(b) {
		var row = document.createElement("div");
		row.className = "puzzles-stats-row";
		var lbl = document.createElement("span");
		lbl.className = "puzzles-stats-label";
		lbl.textContent = b.bucket + "–" + (b.bucket + 199);
		row.appendChild(lbl);
		var barBg = document.createElement("span");
		barBg.className = "puzzles-stats-bar";
		var bar = document.createElement("span");
		bar.className = "puzzles-stats-bar-fill";
		bar.style.width = Math.round(100 * b.n / max) + "%";
		barBg.appendChild(bar);
		row.appendChild(barBg);
		var v = document.createElement("span");
		v.className = "puzzles-stats-value";
		v.textContent = b.n;
		row.appendChild(v);
		tbl.appendChild(row);
	});
	return tbl;
}

function buildTierChart(tiers, total) {
	// Stacked bar per tier showing method composition (trivial/subset/overlap/chain/enum).
	var tbl = document.createElement("div");
	tbl.className = "puzzles-stats-chart";
	var max = maxOf(tiers, function(t) { return t.n; });
	var methodKeys = ["trivial", "subset", "union", "intersect", "case", "enum"];
	tiers.forEach(function(t) {
		var row = document.createElement("div");
		row.className = "puzzles-stats-row";
		var lbl = document.createElement("span");
		lbl.className = "puzzles-stats-label";
		lbl.textContent = "tier " + t.tier;
		row.appendChild(lbl);
		var barBg = document.createElement("span");
		barBg.className = "puzzles-stats-bar";
		var widthPct = (t.n / max) * 100;
		var stack = document.createElement("span");
		stack.className = "puzzles-stats-stack";
		stack.style.width = widthPct + "%";
		methodKeys.forEach(function(k) {
			if (!t[k]) return;
			var seg = document.createElement("span");
			seg.className = "puzzles-stats-seg puzzles-stats-seg-" + k;
			seg.style.width = Math.round(100 * t[k] / t.n) + "%";
			seg.title = k + ": " + t[k];
			stack.appendChild(seg);
		});
		barBg.appendChild(stack);
		row.appendChild(barBg);
		var v = document.createElement("span");
		v.className = "puzzles-stats-value";
		v.textContent = t.n;
		row.appendChild(v);
		tbl.appendChild(row);
	});
	var legend = document.createElement("div");
	legend.className = "puzzles-stats-legend";
	methodKeys.forEach(function(k) {
		var item = document.createElement("span");
		item.className = "puzzles-stats-legend-item";
		var swatch = document.createElement("span");
		swatch.className = "puzzles-stats-seg puzzles-stats-seg-" + k;
		item.appendChild(swatch);
		var lbl = document.createTextNode(" " + k);
		item.appendChild(lbl);
		legend.appendChild(item);
	});
	tbl.appendChild(legend);
	return tbl;
}

function buildSizeChart(sizes, total) {
	var tbl = document.createElement("div");
	tbl.className = "puzzles-stats-chart";
	var max = maxOf(sizes, function(s) { return s.n; });
	sizes.forEach(function(s) {
		var row = document.createElement("div");
		row.className = "puzzles-stats-row";
		var lbl = document.createElement("span");
		lbl.className = "puzzles-stats-label";
		lbl.textContent = s.size;
		row.appendChild(lbl);
		var barBg = document.createElement("span");
		barBg.className = "puzzles-stats-bar";
		var bar = document.createElement("span");
		bar.className = "puzzles-stats-bar-fill";
		bar.style.width = Math.round(100 * s.n / max) + "%";
		barBg.appendChild(bar);
		row.appendChild(barBg);
		var v = document.createElement("span");
		v.className = "puzzles-stats-value";
		v.textContent = s.n;
		row.appendChild(v);
		tbl.appendChild(row);
	});
	return tbl;
}

function buildDensityChart(buckets, total) {
	var tbl = document.createElement("div");
	tbl.className = "puzzles-stats-chart";
	var max = maxOf(buckets, function(b) { return b.n; });
	buckets.forEach(function(b) {
		var row = document.createElement("div");
		row.className = "puzzles-stats-row";
		var lbl = document.createElement("span");
		lbl.className = "puzzles-stats-label";
		lbl.textContent = b.bucket + "–" + (b.bucket + 4) + "%";
		row.appendChild(lbl);
		var barBg = document.createElement("span");
		barBg.className = "puzzles-stats-bar";
		var bar = document.createElement("span");
		bar.className = "puzzles-stats-bar-fill";
		bar.style.width = Math.round(100 * b.n / max) + "%";
		barBg.appendChild(bar);
		row.appendChild(barBg);
		var v = document.createElement("span");
		v.className = "puzzles-stats-value";
		v.textContent = b.n;
		row.appendChild(v);
		tbl.appendChild(row);
	});
	return tbl;
}

function updatePuzzleListBandChips() {
	document.querySelectorAll("#puzzles_list_view .puzzles-filter-chip[data-band]").forEach(function(b) {
		var v = b.dataset.band;
		var match = (v === "any" && puzzleListState.scoreBand == null) || (v === puzzleListState.scoreBand);
		b.classList.toggle("active", !!match);
	});
}

function refreshPuzzleList() {
	var diff = puzzleListState.diff;
	var sort = puzzleListState.sort === "score-desc" ? "desc" : "asc";
	var page = puzzleListState.page || 0;
	var pageSize = puzzleListState.pageSize || 50;
	var method = puzzleListState.method;
	var band = puzzleListState.scoreBand;
	var source = puzzleListState.source;
	var qs = "page=" + page + "&pageSize=" + pageSize + "&sort=" + sort
		+ (diff ? "&diff=" + diff : "")
		+ (method ? "&method=" + method : "")
		+ (band ? "&score=" + encodeURIComponent(band) : "")
		+ (source ? "&source=" + source : "");
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
			writePuzzleListStateToHash();
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
	var analyzeBtn = document.createElement("button");
	analyzeBtn.className = "puzzle-card-analyze";
	analyzeBtn.textContent = "Analyze";
	analyzeBtn.addEventListener("click", function(e) { e.stopPropagation(); openAnalyzeModal(p); });
	head.appendChild(analyzeBtn);
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

// Floating modal that lets the user play the puzzle interactively while
// the CSP solver's move trace is fetched and displayed alongside. Each
// move row shows the action (reveal/flag), affected cells, and the
// complexity the solver assigned to the deduction.
function openAnalyzeModal(p) {
	var prev = document.getElementById("analyze_modal");
	if (prev) prev.remove();

	var backdrop = document.createElement("div");
	backdrop.id = "analyze_modal";
	backdrop.className = "analyze-modal-backdrop";
	backdrop.addEventListener("click", function(e) { if (e.target === backdrop) closeAnalyzeModal(); });

	var panel = document.createElement("div");
	panel.className = "analyze-modal";

	var head = document.createElement("div");
	head.className = "analyze-modal-head";
	var title = document.createElement("h2");
	title.textContent = "Analyze · puzzle " + p.id;
	head.appendChild(title);
	var sub = document.createElement("span");
	sub.className = "analyze-modal-sub";
	var density = Math.round((p.mines.length / (p.rows * p.cols)) * 100);
	sub.textContent = p.rows + "×" + p.cols + " · " + density + "% · rating " + p.rating + " · t" + p.difficulty;
	head.appendChild(sub);
	var closeBtn = document.createElement("button");
	closeBtn.className = "analyze-modal-close";
	closeBtn.textContent = "Close";
	closeBtn.addEventListener("click", closeAnalyzeModal);
	head.appendChild(closeBtn);
	panel.appendChild(head);

	var body = document.createElement("div");
	body.className = "analyze-modal-body";

	var boardCol = document.createElement("div");
	boardCol.className = "analyze-modal-board";
	var playable = buildLearnPuzzle({
		title: "",
		rows: p.rows,
		cols: p.cols,
		mines: p.mines,
		revealed: p.revealed
	}, false, function() {});
	boardCol.appendChild(playable);
	var controller = playable._controller;
	body.appendChild(boardCol);

	var traceCol = document.createElement("div");
	traceCol.className = "analyze-modal-trace";
	var traceHeadRow = document.createElement("div");
	traceHeadRow.className = "analyze-trace-head-row";
	var traceHead = document.createElement("div");
	traceHead.className = "analyze-trace-head";
	traceHead.textContent = "Solver moves";
	traceHeadRow.appendChild(traceHead);
	var playAllBtn = document.createElement("button");
	playAllBtn.className = "analyze-trace-playall";
	playAllBtn.textContent = "Play all";
	playAllBtn.disabled = true;
	traceHeadRow.appendChild(playAllBtn);
	traceCol.appendChild(traceHeadRow);
	var traceStatus = document.createElement("div");
	traceStatus.className = "analyze-trace-status";
	traceStatus.textContent = "Analyzing…";
	traceCol.appendChild(traceStatus);
	var traceList = document.createElement("ol");
	traceList.className = "analyze-trace-list";
	traceCol.appendChild(traceList);
	body.appendChild(traceCol);

	panel.appendChild(body);
	backdrop.appendChild(panel);
	document.body.appendChild(backdrop);

	document.addEventListener("keydown", onAnalyzeModalKey);

	// Apply move-bundles 0..upTo, then highlight the focused bundle's cells.
	function applyMovesAndHighlight(bundles, upTo, focusIndex) {
		controller.reset();
		for (var i = 0; i <= upTo && i < bundles.length; i++) {
			var b = bundles[i];
			for (var rj = 0; rj < b.revealed.length; rj++) controller.revealCell(b.revealed[rj][0], b.revealed[rj][1]);
			for (var fj = 0; fj < b.flagged.length; fj++) controller.flagCell(b.flagged[fj][0], b.flagged[fj][1]);
		}
		if (focusIndex != null && bundles[focusIndex]) {
			var b2 = bundles[focusIndex];
			controller.highlight(b2.revealed.concat(b2.flagged));
		} else {
			controller.highlight(null);
		}
	}

	fetch("/api/puzzles/" + p.id + "/analyze").then(function(r) { return r.json(); }).then(function(data) {
		if (!document.getElementById("analyze_modal")) return;
		if (data && data.error) {
			traceStatus.textContent = "Error: " + data.error;
			return;
		}
		var moves = data.moves || [];
		function fmt(n) { return (Math.round(n * 10) / 10).toFixed(1); }
		traceStatus.textContent = "max complexity " + fmt(data.maxComplexity) + " · total " + fmt(data.totalComplexity)
			+ (data.solved ? " · solved" : " · " + data.safeCovered + " safe cells uncovered");

		var liRefs = [];
		moves.forEach(function(mv, i) {
			var li = document.createElement("li");
			// Pick a per-move accent: pure reveals stay green, pure flags
			// red, mixed stays neutral, and case/enum get their own tint.
			var accent;
			if (mv.method === "case") accent = "case";
			else if (mv.method === "enum") accent = "enum";
			else if ((mv.revealed || []).length && (mv.flagged || []).length) accent = "mixed";
			else if ((mv.revealed || []).length) accent = "reveal";
			else accent = "flag";
			li.className = "analyze-trace-move analyze-trace-" + accent;
			var header = document.createElement("div");
			header.className = "analyze-trace-header";

			var hasDerivation = mv.derivation && mv.derivation.length > 1;
			var hasBranches = mv.method === "case" && mv.branches;
			var expandable = hasDerivation || hasBranches;
			var toggle = document.createElement("span");
			toggle.className = "analyze-trace-toggle" + (expandable ? "" : " analyze-trace-toggle-empty");
			toggle.textContent = expandable ? "▶" : "·";
			header.appendChild(toggle);

			var ix = document.createElement("span");
			ix.className = "analyze-trace-index";
			ix.textContent = "#" + (i + 1);
			header.appendChild(ix);

			var act = document.createElement("span");
			act.className = "analyze-trace-action";
			// Describe the conclusion(s): safe cells, mine cells, or both.
			// Case-split and enum get a prefix because their mechanism is
			// distinctive — everything else just reads as its outcome.
			var rCount = (mv.revealed || []).length;
			var fCount = (mv.flagged || []).length;
			function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
			var outcome;
			if (rCount && fCount) outcome = plural(rCount, "safe") + ", " + plural(fCount, "mine");
			else if (rCount) outcome = plural(rCount, "safe");
			else outcome = plural(fCount, "mine");
			if (mv.method === "case") act.textContent = "case·(" + mv.splitCell[0] + "," + mv.splitCell[1] + ") → " + outcome;
			else if (mv.method === "enum") act.textContent = "enum·" + mv.componentSize + " → " + outcome;
			else act.textContent = outcome;
			header.appendChild(act);

			var cells = document.createElement("span");
			cells.className = "analyze-trace-cells";
			var cellList = mv.changed || mv.cells || [];
			cells.textContent = cellList.map(function(rc) { return "(" + rc[0] + "," + rc[1] + ")"; }).join(" ");
			header.appendChild(cells);

			if (typeof mv.depth === "number" && hasDerivation) {
				var depth = document.createElement("span");
				depth.className = "analyze-trace-depth";
				depth.textContent = "d=" + mv.depth;
				header.appendChild(depth);
			}

			var compl = document.createElement("span");
			compl.className = "analyze-trace-compl";
			compl.textContent = "c=" + (Math.round(mv.complexity * 10) / 10);
			header.appendChild(compl);
			li.appendChild(header);

			var detail = null;
			if (expandable) {
				detail = document.createElement("div");
				detail.className = "analyze-trace-detail";
				detail.style.display = "none";
				(function(moveIdx, mvLocal) {
					if (hasDerivation) {
						renderDerivation(detail, mvLocal.derivation, {
							onHover: function(step, steps) {
								applyMovesAndHighlight(moves, moveIdx - 1, null);
								var primary = step.cells.slice();
								if (step.from) primary.push(step.from);
								var context = [];
								if (step.parents) {
									step.parents.forEach(function(pi) {
										var par = steps[pi];
										if (!par) return;
										par.cells.forEach(function(c) { context.push(c); });
										if (par.from) context.push(par.from);
									});
								}
								controller.highlight({ primary: primary, context: context });
							},
							onLeave: function() { applyMovesAndHighlight(moves, moveIdx, moveIdx); }
						});
					}
					if (hasBranches) {
						renderCaseBranches(detail, mvLocal, moveIdx, moves, controller, applyMovesAndHighlight);
					}
				})(i, mv);
				li.appendChild(detail);
				toggle.addEventListener("click", function(e) {
					e.stopPropagation();
					var open = detail.style.display !== "none";
					detail.style.display = open ? "none" : "block";
					toggle.textContent = open ? "▶" : "▼";
				});
			}

			header.addEventListener("click", function(e) {
				if (e.target === toggle) return;
				liRefs.forEach(function(other) { other.classList.remove("active"); });
				li.classList.add("active");
				applyMovesAndHighlight(moves, i, i);
			});
			traceList.appendChild(li);
			liRefs.push(li);
		});

		playAllBtn.disabled = moves.length === 0;
		var playToken = 0;
		playAllBtn.addEventListener("click", function() {
			var myToken = ++playToken;
			controller.reset();
			liRefs.forEach(function(li) { li.classList.remove("active"); });
			var i = 0;
			function step() {
				if (myToken !== playToken) return;
				if (i >= moves.length) { controller.highlight(null); return; }
				applyMovesAndHighlight(moves, i, i);
				if (liRefs[i]) {
					liRefs.forEach(function(li) { li.classList.remove("active"); });
					liRefs[i].classList.add("active");
					liRefs[i].scrollIntoView({ block: "nearest" });
				}
				i++;
				setTimeout(step, 500);
			}
			step();
		});
	}).catch(function(e) {
		traceStatus.textContent = "Error: " + e.message;
	});
}

// Render the derivation tree of a move as a topologically-ordered list
// of steps. Each step references its parents by step index, so the user
// can read it like a proof: initial reads first, derived clues after.
function setName(idx) {
	if (idx < 26) return String.fromCharCode(65 + idx);
	return String.fromCharCode(65 + Math.floor(idx / 26) - 1) + String.fromCharCode(65 + (idx % 26));
}

function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

function describeMines(step) {
	var lo = step.lo, hi = step.hi;
	if (lo === hi) return plural(lo, "mine");
	if (lo === 0) return "at most " + plural(hi, "mine");
	if (hi === step.cells.length) return "at least " + plural(lo, "mine");
	return "between " + lo + " and " + plural(hi, "mine");
}

function describeStep(step) {
	var cells = plural(step.cells.length, "cell");
	var mines = describeMines(step);
	var tail = "";
	if (step.cells.length > 0 && step.lo === step.hi) {
		if (step.hi === step.cells.length) tail = " (all mines!)";
		else if (step.hi === 0) tail = " (all safe!)";
	}
	if (step.source === "initial") {
		return "from clue at (" + step.from[0] + "," + step.from[1] + ") → " + cells + ", " + mines + tail;
	}
	var pA = setName(step.parents[0]);
	var pB = setName(step.parents[1]);
	if (step.source === "subset") {
		// parents[1] is the superset, parents[0] the subset (see combineSubset)
		return pB + " minus " + pA + " → " + cells + ", " + mines + tail;
	}
	if (step.source === "union") {
		return pA + " combined with " + pB + " → " + cells + ", " + mines + tail;
	}
	if (step.source === "intersect") {
		return "overlap of " + pA + " and " + pB + " → " + cells + ", " + mines + tail;
	}
	return step.source;
}

function renderDerivation(container, steps, opts) {
	opts = opts || {};
	steps.forEach(function(step) {
		var row = document.createElement("div");
		row.className = "analyze-deriv-step analyze-deriv-" + step.source;
		var label = document.createElement("span");
		label.className = "analyze-deriv-label";
		label.textContent = "Set " + setName(step.index);
		row.appendChild(label);
		var body = document.createElement("span");
		body.className = "analyze-deriv-body";
		body.textContent = describeStep(step);
		row.appendChild(body);
		var compl = document.createElement("span");
		compl.className = "analyze-deriv-compl";
		compl.textContent = "c=" + step.complexity;
		row.appendChild(compl);
		if (opts.onHover) {
			row.addEventListener("mouseenter", function() { opts.onHover(step, steps); });
			row.addEventListener("mouseleave", function() { if (opts.onLeave) opts.onLeave(); });
		}
		container.appendChild(row);
	});
}

// Render the two branches of a case-split move. Each branch is shown
// with the moves the propagator took until either (a) a contradiction
// was reached — meaning the split cell can't have that value, or (b)
// the branch survives but pins certain cells. Hovering a move in a
// branch highlights its cells on the board, with the state replayed to
// just before the case-split + the hypothesis applied so the user can
// see exactly what the solver was looking at.
function renderCaseBranches(container, mv, moveIdx, moves, controller, applyMovesAndHighlight) {
	var split = mv.splitCell;
	["safe", "mine"].forEach(function(which) {
		var branch = mv.branches && mv.branches[which];
		if (!branch) return;
		var header = document.createElement("div");
		header.className = "analyze-case-branch-head";
		var hyp = document.createElement("span");
		hyp.className = "analyze-case-hyp analyze-case-hyp-" + which;
		hyp.textContent = "If (" + split[0] + "," + split[1] + ") is " + (which === "safe" ? "safe" : "a mine");
		header.appendChild(hyp);
		if (branch.contradiction) {
			var tag = document.createElement("span");
			tag.className = "analyze-case-tag";
			tag.textContent = "→ contradiction at (" + branch.contradiction.clue[0] + "," + branch.contradiction.clue[1] + ")";
			header.appendChild(tag);
		} else {
			var tag2 = document.createElement("span");
			tag2.className = "analyze-case-tag analyze-case-tag-ok";
			tag2.textContent = "→ consistent";
			header.appendChild(tag2);
		}
		container.appendChild(header);

		function applyHypothetical() {
			// Reset to state just before this case-split move, then apply
			// the hypothesis (the split-cell value being tested).
			applyMovesAndHighlight(moves, moveIdx - 1, null);
			if (which === "safe") controller.revealCell(split[0], split[1]);
			else controller.flagCell(split[0], split[1]);
		}
		function applyHypotheticalUpTo(stepIdx) {
			applyHypothetical();
			for (var k = 0; k <= stepIdx && k < branch.moves.length; k++) {
				var bm = branch.moves[k];
				var bcells = bm.changed && bm.changed.length ? bm.changed : bm.cells;
				if (bm.action === "flag") {
					for (var f = 0; f < bcells.length; f++) controller.flagCell(bcells[f][0], bcells[f][1]);
				} else {
					for (var r = 0; r < bcells.length; r++) controller.revealCell(bcells[r][0], bcells[r][1]);
				}
			}
		}

		branch.moves.forEach(function(bmv, bi) {
			var row = document.createElement("div");
			row.className = "analyze-case-step analyze-case-step-" + bmv.action;
			var num = document.createElement("span");
			num.className = "analyze-case-step-num";
			num.textContent = (bi + 1) + ".";
			row.appendChild(num);
			var act = document.createElement("span");
			act.className = "analyze-case-step-action";
			act.textContent = bmv.action === "flag" ? "flag" : "reveal";
			row.appendChild(act);
			var cells = document.createElement("span");
			cells.className = "analyze-case-step-cells";
			cells.textContent = (bmv.changed || bmv.cells).map(function(rc) { return "(" + rc[0] + "," + rc[1] + ")"; }).join(" ");
			row.appendChild(cells);
			var compl = document.createElement("span");
			compl.className = "analyze-case-step-compl";
			compl.textContent = "c=" + (Math.round(bmv.complexity * 10) / 10);
			row.appendChild(compl);
			row.addEventListener("mouseenter", function() {
				applyHypotheticalUpTo(bi);
				controller.highlight({
					primary: bmv.changed || bmv.cells,
					context: [split]
				});
			});
			row.addEventListener("mouseleave", function() {
				applyMovesAndHighlight(moves, moveIdx, moveIdx);
			});
			container.appendChild(row);
		});

		if (branch.contradiction) {
			// Final row showing the contradicting clue itself.
			var contraRow = document.createElement("div");
			contraRow.className = "analyze-case-contra";
			contraRow.textContent = "✗ " + branch.contradiction.why;
			contraRow.addEventListener("mouseenter", function() {
				applyHypotheticalUpTo(branch.moves.length - 1);
				controller.highlight({
					primary: [branch.contradiction.clue],
					context: [split]
				});
			});
			contraRow.addEventListener("mouseleave", function() {
				applyMovesAndHighlight(moves, moveIdx, moveIdx);
			});
			container.appendChild(contraRow);
		}
	});
}

function closeAnalyzeModal() {
	var el = document.getElementById("analyze_modal");
	if (el) el.remove();
	document.removeEventListener("keydown", onAnalyzeModalKey);
}

function onAnalyzeModalKey(e) {
	if (e.key === "Escape") closeAnalyzeModal();
}
