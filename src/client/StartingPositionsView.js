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
	unique: null,          // null | "true" | "false"
	prime: null            // null | "true" | "false"
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
var PRIME_OPTIONS = [
	{ key: null,    label: "Any" },
	{ key: "true",  label: "Prime" },
	{ key: "false", label: "Reducible" }
];
// Which family of starting positions to browse. The plain enumerated cascades are size 3; the
// "corner-mine" family (a 4x4 opening with one corner a deduced mine) is stored as size 4, variant
// "corner4" — so the size selector doubles as the variant filter that keeps the two apart.
var FAMILY_OPTIONS = [
	{ key: 3, label: "3×3 cascade" },
	{ key: 4, label: "4×4 corner-mine" }
];

function readStartingPosStateFromHash() {
	if (!location.search) return;
	var params = new URLSearchParams(location.search);
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
	var prime = params.get("prime");
	startingPosListState.prime = (prime === "true" || prime === "false") ? prime : null;
}

function writeStartingPosStateToHash() {
	var bits = [];
	if (startingPosListState.size !== 3) bits.push("size=" + startingPosListState.size);
	if (startingPosListState.sort !== "desc") bits.push("sort=" + startingPosListState.sort);
	if (startingPosListState.action) bits.push("action=" + startingPosListState.action);
	if (startingPosListState.ratingBand) bits.push("band=" + startingPosListState.ratingBand);
	if (startingPosListState.unique) bits.push("unique=" + startingPosListState.unique);
	if (startingPosListState.prime) bits.push("prime=" + startingPosListState.prime);
	if (startingPosListState.page) bits.push("page=" + startingPosListState.page);
	var qs = bits.length ? "?" + bits.join("&") : "";
	if (location.search !== qs) history.replaceState(null, "", location.pathname + qs);
}

