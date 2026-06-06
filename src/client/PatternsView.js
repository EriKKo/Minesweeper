// Admin browse view for the deduction-pattern catalogue. Each row in
// the patterns table is a unique "first deduction" template — the
// clue cells (with values) plus deduced cells (safe/mine) from some
// starting position's first analyzer move, canonicalized by
// translation and dihedral symmetry.
//
// Cards render the pattern on its tight bounding box using the same
// canvas renderer as the live board. Non-pattern cells inside the
// bounding box are left transparent so the cell layout reads at a
// glance.

var patternsListState = {
	sort: "desc",
	orderBy: "rating",
	page: 0,
	pageSize: 50,
	action: null
};

var PATTERN_ACTION_OPTIONS = [
	{ key: null,     label: "Any" },
	{ key: "reveal", label: "Reveal" },
	{ key: "flag",   label: "Flag" },
	{ key: "case",   label: "Case" }
];

var PATTERN_CELL_PX = 36;

function readPatternsStateFromHash() {
	var hash = location.hash || "";
	var qi = hash.indexOf("?");
	if (qi < 0) return;
	var params = new URLSearchParams(hash.slice(qi + 1));
	var sort = params.get("sort");
	if (sort === "asc" || sort === "desc") patternsListState.sort = sort;
	var orderBy = params.get("orderBy");
	if (orderBy === "occurrences" || orderBy === "rating") patternsListState.orderBy = orderBy;
	var page = parseInt(params.get("page"), 10);
	patternsListState.page = (page > 0) ? page : 0;
	var action = params.get("action");
	patternsListState.action = (action === "reveal" || action === "flag" || action === "case") ? action : null;
}

function writePatternsStateToHash() {
	var bits = [];
	if (patternsListState.sort !== "desc") bits.push("sort=" + patternsListState.sort);
	if (patternsListState.orderBy !== "rating") bits.push("orderBy=" + patternsListState.orderBy);
	if (patternsListState.action) bits.push("action=" + patternsListState.action);
	if (patternsListState.page) bits.push("page=" + patternsListState.page);
	var qs = bits.length ? "?" + bits.join("&") : "";
	var newHash = "#/admin/patterns" + qs;
	if (location.hash !== newHash) history.replaceState(null, "", newHash);
}

function renderPatterns() {
	var view = document.getElementById("patterns_view");
	if (!view) return;
	readPatternsStateFromHash();
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Deduction patterns";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "First-move templates extracted from every starting position. Each pattern shows the clue cells the analyzer needed plus the cells that first move deduced (flag = forced mine, checkmark = forced safe). Position, rotation, and reflection are collapsed — patterns that are rotations or mirrors of each other share one row.";
	view.appendChild(sub);

	var toolbar = document.createElement("div");
	toolbar.className = "puzzles-toolbar";

	var orderWrap = document.createElement("div");
	orderWrap.className = "puzzles-sort-wrap";
	var orderLabel = document.createElement("span");
	orderLabel.className = "puzzles-filter-label";
	orderLabel.textContent = "Order by";
	orderWrap.appendChild(orderLabel);
	var orderSelect = document.createElement("select");
	orderSelect.className = "puzzles-sort-select";
	[
		{ value: "rating-desc", label: "Hardest first" },
		{ value: "rating-asc", label: "Easiest first" },
		{ value: "occurrences-desc", label: "Most used first" },
		{ value: "occurrences-asc", label: "Least used first" }
	].forEach(function(opt) {
		var o = document.createElement("option");
		o.value = opt.value;
		o.textContent = opt.label;
		var current = patternsListState.orderBy + "-" + patternsListState.sort;
		if (opt.value === current) o.selected = true;
		orderSelect.appendChild(o);
	});
	orderSelect.addEventListener("change", function() {
		var parts = orderSelect.value.split("-");
		patternsListState.orderBy = parts[0];
		patternsListState.sort = parts[1];
		patternsListState.page = 0;
		writePatternsStateToHash();
		refreshPatternsList();
	});
	orderWrap.appendChild(orderSelect);
	toolbar.appendChild(orderWrap);

	var actionRow = document.createElement("div");
	actionRow.className = "puzzles-filter";
	var actionLbl = document.createElement("span");
	actionLbl.className = "puzzles-filter-label";
	actionLbl.textContent = "Action";
	actionRow.appendChild(actionLbl);
	PATTERN_ACTION_OPTIONS.forEach(function(opt) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset.actionKey = opt.key == null ? "any" : opt.key;
		btn.textContent = opt.label;
		if (opt.key === patternsListState.action) btn.classList.add("active");
		btn.addEventListener("click", function() {
			patternsListState.action = opt.key;
			patternsListState.page = 0;
			writePatternsStateToHash();
			actionRow.querySelectorAll(".puzzles-filter-chip").forEach(function(b) {
				var v = b.dataset.actionKey;
				var match = (v === "any" && opt.key == null) || (v === String(opt.key));
				b.classList.toggle("active", !!match);
			});
			refreshPatternsList();
		});
		actionRow.appendChild(btn);
	});
	toolbar.appendChild(actionRow);

	view.appendChild(toolbar);

	var status = document.createElement("p");
	status.id = "patterns_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var grid = document.createElement("div");
	grid.id = "patterns_grid";
	grid.className = "patterns-grid";
	view.appendChild(grid);

	var pager = document.createElement("div");
	pager.id = "patterns_pager";
	pager.className = "puzzles-pager";
	view.appendChild(pager);

	refreshPatternsList();
}

