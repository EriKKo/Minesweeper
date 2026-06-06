// Admin browse view for enumerated starting-position patterns.
//
// Each pattern renders as a 5x5 grid: the inner 3x3 is the cascade
// the player would see, and the surrounding ring of 16 cells shows
// what the analyzer can deduce — forced-mine cells get a flag,
// forced-safe cells are tinted, the rest stay covered. Filter chips
// on the toolbar narrow the listing by rating band, first action,
// and solution-uniqueness.

var startingPosListState = {
	size: 3,
	sort: "desc",
	page: 0,
	pageSize: 60,
	action: null,          // null | "reveal" | "flag" | "case"
	ratingBand: null,      // null | "0-199" | "1200-1399" | "1600-1799" | "1800-1999"
	unique: null           // null | "true" | "false"
};

var RATING_BANDS = [
	{ key: null,           label: "Any" },
	{ key: "0-199",        label: "0–199" },
	{ key: "1200-1399",    label: "1200–1399" },
	{ key: "1600-1799",    label: "1600–1799" },
	{ key: "1800-1999",    label: "1800+" }
];
var ACTION_OPTIONS = [
	{ key: null,     label: "Any" },
	{ key: "reveal", label: "Reveal" },
	{ key: "flag",   label: "Flag" },
	{ key: "case",   label: "Case" }
];
var UNIQUE_OPTIONS = [
	{ key: null,    label: "Any" },
	{ key: "true",  label: "Unique" },
	{ key: "false", label: "Multiple" }
];

function readStartingPosStateFromHash() {
	var hash = location.hash || "";
	var qi = hash.indexOf("?");
	if (qi < 0) return;
	var params = new URLSearchParams(hash.slice(qi + 1));
	var size = parseInt(params.get("size"), 10);
	if (size >= 3 && size <= 9) startingPosListState.size = size;
	var sort = params.get("sort");
	if (sort === "asc" || sort === "desc") startingPosListState.sort = sort;
	var page = parseInt(params.get("page"), 10);
	startingPosListState.page = (page > 0) ? page : 0;
	var action = params.get("action");
	if (action === "reveal" || action === "flag" || action === "case") startingPosListState.action = action;
	else startingPosListState.action = null;
	var band = params.get("band");
	var validBand = RATING_BANDS.some(function(b) { return b.key === band; });
	startingPosListState.ratingBand = (validBand && band) ? band : null;
	var unique = params.get("unique");
	startingPosListState.unique = (unique === "true" || unique === "false") ? unique : null;
}

function writeStartingPosStateToHash() {
	var bits = [];
	if (startingPosListState.size !== 3) bits.push("size=" + startingPosListState.size);
	if (startingPosListState.sort !== "desc") bits.push("sort=" + startingPosListState.sort);
	if (startingPosListState.action) bits.push("action=" + startingPosListState.action);
	if (startingPosListState.ratingBand) bits.push("band=" + startingPosListState.ratingBand);
	if (startingPosListState.unique) bits.push("unique=" + startingPosListState.unique);
	if (startingPosListState.page) bits.push("page=" + startingPosListState.page);
	var qs = bits.length ? "?" + bits.join("&") : "";
	var newHash = "#/admin/starting-positions" + qs;
	if (location.hash !== newHash) history.replaceState(null, "", newHash);
}

function ratingBandRange(key) {
	if (!key) return { min: null, max: null };
	var parts = key.split("-");
	return { min: parseInt(parts[0], 10), max: parseInt(parts[1], 10) };
}