function startingPosSubtitle() {
	if (startingPosListState.size === 4) {
		return "The 4x4 corner-mine family: a 4x4 opening where one corner is a covered mine the solver must deduce (flagged here), so it floods like a real cascade. The revealed interior is the player view; the outer ring marks the analyzer's deductions (flags = forced mines, checks = forced safe). Ranked by full-solve difficulty — total = sum of every deduction's complexity, max = the hardest single one. A random sample across difficulty bands, always keeping the single hardest opening.";
	}
	return "Enumerated cascade patterns where the analyzer can deduce at least one safe cell. The 3x3 cascade is the player view; the outer ring marks what the analyzer can deduce (flags = forced mines, dots = forced safe, dim = ambiguous). Symmetric duplicates are collapsed to the lex-smallest of each orbit. Rating is the complexity of the first analyzer move.";
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
	sub.id = "starting_positions_sub";
	sub.textContent = startingPosSubtitle();
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

	// Family (size / variant) filter — switches between the 3x3 cascades and the 4x4 corner-mine set.
	toolbar.appendChild(makeFilterRow("Family", "family", FAMILY_OPTIONS, startingPosListState.size, function(key) {
		startingPosListState.size = key;
		startingPosListState.page = 0;
	}));

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

	// Primality filter
	toolbar.appendChild(makeFilterRow("Pattern", "prime", PRIME_OPTIONS, startingPosListState.prime, function(key) {
		startingPosListState.prime = key;
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
	if (startingPosListState.prime) bits.push("prime=" + startingPosListState.prime);
	var qs = bits.join("&");
	var subEl = document.getElementById("starting_positions_sub");
	if (subEl) subEl.textContent = startingPosSubtitle();
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

var STARTING_POS_CELL_PX = 28;

// Render a starting position with the standard board canvas renderer
// so the cells look the same as in a live game. Inner 3x3 cells get
// revealed-with-clue rendering, forced-mine outer cells render as
// flagged covered cells, and the rest stay covered blue. On top of
// the covered base we draw a small marker on forced-safe cells so
// the player can see what the analyzer has determined.
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

	// Board canvas — drawn with the shared board renderer. The corner-mine family is a 4x4 opening
	// (6x6 board) with one corner a deduced mine; everything else is a 3x3 cascade (5x5 board).
	var isCorner = pos.variant === "corner4";
	var canvas = buildStartingPosCanvas(pos.size || 3);
	card.appendChild(canvas);
	if (isCorner) paintCornerPosCanvas(canvas, pos);
	else paintStartingPosCanvas(canvas, pos);

	// For the corner-mine family we ranked by full-solve difficulty: show max + total complexity.
	if (pos.total_complexity != null) {
		var diff = document.createElement("div");
		diff.className = "starting-pos-details";
		diff.textContent = "max " + (+pos.max_complexity).toFixed(1) + " · total " + (+pos.total_complexity).toFixed(1) + " difficulty";
		card.appendChild(diff);
	}

	var details = document.createElement("div");
	details.className = "starting-pos-details";
	details.textContent = pos.solutions + " soln · " + pos.forced_safe + " safe · " + pos.forced_mine + " mine";
	card.appendChild(details);
	var patternRow = document.createElement("div");
	patternRow.className = "starting-pos-pattern";
	patternRow.textContent = pos.pattern;
	card.appendChild(patternRow);

	// Analyze (corner-mine family only): rebuild a concrete board and open the shared solver-trace
	// modal, so you can step the moves and see why the analyzer scores them (it case-splits the
	// underconstrained outer ring — those are the cx-8+ moves, not real opening difficulty).
	if (isCorner) {
		var analyzeBtn = document.createElement("button");
		analyzeBtn.className = "puzzle-card-analyze";
		analyzeBtn.textContent = "Analyze";
		analyzeBtn.addEventListener("click", function() { analyzeStartingPos(pos); });
		card.appendChild(analyzeBtn);
	}

	return card;
}

// Tier (t1–t6) from a max-complexity value, for the analyze modal's header chip.
function startingPosTier(mx) {
	if (mx >= 8) return 6;
	if (mx >= 6) return 5;
	if (mx >= 4) return 4;
	if (mx >= 2) return 3;
	if (mx >= 1) return 2;
	return 1;
}

// Open the shared Analyze modal for a corner-mine starting position. One fetch returns both the
// reconstructed board layout and the solver trace; we hand the layout to the modal as the puzzle and
// pass the same payload through as the prefetched trace so it isn't requested twice.
function analyzeStartingPos(pos) {
	fetch("/api/starting-positions/" + pos.id + "/analyze").then(function(r) { return r.json(); }).then(function(data) {
		if (!data || data.error) { console.error("analyze failed:", data && data.error); return; }
		var p = {
			id: pos.id,
			rows: data.rows, cols: data.cols, mines: data.mines, revealed: data.revealed,
			rating: pos.rating, difficulty: startingPosTier(pos.max_complexity),
			label: "corner-mine #" + pos.id
		};
		openAnalyzeModal(p, "/api/starting-positions", data);
	}).catch(function(e) { console.error(e); });
}

function buildStartingPosCanvas(size) {
	var N = (size || 3) + 2; // block size + the surrounding ring
	var canvas = document.createElement("canvas");
	canvas.className = "starting-pos-canvas";
	var dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(N * STARTING_POS_CELL_PX * dpr);
	canvas.height = Math.round(N * STARTING_POS_CELL_PX * dpr);
	canvas.style.width = (N * STARTING_POS_CELL_PX) + "px";
	canvas.style.height = (N * STARTING_POS_CELL_PX) + "px";
	return canvas;
}

function paintStartingPosCanvas(canvas, pos) {
	var clues = pos.pattern.split(".").map(function(x) { return parseInt(x, 10); });
	// Boundary clue lookup table for the inner 3x3 (clockwise from (1,1)).
	var boundary = {
		"1,1": clues[0], "1,2": clues[1], "1,3": clues[2],
		"2,3": clues[3], "3,3": clues[4], "3,2": clues[5],
		"3,1": clues[6], "2,1": clues[7]
	};
	var safeMask = pos.forced_safe_mask || 0;
	var mineMask = pos.forced_mine_mask || 0;

	// Build the per-cell grids the renderer's view interface expects.
	var R = 5, C = 5;
	var COVERED = 0, REVEALED = 1, FLAGGED_S = 2;
	var state = [], isMine = [], clueValue = [];
	for (var r = 0; r < R; r++) {
		state.push(new Array(C).fill(COVERED));
		isMine.push(new Array(C).fill(false));
		clueValue.push(new Array(C).fill(0));
	}
	// Inner 3x3 cascade: REVEALED with the right clue values.
	for (var rr = 1; rr <= 3; rr++) {
		for (var cc = 1; cc <= 3; cc++) {
			state[rr][cc] = REVEALED;
			if (rr === 2 && cc === 2) clueValue[rr][cc] = 0;
			else clueValue[rr][cc] = boundary[rr + "," + cc];
		}
	}
	// Outer ring: FLAGGED for cells the analyzer proves are mines,
	// COVERED for everything else (forced-safe markers go on top).
	for (var r2 = 0; r2 < R; r2++) {
		for (var c2 = 0; c2 < C; c2++) {
			if (r2 >= 1 && r2 <= 3 && c2 >= 1 && c2 <= 3) continue;
			var idx = outsideIndex(r2, c2);
			if (idx < 0) continue;
			var bit = 1 << idx;
			if (mineMask & bit) {
				state[r2][c2] = FLAGGED_S;
				isMine[r2][c2] = true;
			}
		}
	}

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
	var sw = canvas.width / C, sh = canvas.height / R;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	for (var r3 = 0; r3 < R; r3++) {
		for (var c3 = 0; c3 < C; c3++) drawCell(ctx, r3, c3, view, sw, sh, null);
	}

	// Overlay the "safe" marker on covered cells the analyzer can
	// prove are safe. A small green dot keeps it close to the
	// look of a flagged cell while staying clearly distinct.
	for (var r4 = 0; r4 < R; r4++) {
		for (var c4 = 0; c4 < C; c4++) {
			var idx2 = outsideIndex(r4, c4);
			if (idx2 < 0) continue;
			var bit2 = 1 << idx2;
			if (!(safeMask & bit2)) continue;
			if (state[r4][c4] !== COVERED) continue;
			drawSafeMarker(ctx, c4 * sw, r4 * sh, sw, sh);
		}
	}
}

// Ring-cell index for the 4x4 corner-mine family on a 6x6 board: row-major over every cell
// outside the inner 4x4 rectangle (rows/cols 1..4) — matching the generator's mask ordering.
//   row 0: 0..5 · rows 1..4: col 0 then col 5 (6,7 / 8,9 / 10,11 / 12,13) · row 5: 14..19
function cornerOutsideIndex(r, c) {
	if (r === 0) return c;
	if (r === 5) return 14 + c;
	if (c === 0) return 6 + (r - 1) * 2;
	if (c === 5) return 6 + (r - 1) * 2 + 1;
	return -1;
}

// Paint a 4x4 corner-mine opening on a 6x6 board. The pattern is 16 row-major tokens over the inner
// rectangle (rows/cols 1..4): token 0 is "M" — the corner mine, drawn as a flag because the solver
// deduces it — the rest are revealed clues. The outer ring uses the same forced-mine/safe masks.
function paintCornerPosCanvas(canvas, pos) {
	var tokens = pos.pattern.split(".");
	var safeMask = pos.forced_safe_mask || 0;
	var mineMask = pos.forced_mine_mask || 0;
	var N = 6;
	var COVERED = 0, REVEALED = 1, FLAGGED_S = 2;
	var state = [], isMine = [], clueValue = [];
	for (var i = 0; i < N; i++) {
		state.push(new Array(N).fill(COVERED));
		isMine.push(new Array(N).fill(false));
		clueValue.push(new Array(N).fill(0));
	}
	// Inner 4x4 rectangle: revealed clues, with the corner a flagged (deduced) mine.
	var k = 0;
	for (var rr = 1; rr <= 4; rr++) {
		for (var cc = 1; cc <= 4; cc++) {
			var tok = tokens[k++];
			if (tok === "M") { state[rr][cc] = FLAGGED_S; isMine[rr][cc] = true; }
			else { state[rr][cc] = REVEALED; clueValue[rr][cc] = parseInt(tok, 10) || 0; }
		}
	}
	// Outer ring: flag forced mines; everything else stays covered (safe markers drawn on top).
	for (var r2 = 0; r2 < N; r2++) {
		for (var c2 = 0; c2 < N; c2++) {
			var idx = cornerOutsideIndex(r2, c2);
			if (idx < 0) continue;
			if (mineMask & (1 << idx)) { state[r2][c2] = FLAGGED_S; isMine[r2][c2] = true; }
		}
	}

	var view = {
		rows: N, cols: N,
		isCovered: function(r, c) { return state[r][c] === COVERED; },
		isRevealed: function(r, c) { return state[r][c] === REVEALED; },
		isFlagged: function(r, c) { return state[r][c] === FLAGGED_S; },
		isMine: function(r, c) { return isMine[r][c]; },
		getClue: function(r, c) { return clueValue[r][c]; },
		xray: false
	};

	var ctx = canvas.getContext("2d");
	var sw = canvas.width / N, sh = canvas.height / N;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	for (var r3 = 0; r3 < N; r3++) {
		for (var c3 = 0; c3 < N; c3++) drawCell(ctx, r3, c3, view, sw, sh, null);
	}
	for (var r4 = 0; r4 < N; r4++) {
		for (var c4 = 0; c4 < N; c4++) {
			var idx2 = cornerOutsideIndex(r4, c4);
			if (idx2 < 0) continue;
			if (!(safeMask & (1 << idx2))) continue;
			if (state[r4][c4] !== COVERED) continue;
			drawSafeMarker(ctx, c4 * sw, r4 * sh, sw, sh);
		}
	}
}

function drawSafeMarker(ctx, x, y, sw, sh) {
	var cx = x + sw / 2, cy = y + sh / 2;
	var s = Math.min(sw, sh) * 0.28;
	ctx.save();
	ctx.strokeStyle = "#4ade80";
	ctx.lineWidth = Math.max(2, s * 0.35);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	ctx.moveTo(cx - s, cy + s * 0.05);
	ctx.lineTo(cx - s * 0.25, cy + s * 0.65);
	ctx.lineTo(cx + s, cy - s * 0.55);
	ctx.stroke();
	ctx.restore();
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