function refreshPatternsList() {
	var bits = [
		"page=" + patternsListState.page,
		"pageSize=" + patternsListState.pageSize,
		"sort=" + patternsListState.sort,
		"orderBy=" + patternsListState.orderBy
	];
	if (patternsListState.action) bits.push("action=" + patternsListState.action);
	fetch("/api/patterns?" + bits.join("&")).then(function(r) { return r.json(); }).then(function(data) {
		var patterns = (data && data.patterns) || [];
		var total = data && typeof data.total === "number" ? data.total : patterns.length;
		var status = document.getElementById("patterns_status");
		if (status) {
			var fromN = total ? (patternsListState.page * patternsListState.pageSize + 1) : 0;
			var toN = Math.min(total, (patternsListState.page + 1) * patternsListState.pageSize);
			status.textContent = total + " pattern" + (total === 1 ? "" : "s") + (total ? " · showing " + fromN + "–" + toN : "");
		}
		var grid = document.getElementById("patterns_grid");
		if (!grid) return;
		grid.innerHTML = "";
		if (patterns.length === 0) {
			var empty = document.createElement("p");
			empty.className = "puzzles-list-empty";
			empty.textContent = "No patterns to show.";
			grid.appendChild(empty);
		} else {
			patterns.forEach(function(p) { grid.appendChild(renderPatternCard(p)); });
		}
		renderPatternsPager(total);
	}).catch(function(e) {
		var status = document.getElementById("patterns_status");
		if (status) status.textContent = "Error: " + e.message;
	});
}

function renderPatternCard(pat) {
	var card = document.createElement("div");
	card.className = "pattern-card";

	var head = document.createElement("div");
	head.className = "pattern-card-head";
	var rating = document.createElement("span");
	rating.className = "pattern-card-rating sp-rating-tier-" + ratingTier(pat.rating);
	rating.textContent = pat.rating;
	head.appendChild(rating);
	var action = document.createElement("span");
	action.className = "starting-pos-action starting-pos-action-" + pat.action;
	action.textContent = pat.action;
	head.appendChild(action);
	card.appendChild(head);

	var canvas = buildPatternCanvas(pat.width, pat.height);
	card.appendChild(canvas);
	paintPatternCanvas(canvas, pat);

	var details = document.createElement("div");
	details.className = "pattern-card-details";
	details.textContent = pat.clue_count + " clues → " + pat.safe_count + " safe · " + pat.mine_count + " mine";
	card.appendChild(details);

	var uses = document.createElement("div");
	uses.className = "pattern-card-uses";
	uses.textContent = "used by " + pat.occurrence_count + " starting position" + (pat.occurrence_count === 1 ? "" : "s");
	card.appendChild(uses);

	return card;
}