function renderStartingPositions() {
	var view = document.getElementById("starting_positions_view");
	if (!view) return;
	readStartingPosStateFromHash();
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Starting positions";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Enumerated cascade patterns where the analyzer can deduce at least one safe cell. The 3x3 cascade is the player view; the outer ring marks what the analyzer can deduce (flags = forced mines, dots = forced safe, dim = ambiguous). Symmetric duplicates are collapsed to the lex-smallest of each orbit. Rating is the complexity of the first analyzer move.";
	view.appendChild(sub);

	var toolbar = document.createElement("div");
	toolbar.className = "puzzles-toolbar";

	// Sort
	var sortWrap = document.createElement("div");
	sortWrap.className = "puzzles-sort-wrap";
	var sortLabel = document.createElement("span");
	sortLabel.className = "puzzles-filter-label";
	sortLabel.textContent = "Sort";
	sortWrap.appendChild(sortLabel);
	var sortSelect = document.createElement("select");
	sortSelect.className = "puzzles-sort-select";
	[
		{ value: "desc", label: "Hardest first" },
		{ value: "asc", label: "Easiest first" }
	].forEach(function(opt) {
		var o = document.createElement("option");
		o.value = opt.value;
		o.textContent = opt.label;
		if (opt.value === startingPosListState.sort) o.selected = true;
		sortSelect.appendChild(o);
	});
	sortSelect.addEventListener("change", function() {
		startingPosListState.sort = sortSelect.value;
		startingPosListState.page = 0;
		writeStartingPosStateToHash();
		refreshStartingPosList();
	});
	sortWrap.appendChild(sortSelect);
	toolbar.appendChild(sortWrap);

	// Rating band filter
	toolbar.appendChild(makeFilterRow("Rating", "band", RATING_BANDS, startingPosListState.ratingBand, function(key) {
		startingPosListState.ratingBand = key;
		startingPosListState.page = 0;
	}));

	// First action filter
	toolbar.appendChild(makeFilterRow("First action", "action", ACTION_OPTIONS, startingPosListState.action, function(key) {
		startingPosListState.action = key;
		startingPosListState.page = 0;
	}));

	// Solution-uniqueness filter
	toolbar.appendChild(makeFilterRow("Solutions", "unique", UNIQUE_OPTIONS, startingPosListState.unique, function(key) {
		startingPosListState.unique = key;
		startingPosListState.page = 0;
	}));

	view.appendChild(toolbar);

	var status = document.createElement("p");
	status.id = "starting_positions_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var grid = document.createElement("div");
	grid.id = "starting_positions_grid";
	grid.className = "starting-positions-grid";
	view.appendChild(grid);

	var pager = document.createElement("div");
	pager.id = "starting_positions_pager";
	pager.className = "puzzles-pager";
	view.appendChild(pager);

	refreshStartingPosList();
}

function makeFilterRow(label, dataKey, options, currentValue, onChange) {
	var row = document.createElement("div");
	row.className = "puzzles-filter";
	var lbl = document.createElement("span");
	lbl.className = "puzzles-filter-label";
	lbl.textContent = label;
	row.appendChild(lbl);
	options.forEach(function(opt) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset[dataKey] = opt.key == null ? "any" : opt.key;
		btn.textContent = opt.label;
		if (opt.key === currentValue) btn.classList.add("active");
		btn.addEventListener("click", function() {
			onChange(opt.key);
			writeStartingPosStateToHash();
			// Update active state on this row
			row.querySelectorAll(".puzzles-filter-chip").forEach(function(b) {
				var v = b.dataset[dataKey];
				var match = (v === "any" && opt.key == null) || (v === String(opt.key));
				b.classList.toggle("active", !!match);
			});
			refreshStartingPosList();
		});
		row.appendChild(btn);
	});
	return row;
}

function refreshStartingPosList() {
	var bits = [
		"size=" + startingPosListState.size,
		"page=" + startingPosListState.page,
		"pageSize=" + startingPosListState.pageSize,
		"sort=" + startingPosListState.sort
	];
	if (startingPosListState.action) bits.push("action=" + startingPosListState.action);
	if (startingPosListState.ratingBand) {
		var range = ratingBandRange(startingPosListState.ratingBand);
		if (range.min != null) bits.push("minRating=" + range.min);
		if (range.max != null) bits.push("maxRating=" + range.max);
	}
	if (startingPosListState.unique) bits.push("unique=" + startingPosListState.unique);
	var qs = bits.join("&");
	fetch("/api/starting-positions?" + qs).then(function(r) { return r.json(); }).then(function(data) {
		var positions = (data && data.positions) || [];
		var total = data && typeof data.total === "number" ? data.total : positions.length;
		var status = document.getElementById("starting_positions_status");
		if (status) {
			var fromN = total ? (startingPosListState.page * startingPosListState.pageSize + 1) : 0;
			var toN = Math.min(total, (startingPosListState.page + 1) * startingPosListState.pageSize);
			status.textContent = total + " match" + (total === 1 ? "" : "es") + (total ? " · showing " + fromN + "–" + toN : "");
		}
		var grid = document.getElementById("starting_positions_grid");
		if (!grid) return;
		grid.innerHTML = "";
		if (positions.length === 0) {
			var empty = document.createElement("p");
			empty.className = "puzzles-list-empty";
			empty.textContent = "No starting positions match.";
			grid.appendChild(empty);
		} else {
			positions.forEach(function(p) { grid.appendChild(renderStartingPosCard(p)); });
		}
		renderStartingPosPager(total);
	}).catch(function(e) {
		var status = document.getElementById("starting_positions_status");
		if (status) status.textContent = "Error: " + e.message;
	});
}

