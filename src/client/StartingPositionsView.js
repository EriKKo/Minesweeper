// Admin browse view for the enumerated starting-position catalogue.
//
// Renders each pattern as the actual 3x3 cascade so the clue values
// you see in the catalogue match what a player would see when the
// cascade opens. Filterable by cascade size and sortable by rating.

var startingPosListState = { size: 3, sort: "asc", page: 0, pageSize: 60 };

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
}

function writeStartingPosStateToHash() {
	var bits = [];
	if (startingPosListState.size !== 3) bits.push("size=" + startingPosListState.size);
	if (startingPosListState.sort !== "asc") bits.push("sort=" + startingPosListState.sort);
	if (startingPosListState.page) bits.push("page=" + startingPosListState.page);
	var qs = bits.length ? "?" + bits.join("&") : "";
	var newHash = "#/admin/starting-positions" + qs;
	if (location.hash !== newHash) history.replaceState(null, "", newHash);
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
	sub.textContent = "Enumerated cascade patterns where the analyzer can deduce at least one safe cell. The rating is the complexity of the first analyzer move. Symmetric variants are collapsed: every entry is the lex-smallest of its dihedral orbit.";
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
		{ value: "asc", label: "Easiest first" },
		{ value: "desc", label: "Hardest first" }
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

	var status = document.createElement("p");
	status.id = "starting_positions_status";
	status.className = "puzzle-lab-status";
	view.appendChild(toolbar);
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

function refreshStartingPosList() {
	var qs = "size=" + startingPosListState.size
		+ "&page=" + startingPosListState.page
		+ "&pageSize=" + startingPosListState.pageSize
		+ "&sort=" + startingPosListState.sort;
	fetch("/api/starting-positions?" + qs).then(function(r) { return r.json(); }).then(function(data) {
		var positions = (data && data.positions) || [];
		var total = data && typeof data.total === "number" ? data.total : positions.length;
		var status = document.getElementById("starting_positions_status");
		if (status) {
			var fromN = total ? (startingPosListState.page * startingPosListState.pageSize + 1) : 0;
			var toN = Math.min(total, (startingPosListState.page + 1) * startingPosListState.pageSize);
			status.textContent = "Total: " + total + " · showing " + fromN + "–" + toN;
		}
		var grid = document.getElementById("starting_positions_grid");
		if (!grid) return;
		grid.innerHTML = "";
		if (positions.length === 0) {
			var empty = document.createElement("p");
			empty.className = "puzzles-list-empty";
			empty.textContent = "No starting positions to show.";
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

function renderStartingPosCard(pos) {
	var card = document.createElement("div");
	card.className = "starting-pos-card";

	var grid = document.createElement("div");
	grid.className = "starting-pos-grid";
	// Pattern is "c1.e1.c2.e2.c3.e3.c4.e4" — values for boundary cells
	// clockwise from (1,1). Render as a 3x3 with center=0.
	var clues = pos.pattern.split(".").map(function(x) { return parseInt(x, 10); });
	var cells = [
		clues[0], clues[1], clues[2],
		clues[7], 0,         clues[3],
		clues[6], clues[5],  clues[4]
	];
	for (var i = 0; i < 9; i++) {
		var cell = document.createElement("div");
		cell.className = "starting-pos-cell starting-pos-clue-" + cells[i];
		cell.textContent = String(cells[i]);
		grid.appendChild(cell);
	}
	card.appendChild(grid);

	var meta = document.createElement("div");
	meta.className = "starting-pos-meta";

	var ratingBadge = document.createElement("span");
	ratingBadge.className = "starting-pos-rating";
	ratingBadge.textContent = pos.rating;
	meta.appendChild(ratingBadge);

	var action = document.createElement("span");
	action.className = "starting-pos-action starting-pos-action-" + pos.first_action;
	action.textContent = pos.first_action;
	meta.appendChild(action);

	var details = document.createElement("div");
	details.className = "starting-pos-details";
	details.textContent = pos.solutions + " soln · " + pos.forced_safe + " safe · " + pos.forced_mine + " mine";
	meta.appendChild(details);

	card.appendChild(meta);
	return card;
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
	// Show a window of page numbers around the current page.
	var lo = Math.max(0, page - 3);
	var hi = Math.min(totalPages - 1, page + 3);
	for (var i = lo; i <= hi; i++) addBtn(String(i + 1), i);
	addBtn("Next →", page + 1, page >= totalPages - 1);
}