function buildPatternCanvas(width, height) {
	var canvas = document.createElement("canvas");
	canvas.className = "pattern-card-canvas";
	var dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(width * PATTERN_CELL_PX * dpr);
	canvas.height = Math.round(height * PATTERN_CELL_PX * dpr);
	canvas.style.width = (width * PATTERN_CELL_PX) + "px";
	canvas.style.height = (height * PATTERN_CELL_PX) + "px";
	return canvas;
}

function paintPatternCanvas(canvas, pat) {
	var cells;
	try { cells = JSON.parse(pat.cells_json); } catch (e) { return; }
	var clueCells = cells.clues || [];      // [[r, c, value], ...]
	var deducedCells = cells.deduced || []; // [[r, c, "S"|"M"], ...]
	var R = pat.height, C = pat.width;
	var COVERED = 0, REVEALED = 1, FLAGGED_S = 2;

	// Construct a flag/clue lookup per cell. Cells not mentioned in the
	// pattern stay "absent" — we draw nothing there.
	var inPattern = [];
	var state = [];
	var isMine = [];
	var clueValue = [];
	var safeOverlay = [];
	for (var r = 0; r < R; r++) {
		inPattern.push(new Array(C).fill(false));
		state.push(new Array(C).fill(COVERED));
		isMine.push(new Array(C).fill(false));
		clueValue.push(new Array(C).fill(0));
		safeOverlay.push(new Array(C).fill(false));
	}
	clueCells.forEach(function(c) {
		state[c[0]][c[1]] = REVEALED;
		clueValue[c[0]][c[1]] = c[2];
		inPattern[c[0]][c[1]] = true;
	});
	deducedCells.forEach(function(c) {
		inPattern[c[0]][c[1]] = true;
		if (c[2] === "M") {
			state[c[0]][c[1]] = FLAGGED_S;
			isMine[c[0]][c[1]] = true;
		} else {
			// Stay COVERED, paint a checkmark on top after the cell draws.
			safeOverlay[c[0]][c[1]] = true;
		}
	});

	var view = {
		rows: R, cols: C,
		isCovered: function(r, c) { return state[r][c] === COVERED; },
		isRevealed: function(r, c) { return state[r][c] === REVEALED; },
		isFlagged: function(r, c) { return state[r][c] === FLAGGED_S; },
		isMine: function(r, c) { return isMine[r][c]; },
		getClue: function(r, c) { return clueValue[r][c]; },
		xray: false
	};

	var ctx = canvas.getContext("2d");
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	var sw = canvas.width / C, sh = canvas.height / R;
	for (var rr = 0; rr < R; rr++) {
		for (var cc = 0; cc < C; cc++) {
			if (!inPattern[rr][cc]) continue;
			drawCell(ctx, rr, cc, view, sw, sh, null);
		}
	}
	// Overlay green checkmarks on the safe-deduced cells.
	for (var r4 = 0; r4 < R; r4++) {
		for (var c4 = 0; c4 < C; c4++) {
			if (safeOverlay[r4][c4]) drawSafeMarker(ctx, c4 * sw, r4 * sh, sw, sh);
		}
	}
}

function renderPatternsPager(total) {
	var pager = document.getElementById("patterns_pager");
	if (!pager) return;
	pager.innerHTML = "";
	var pageSize = patternsListState.pageSize;
	var page = patternsListState.page;
	var totalPages = Math.max(1, Math.ceil(total / pageSize));
	if (totalPages <= 1) return;
	function addBtn(label, target, disabled) {
		var b = document.createElement("button");
		b.className = "puzzles-pager-btn" + (target === page ? " current" : "");
		b.textContent = label;
		b.disabled = !!disabled || target === page;
		b.addEventListener("click", function() {
			patternsListState.page = Math.max(0, Math.min(totalPages - 1, target));
			writePatternsStateToHash();
			refreshPatternsList();
		});
		pager.appendChild(b);
	}
	addBtn("← Prev", page - 1, page <= 0);
	var lo = Math.max(0, page - 3);
	var hi = Math.min(totalPages - 1, page + 3);
	for (var i = lo; i <= hi; i++) addBtn(String(i + 1), i);
	addBtn("Next →", page + 1, page >= totalPages - 1);
}