// Mapping: outer-ring cell index (0..15) ↔ 5x5 (row, col).
// Indices used by the brute-force masks:
//   0..4  → row 0, col 0..4
//   5..7  → col 0, rows 1..3
//   8..10 → col 4, rows 1..3
//   11..15 → row 4, col 0..4
function outsideIndex(r, c) {
	if (r === 0) return c;
	if (r === 4) return 11 + c;
	if (c === 0) return 5 + (r - 1);
	if (c === 4) return 8 + (r - 1);
	return -1;
}

function renderStartingPosCard(pos) {
	var card = document.createElement("div");
	card.className = "starting-pos-card";

	// Header: rating badge + first-action tag.
	var head = document.createElement("div");
	head.className = "starting-pos-head";
	var ratingBadge = document.createElement("span");
	ratingBadge.className = "starting-pos-rating sp-rating-tier-" + ratingTier(pos.rating);
	ratingBadge.textContent = pos.rating;
	head.appendChild(ratingBadge);
	var action = document.createElement("span");
	action.className = "starting-pos-action starting-pos-action-" + pos.first_action;
	action.textContent = pos.first_action;
	head.appendChild(action);
	card.appendChild(head);

	// 5x5 grid: inner 3x3 cascade + 16 outer cells.
	var grid = document.createElement("div");
	grid.className = "starting-pos-grid";
	var clues = pos.pattern.split(".").map(function(x) { return parseInt(x, 10); });
	var boundary = {
		"1,1": clues[0], "1,2": clues[1], "1,3": clues[2],
		"2,3": clues[3], "3,3": clues[4], "3,2": clues[5],
		"3,1": clues[6], "2,1": clues[7]
	};
	var safeMask = pos.forced_safe_mask || 0;
	var mineMask = pos.forced_mine_mask || 0;
	for (var r = 0; r < 5; r++) {
		for (var c = 0; c < 5; c++) {
			var cell = document.createElement("div");
			cell.className = "starting-pos-cell";
			if (r >= 1 && r <= 3 && c >= 1 && c <= 3) {
				// Inner 3x3 cascade
				if (r === 2 && c === 2) {
					cell.classList.add("sp-cell-clue", "sp-clue-0");
				} else {
					var v = boundary[r + "," + c];
					cell.classList.add("sp-cell-clue", "sp-clue-" + v);
					cell.textContent = String(v);
				}
			} else {
				// Outer ring — what the analyzer can deduce
				var idx = outsideIndex(r, c);
				var bit = (idx >= 0) ? (1 << idx) : 0;
				if (safeMask & bit) {
					cell.classList.add("sp-cell-safe");
				} else if (mineMask & bit) {
					cell.classList.add("sp-cell-mine");
					cell.textContent = "⚑";
				} else {
					cell.classList.add("sp-cell-covered");
				}
			}
			grid.appendChild(cell);
		}
	}
	card.appendChild(grid);

	// Footer: pattern, solution count, deducible counts.
	var details = document.createElement("div");
	details.className = "starting-pos-details";
	details.textContent = pos.solutions + " soln · " + pos.forced_safe + " safe · " + pos.forced_mine + " mine";
	card.appendChild(details);
	var patternRow = document.createElement("div");
	patternRow.className = "starting-pos-pattern";
	patternRow.textContent = pos.pattern;
	card.appendChild(patternRow);

	return card;
}

function ratingTier(rating) {
	if (rating >= 1800) return "case";
	if (rating >= 1500) return "intersect-hard";
	if (rating >= 1000) return "intersect";
	if (rating >= 200) return "subset";
	return "trivial";
}

function renderStartingPosPager(total) {
	var pager = document.getElementById("starting_positions_pager");
	if (!pager) return;
	pager.innerHTML = "";
	var pageSize = startingPosListState.pageSize;
	var page = startingPosListState.page;
	var totalPages = Math.max(1, Math.ceil(total / pageSize));
	if (totalPages <= 1) return;
	function addBtn(label, target, disabled) {
		var b = document.createElement("button");
		b.className = "puzzles-pager-btn" + (target === page ? " current" : "");
		b.textContent = label;
		b.disabled = !!disabled || target === page;
		b.addEventListener("click", function() {
			startingPosListState.page = Math.max(0, Math.min(totalPages - 1, target));
			writeStartingPosStateToHash();
			refreshStartingPosList();
		});
		pager.appendChild(b);
	}
	addBtn("← Prev", page - 1, page <= 0);
	var lo = Math.max(0, page - 3);
	var hi = Math.min(totalPages - 1, page + 3);
	for (var i = lo; i <= hi; i++) addBtn(String(i + 1), i);
	addBtn("Next →", page + 1, page >= totalPages - 1);
}
