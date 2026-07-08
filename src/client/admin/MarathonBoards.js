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

	var titleRow = document.createElement("div");
	titleRow.className = "marathon-title-row";
	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Marathon boards";
	titleRow.appendChild(title);
	var genBtn = document.createElement("button");
	genBtn.className = "btn btn-primary";
	genBtn.type = "button";
	genBtn.textContent = "Generate board";
	genBtn.addEventListener("click", openMarathonGenModal);
	titleRow.appendChild(genBtn);
	view.appendChild(titleRow);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Long, dense, fully no-guess-solvable boards from the hill-climb generator " +
		"(scripts/generate-marathon-boards.js) — lots of medium-difficulty moves rather than one rare " +
		"hard one. Sort by difficulty, click Play to try one.";
	view.appendChild(sub);

	var statusBar = document.createElement("div");
	statusBar.id = "marathon_gen_status_bar";
	statusBar.className = "marathon-gen-bar";
	statusBar.style.display = "none";
	view.appendChild(statusBar);

	wireMarathonGenSocket();
	socket.emit("marathon_gen_status");

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
	["Size", "Mines", "Max diff", "Total diff", "Tier", "Method", "Passes", "Best", "Created", ""].forEach(function(label) {
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
	// The session token lets the server attach the signed-in admin's own best (marathon_best) to each
	// row — same "read-only, no admin-gate" header pattern PuzzleLab.js uses for its own requests.
	var headers = {};
	try { var t = localStorage.getItem("ms_session"); if (t) headers["X-Session-Token"] = t; } catch (e) {}
	fetch("/api/puzzles?" + bits.join("&"), { headers: headers }).then(function(r) { return r.json(); }).then(function(data) {
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
	method.className = "marathon-cell-method";
	// Every method currently generated is "hillclimb:…" — that prefix is redundant on a page that
	// only ever shows hillclimb-generated boards, and dropping it buys the real distinguishing part
	// (e.g. "weighted:2-6") enough room to fit. Full string still available via the tooltip, and the
	// column itself ellipsizes as a safety net for any longer method name added later.
	var methodText = (p.genMethod || "—").replace(/^hillclimb:/, "");
	method.textContent = methodText;
	method.title = p.genMethod || "";
	row.appendChild(method);

	var passes = document.createElement("div");
	passes.textContent = p.genIterations != null ? p.genIterations : "—";
	row.appendChild(passes);

	var best = document.createElement("div");
	best.className = "marathon-cell-best";
	if (p.bestStars != null) {
		best.appendChild(buildStarGlyphs(p.bestStars, "marathon-star-mini"));
		if (p.attempts) best.title = p.attempts + " attempt" + (p.attempts === 1 ? "" : "s");
	} else {
		best.textContent = "—";
	}
	row.appendChild(best);

	var created = document.createElement("div");
	created.textContent = relativeTime(p.createdAt || p.created_at);
	row.appendChild(created);

	var playCell = document.createElement("div");
	var playBtn = document.createElement("button");
	playBtn.className = "puzzle-card-analyze";
	playBtn.textContent = "Play";
	playBtn.addEventListener("click", function() { playMarathonBoard(p); });
	playCell.appendChild(playBtn);
	row.appendChild(playCell);

	return row;
}

// Play through the real game engine — the same puzzle_retry path "Try again" already uses
// (Main.js's puzzle_retry_btn handler) — rather than a lightweight local preview widget. Marathon
// boards are already rows in the same puzzles table curriculum puzzles live in, so the server needs
// no special handling: it's just db.getPuzzleById(p.id) + startPuzzlePlay with noRating set
// (src/server/runtime/puzzlePlay.js). This gets every real-game feature (keyboard focus cursor,
// chording, fullscreen, …) for free instead of reimplementing any of it — there's nothing different
// about playing a marathon board vs. any other puzzle. Takes over the whole screen like any other
// "commit to a game" action; leaving it returns home (exitPuzzle's normal behavior), same as it does
// for every other puzzle.
function playMarathonBoard(p) {
	if (typeof autoEnterGameFullscreen === "function") autoEnterGameFullscreen();
	socket.emit("puzzle_retry", { puzzleId: p.id });
}

// --- Generate-from-the-UI (marathonGen.js on the server spawns the script as a subprocess so its
// heavy CSP re-solving never blocks the live game server; this streams its progress back). ---

var marathonGenJob = null;       // last snapshot received from the server (see marathonGen.js's `snapshot()`)
var marathonGenWired = false;    // registers the socket listener once, even across repeated page visits
var marathonGenTicker = null;    // ticks the elapsed-time display while a job is running
var marathonGenDismissedId = null; // id of a finished job the admin closed the bar for

function wireMarathonGenSocket() {
	if (marathonGenWired) return;
	marathonGenWired = true;
	socket.on("marathon_gen_update", function(data) {
		marathonGenJob = data;
		if (data.status === "running" || data.status === "stopping") marathonGenDismissedId = null;
		renderMarathonGenStatusBar();
		renderMarathonGenModalBody();
		if (data.status === "done") refreshMarathonList();
	});
}

function formatElapsed(ms) {
	var s = Math.floor(ms / 1000);
	var m = Math.floor(s / 60);
	s = s % 60;
	return m + ":" + (s < 10 ? "0" : "") + s;
}

function ensureMarathonGenTicker() {
	if (marathonGenTicker) return;
	marathonGenTicker = setInterval(function() {
		var bar = document.getElementById("marathon_gen_status_bar");
		if (!bar) { clearInterval(marathonGenTicker); marathonGenTicker = null; return; }
		if (!marathonGenJob || marathonGenJob.status !== "running") return;
		var el = document.getElementById("marathon_gen_elapsed");
		if (el) el.textContent = formatElapsed(Date.now() - marathonGenJob.startedAt);
	}, 500);
}

function marathonGenStatusLabel(status) {
	return status === "running" ? "Generating…" : status === "stopping" ? "Stopping…"
		: status === "done" ? "Done" : status === "stopped" ? "Stopped" : status === "error" ? "Error" : status;
}

// The status bar is the "I would like to see it while it's running" surface — always visible on
// this page (not just inside the modal) while a job is active, and left up briefly after it finishes
// so the outcome is visible without having to have kept the modal open.
function renderMarathonGenStatusBar() {
	var bar = document.getElementById("marathon_gen_status_bar");
	if (!bar) return;
	var job = marathonGenJob;
	if (!job || job.status === "idle" || job.id === marathonGenDismissedId) { bar.style.display = "none"; return; }
	bar.style.display = "";
	bar.innerHTML = "";
	bar.className = "marathon-gen-bar marathon-gen-bar-" + job.status;

	var head = document.createElement("div");
	head.className = "marathon-gen-bar-head";
	var badge = document.createElement("span");
	badge.className = "marathon-gen-badge";
	badge.textContent = marathonGenStatusLabel(job.status);
	head.appendChild(badge);

	var summary = document.createElement("span");
	summary.className = "marathon-gen-summary";
	var p = job.params || {};
	summary.textContent = p.rows + "×" + p.cols + " @ " + Math.round(p.density * 100) + "% · target " +
		p.target + " · " + p.strategy;
	head.appendChild(summary);

	if (job.status === "running") {
		var elapsed = document.createElement("span");
		elapsed.id = "marathon_gen_elapsed";
		elapsed.className = "marathon-gen-elapsed";
		elapsed.textContent = formatElapsed(Date.now() - job.startedAt);
		head.appendChild(elapsed);
		ensureMarathonGenTicker();
	}
	bar.appendChild(head);

	var latest = job.latest || {};
	if (latest.totalC != null) {
		var stats = document.createElement("div");
		stats.className = "marathon-gen-stats";
		stats.textContent = "iter " + (latest.iter || 0) + " · totalC=" + latest.totalC.toFixed(1) +
			" · maxC=" + latest.maxC.toFixed(2) +
			(latest.accepted != null ? " · " + latest.accepted + " accepted" : "");
		bar.appendChild(stats);
	} else if (job.status !== "running" && job.log && job.log.length) {
		// Nothing ever parsed (e.g. it never found a solvable initial board within the density/size
		// given) — surface the generator's own last line instead of leaving the bar blank.
		var note = document.createElement("div");
		note.className = "marathon-gen-stats";
		note.textContent = job.log[job.log.length - 1];
		bar.appendChild(note);
	}

	if (job.status === "error" && job.error) {
		var errEl = document.createElement("div");
		errEl.className = "marathon-gen-error";
		errEl.textContent = job.error;
		bar.appendChild(errEl);
	}

	var actions = document.createElement("div");
	actions.className = "marathon-gen-bar-actions";
	if (job.status === "running") {
		var stopBtn = document.createElement("button");
		stopBtn.className = "btn btn-ghost";
		stopBtn.type = "button";
		stopBtn.textContent = "Stop";
		stopBtn.addEventListener("click", function() { socket.emit("marathon_gen_stop"); });
		actions.appendChild(stopBtn);
	} else {
		var dismissBtn = document.createElement("button");
		dismissBtn.className = "btn btn-ghost";
		dismissBtn.type = "button";
		dismissBtn.textContent = "Dismiss";
		dismissBtn.addEventListener("click", function() {
			marathonGenDismissedId = job.id;
			renderMarathonGenStatusBar();
		});
		actions.appendChild(dismissBtn);
	}
	bar.appendChild(actions);

	if (job.log && job.log.length) {
		var details = document.createElement("details");
		details.className = "marathon-gen-log-details";
		var summaryEl = document.createElement("summary");
		summaryEl.textContent = "Log";
		details.appendChild(summaryEl);
		var log = document.createElement("pre");
		log.className = "marathon-gen-log";
		log.textContent = job.log.join("\n");
		details.appendChild(log);
		bar.appendChild(details);
	}
}

// --- Generate modal: pick params, start the job, then hand off to the status bar above. ---

function marathonGenModal() {
	var modal = document.getElementById("marathon_gen_modal");
	if (modal) return modal;
	modal = document.createElement("div");
	modal.id = "marathon_gen_modal";
	modal.className = "cr-modal";
	modal.setAttribute("hidden", "");
	modal.innerHTML =
		'<div class="cr-backdrop" data-mg-close></div>' +
		'<div class="cr-dialog" role="dialog" aria-modal="true" aria-labelledby="mg_title">' +
			'<div class="cr-dialog-head"><h2 id="mg_title">Generate marathon board</h2>' +
			'<button class="cr-close" type="button" data-mg-close aria-label="Close">×</button></div>' +
			'<p class="cr-dialog-sub">Runs the hill-climb generator in the background — it’s safe to close ' +
			'this and keep browsing, the status bar on the page tracks it.</p>' +
			'<div id="marathon_gen_modal_body"></div>' +
		'</div>';
	document.body.appendChild(modal);
	modal.addEventListener("click", function(e) { if (e.target.closest("[data-mg-close]")) modal.setAttribute("hidden", ""); });
	document.addEventListener("keydown", function(e) { if (e.key === "Escape" && !modal.hasAttribute("hidden")) modal.setAttribute("hidden", ""); });
	return modal;
}

// True renders the config form; false (while a job exists) renders progress/result instead. Reset
// to true whenever the modal is freshly opened with nothing running, or the admin picks "Generate
// another" off a finished result — otherwise a finished job's result view stays up so a
// still-open modal doesn't silently blank back to the form the moment the job completes.
var marathonGenShowForm = true;

function openMarathonGenModal() {
	var modal = marathonGenModal();
	var job = marathonGenJob;
	if (!(job && (job.status === "running" || job.status === "stopping"))) marathonGenShowForm = true;
	renderMarathonGenModalBody();
	modal.removeAttribute("hidden");
}

// Dispatches on the current job status: the config form, a live progress view (running/stopping),
// or a finished result view (done/error/stopped) — reused by both the socket update handler and
// opening the modal, so the two stay in sync automatically.
function renderMarathonGenModalBody() {
	var body = document.getElementById("marathon_gen_modal_body");
	if (!body) return;
	var job = marathonGenJob;
	if (job && (job.status === "running" || job.status === "stopping")) {
		marathonGenShowForm = false;
		renderMarathonGenProgressView(job, false);
	} else if (job && !marathonGenShowForm && (job.status === "done" || job.status === "error" || job.status === "stopped")) {
		renderMarathonGenProgressView(job, true);
	} else {
		renderMarathonGenFormView();
	}
}

function renderMarathonGenFormView() {
	var body = document.getElementById("marathon_gen_modal_body");
	if (!body) return;
	body.innerHTML =
		'<div class="cr-fields">' +
			'<div class="cr-field"><span class="cr-field-label">Rows</span>' +
				'<input type="number" id="mg_rows" min="8" max="40" value="24"></div>' +
			'<div class="cr-field"><span class="cr-field-label">Cols</span>' +
				'<input type="number" id="mg_cols" min="8" max="60" value="30"></div>' +
			'<div class="cr-field"><span class="cr-field-label">Mine density (%)</span>' +
				'<input type="number" id="mg_density" min="5" max="35" value="20"></div>' +
			'<div class="cr-field">' +
				'<span class="cr-field-label">Target total difficulty</span>' +
				'<input type="number" id="mg_target" min="1" max="100000" value="300">' +
				'<label class="marathon-gen-checkbox"><input type="checkbox" id="mg_maximize"> Maximize instead (ignore target)</label>' +
			'</div>' +
			'<div class="cr-field"><span class="cr-field-label">Time limit (seconds)</span>' +
				'<input type="number" id="mg_time" min="5" max="900" value="90"></div>' +
			'<div class="cr-field"><span class="cr-field-label">Region strategy</span>' +
				'<select id="mg_strategy">' +
					'<option value="weighted" selected>Weighted (recommended)</option>' +
					'<option value="grid">Grid</option>' +
				'</select>' +
			'</div>' +
			'<details class="marathon-gen-advanced"><summary>Advanced</summary>' +
				'<div class="cr-field"><span class="cr-field-label">Max single-move complexity</span>' +
					'<input type="number" id="mg_maxcomplexity" min="1" max="9.9" step="0.1" value="7"></div>' +
			'</details>' +
		'</div>' +
		'<div class="cr-dialog-actions">' +
			'<button class="btn btn-ghost" type="button" data-mg-close>Cancel</button>' +
			'<button id="mg_start" class="btn btn-primary" type="button">Start generation</button>' +
		'</div>';
	var maximizeBox = document.getElementById("mg_maximize");
	var targetInput = document.getElementById("mg_target");
	maximizeBox.addEventListener("change", function() { targetInput.disabled = maximizeBox.checked; });
	document.getElementById("mg_start").addEventListener("click", submitMarathonGen);
}

function numField(id, dflt) {
	var el = document.getElementById(id);
	var v = el ? parseFloat(el.value) : NaN;
	return Number.isFinite(v) ? v : dflt;
}

function submitMarathonGen() {
	var maximize = document.getElementById("mg_maximize").checked;
	var params = {
		rows: numField("mg_rows", 24),
		cols: numField("mg_cols", 30),
		density: numField("mg_density", 20) / 100,
		target: maximize ? 100000 : numField("mg_target", 300),
		timeBudgetSec: numField("mg_time", 90),
		strategy: document.getElementById("mg_strategy").value,
		maxComplexity: numField("mg_maxcomplexity", 7)
	};
	marathonGenShowForm = false;
	socket.emit("marathon_gen_start", params);
	// The server's ack (marathon_gen_update) arrives within a tick and re-renders via the dispatcher;
	// this just avoids a blank instant where the stale form (or nothing) shows before it lands.
	renderMarathonGenModalBody();
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, function(c) {
		return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
	});
}

// Live progress (running/stopping) or a frozen final result (done/error/stopped) — same content
// shape as the status bar's numbers, reused inside the modal so watching from there works too.
function renderMarathonGenProgressView(job, finished) {
	var body = document.getElementById("marathon_gen_modal_body");
	if (!body) return;
	var latest = job.latest || {};
	var statsLine = latest.totalC != null
		? ("iter " + (latest.iter || 0) + " · totalC=" + latest.totalC.toFixed(1) + " · maxC=" + latest.maxC.toFixed(2) +
			(finished && latest.puzzleId != null ? " · saved as puzzle id " + latest.puzzleId : ""))
		: (finished && job.log && job.log.length ? job.log[job.log.length - 1] : "Searching for an initial solvable board…");
	body.innerHTML = '<div class="marathon-gen-modal-progress">' +
		'<div class="marathon-gen-badge">' + escapeHtml(marathonGenStatusLabel(job.status)) + '</div>' +
		'<div class="marathon-gen-stats">' + escapeHtml(statsLine) + '</div>' +
		(finished && job.status === "error" && job.error ? '<div class="marathon-gen-error">' + escapeHtml(job.error) + '</div>' : "") +
		'<pre class="marathon-gen-log">' + escapeHtml((job.log || []).join("\n")) + '</pre>' +
	'</div>' +
	'<div class="cr-dialog-actions">' +
		'<button class="btn btn-ghost" type="button" data-mg-close>Close</button>' +
		(finished
			? '<button id="mg_again" class="btn btn-primary" type="button">Generate another</button>'
			: '<button id="mg_stop" class="btn btn-primary" type="button">Stop</button>') +
	'</div>';
	var stopBtn = document.getElementById("mg_stop");
	if (stopBtn) stopBtn.addEventListener("click", function() { socket.emit("marathon_gen_stop"); });
	var againBtn = document.getElementById("mg_again");
	if (againBtn) againBtn.addEventListener("click", function() { marathonGenShowForm = true; renderMarathonGenModalBody(); });
	// Auto-scroll the log to the newest line.
	var log = body.querySelector(".marathon-gen-log");
	if (log) log.scrollTop = log.scrollHeight;
}
