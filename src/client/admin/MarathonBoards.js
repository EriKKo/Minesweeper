// Admin browse view for script-generated marathon/Nightmare boards (scripts/generate-marathon-boards.js
// -> puzzles table, source="marathon"). Unlike the All-Puzzles page these boards are too big for an
// inline board preview, so this is a plain sortable table of metadata (size, density, difficulty,
// generation provenance) with a Play button per row that opens a real interactive session in a modal —
// no thumbnails, no full-view takeover.

var marathonListState = {
	sort: "total_desc",   // one of MARATHON_SORT_OPTIONS' keys
	tier: null,            // null | 1..6
	page: 0,
	pageSize: 30
};

var MARATHON_SORT_OPTIONS = [
	{ key: "total_desc", label: "Hardest overall (total)", orderBy: "total_complexity", dir: "desc" },
	{ key: "total_asc", label: "Easiest overall (total)", orderBy: "total_complexity", dir: "asc" },
	{ key: "max_desc", label: "Hardest single move", orderBy: "max_complexity", dir: "desc" },
	{ key: "newest", label: "Newest first", orderBy: "created_at", dir: "desc" }
];

function readMarathonStateFromHash() {
	if (!location.search) return;
	var params = new URLSearchParams(location.search);
	var sort = params.get("sort");
	if (MARATHON_SORT_OPTIONS.some(function(o) { return o.key === sort; })) marathonListState.sort = sort;
	var tier = parseInt(params.get("tier"), 10);
	marathonListState.tier = (tier >= 1 && tier <= 6) ? tier : null;
	var page = parseInt(params.get("page"), 10);
	marathonListState.page = (page > 0) ? page : 0;
}

function writeMarathonStateToHash() {
	var bits = [];
	if (marathonListState.sort !== "total_desc") bits.push("sort=" + marathonListState.sort);
	if (marathonListState.tier) bits.push("tier=" + marathonListState.tier);
	if (marathonListState.page) bits.push("page=" + marathonListState.page);
	applyQueryString(bits);
}

function renderMarathonBoards() {
	var view = document.getElementById("marathon_boards_view");
	if (!view) return;
	readMarathonStateFromHash();
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Marathon boards";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Long, dense, fully no-guess-solvable boards from the hill-climb generator " +
		"(scripts/generate-marathon-boards.js) — lots of medium-difficulty moves rather than one rare " +
		"hard one. Sort by difficulty, click Play to try one.";
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
	MARATHON_SORT_OPTIONS.forEach(function(opt) {
		var o = document.createElement("option");
		o.value = opt.key;
		o.textContent = opt.label;
		if (opt.key === marathonListState.sort) o.selected = true;
		sortSelect.appendChild(o);
	});
	sortSelect.addEventListener("change", function() {
		marathonListState.sort = sortSelect.value;
		marathonListState.page = 0;
		writeMarathonStateToHash();
		refreshMarathonList();
	});
	sortWrap.appendChild(sortSelect);
	toolbar.appendChild(sortWrap);

	var tierRow = document.createElement("div");
	tierRow.className = "puzzles-filter";
	var tierLabel = document.createElement("span");
	tierLabel.className = "puzzles-filter-label";
	tierLabel.textContent = "Tier";
	tierRow.appendChild(tierLabel);
	[null, 1, 2, 3, 4, 5, 6].forEach(function(t) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.textContent = t == null ? "Any" : "t" + t;
		if (t === marathonListState.tier) btn.classList.add("active");
		btn.addEventListener("click", function() {
			marathonListState.tier = t;
			marathonListState.page = 0;
			writeMarathonStateToHash();
			refreshMarathonList();
		});
		tierRow.appendChild(btn);
	});
	toolbar.appendChild(tierRow);
	view.appendChild(toolbar);

	var status = document.createElement("p");
	status.id = "marathon_boards_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var tableWrap = document.createElement("div");
	tableWrap.className = "marathon-table-wrap";
	var header = document.createElement("div");
	header.className = "marathon-row marathon-row-head";
	["Size", "Mines", "Max diff", "Total diff", "Tier", "Method", "Passes", "Created", ""].forEach(function(label) {
		var cell = document.createElement("div");
		cell.textContent = label;
		header.appendChild(cell);
	});
	tableWrap.appendChild(header);
	var list = document.createElement("div");
	list.id = "marathon_boards_list";
	tableWrap.appendChild(list);
	view.appendChild(tableWrap);

	var pager = document.createElement("div");
	pager.id = "marathon_boards_pager";
	pager.className = "puzzles-pager";
	view.appendChild(pager);

	refreshMarathonList();
}

function refreshMarathonList() {
	var opt = MARATHON_SORT_OPTIONS.filter(function(o) { return o.key === marathonListState.sort; })[0] || MARATHON_SORT_OPTIONS[0];
	var bits = [
		"source=marathon",
		"orderBy=" + opt.orderBy,
		"sort=" + opt.dir,
		"page=" + marathonListState.page,
		"pageSize=" + marathonListState.pageSize
	];
	if (marathonListState.tier) bits.push("diff=" + marathonListState.tier);
	fetch("/api/puzzles?" + bits.join("&")).then(function(r) { return r.json(); }).then(function(data) {
		var boards = data.puzzles || [];
		var total = typeof data.total === "number" ? data.total : boards.length;
		var status = document.getElementById("marathon_boards_status");
		if (status) {
			var fromN = total ? (marathonListState.page * marathonListState.pageSize + 1) : 0;
			var toN = Math.min(total, (marathonListState.page + 1) * marathonListState.pageSize);
			status.textContent = total + " board" + (total === 1 ? "" : "s") + (total ? " · showing " + fromN + "–" + toN : "");
		}
		var list = document.getElementById("marathon_boards_list");
		if (!list) return;
		list.innerHTML = "";
		if (boards.length === 0) {
			var empty = document.createElement("p");
			empty.className = "puzzles-list-empty";
			empty.textContent = "No marathon boards yet — run scripts/generate-marathon-boards.js.";
			list.appendChild(empty);
		} else {
			boards.forEach(function(p) { list.appendChild(renderMarathonRow(p)); });
		}
		renderPager("marathon_boards_pager", total, marathonListState.page, marathonListState.pageSize, function(pg) {
			marathonListState.page = pg;
			writeMarathonStateToHash();
			refreshMarathonList();
		});
	}).catch(function(e) {
		var status = document.getElementById("marathon_boards_status");
		if (status) status.textContent = "Error: " + e.message;
	});
}

function relativeTime(ts) {
	if (!ts) return "—";
	var dt = Date.now() - ts;
	var mins = Math.floor(dt / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return mins + "m ago";
	var hours = Math.floor(mins / 60);
	if (hours < 24) return hours + "h ago";
	var days = Math.floor(hours / 24);
	return days + "d ago";
}

function renderMarathonRow(p) {
	var row = document.createElement("div");
	row.className = "marathon-row puzzle-diff-" + p.difficulty;

	var size = document.createElement("div");
	size.textContent = p.rows + "×" + p.cols;
	row.appendChild(size);

	var density = Math.round((p.mines.length / (p.rows * p.cols)) * 100);
	var mines = document.createElement("div");
	mines.textContent = p.mines.length + " · " + density + "%";
	row.appendChild(mines);

	var maxC = document.createElement("div");
	maxC.textContent = p.maxComplexity != null ? (+p.maxComplexity).toFixed(1) : "—";
	row.appendChild(maxC);

	var totalC = document.createElement("div");
	totalC.textContent = p.totalComplexity != null ? (+p.totalComplexity).toFixed(1) : "—";
	row.appendChild(totalC);

	var tier = document.createElement("div");
	var tierBadge = document.createElement("span");
	tierBadge.className = "puzzle-diff-badge";
	tierBadge.textContent = "t" + p.difficulty;
	tier.appendChild(tierBadge);
	row.appendChild(tier);

	var method = document.createElement("div");
	method.textContent = p.genMethod || "—";
	row.appendChild(method);

	var passes = document.createElement("div");
	passes.textContent = p.genIterations != null ? p.genIterations : "—";
	row.appendChild(passes);

	var created = document.createElement("div");
	created.textContent = relativeTime(p.createdAt || p.created_at);
	row.appendChild(created);

	var playCell = document.createElement("div");
	var playBtn = document.createElement("button");
	playBtn.className = "puzzle-card-analyze";
	playBtn.textContent = "Play";
	playBtn.addEventListener("click", function() { openMarathonPlayModal(p); });
	playCell.appendChild(playBtn);
	row.appendChild(playCell);

	return row;
}

// Play modal: wraps the same fully-interactive, real-rules board widget the All-Puzzles page already
// embeds inline (buildLearnPuzzle, Learn.js) in the app's standard .cr-modal chrome, instead of the
// bespoke Analyze-modal layout — no solver trace needed here, just a way to try the board for real.
// buildLearnPuzzle already renders its own status line and Reset button (Learn.js resetBtn/setStatus),
// so the modal doesn't need to duplicate either.
function openMarathonPlayModal(p) {
	var modal = document.getElementById("marathon_play_modal");
	if (!modal) {
		modal = document.createElement("div");
		modal.id = "marathon_play_modal";
		modal.className = "cr-modal";
		modal.setAttribute("hidden", "");
		modal.innerHTML =
			'<div class="cr-backdrop" data-marathon-close></div>' +
			'<div class="cr-dialog cr-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="marathon_play_title">' +
				'<div class="cr-dialog-head"><h2 id="marathon_play_title">Marathon board</h2>' +
				'<button class="cr-close" type="button" data-marathon-close aria-label="Close">×</button></div>' +
				'<div id="marathon_play_board"></div>' +
			'</div>';
		document.body.appendChild(modal);
		modal.addEventListener("click", function(e) { if (e.target.closest("[data-marathon-close]")) modal.setAttribute("hidden", ""); });
		document.addEventListener("keydown", function(e) { if (e.key === "Escape" && !modal.hasAttribute("hidden")) modal.setAttribute("hidden", ""); });
	}
	var title = modal.querySelector("#marathon_play_title");
	if (title) title.textContent = "Marathon board #" + p.id + " — " + p.rows + "×" + p.cols;
	var boardWrap = modal.querySelector("#marathon_play_board");
	boardWrap.innerHTML = "";

	var pseudoPuzzle = { title: "", rows: p.rows, cols: p.cols, mines: p.mines, revealed: p.revealed };
	boardWrap.appendChild(buildLearnPuzzle(pseudoPuzzle, false, function() {}, function() {}));

	modal.removeAttribute("hidden");
}
