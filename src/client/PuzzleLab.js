// Puzzle Lab — internal experimentation page.
//
// The server keeps an in-memory pool of generated puzzles. The lab shows
// what's currently in the pool (optionally filtered by difficulty tier) and
// lets us trigger a server-side generation *job* that fills the pool in the
// background. Polling refreshes job progress + pool contents while a job
// runs, then stops once the server reports the job is done.

var puzzleLabState = { count: 50, diff: null, density: null };
var puzzleLabPollTimer = null;

// Admin generate / clear requests carry the session token; the server
// resolves it to a user and checks the `is_admin` column. No separate
// admin secret to manage.
function puzzleAdminHeaders() {
	try {
		var t = localStorage.getItem("ms_session");
		return t ? { "X-Session-Token": t } : {};
	} catch (e) { return {}; }
}

// Admin tab is visible when the signed-in user is flagged is_admin
// (or in dev for convenience). Called from applyConnected (dev flag)
// and applyAuthenticated (account.isAdmin).
function refreshAdminNavLink() {
	var link = document.getElementById("admin_nav_link");
	if (!link) return;
	var dev = window.serverInfo && window.serverInfo.dev;
	var admin = (typeof account !== "undefined" && account && account.isAdmin);
	link.style.display = (dev || admin) ? "" : "none";
}

function noteServerDev(devFlag) {
	window.serverInfo = window.serverInfo || {};
	window.serverInfo.dev = !!devFlag;
	refreshAdminNavLink();
}

function renderAdminLanding() {
	var view = document.getElementById("admin_view");
	if (!view) return;
	view.innerHTML = "";
	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Admin";
	view.appendChild(title);
	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Puzzle pool tools. Generation requires DEV_AUTH locally or a PUZZLE_ADMIN_TOKEN on the server (set via ?token=… on the URL).";
	view.appendChild(sub);

	var cards = document.createElement("div");
	cards.className = "admin-cards";

	cards.appendChild(makeAdminCard(
		"Puzzle Lab",
		"Generate new puzzles, tune density and difficulty, inspect tier distribution.",
		"Open Lab",
		"#/admin/lab"
	));
	cards.appendChild(makeAdminCard(
		"All puzzles",
		"Browse the entire pool. Sort by rating, filter by tier.",
		"Browse pool",
		"#/admin/puzzles"
	));
	view.appendChild(cards);
}

function makeAdminCard(title, desc, label, href) {
	var card = document.createElement("a");
	card.className = "admin-card";
	card.href = href;
	var h = document.createElement("h2");
	h.className = "admin-card-title";
	h.textContent = title;
	card.appendChild(h);
	var p = document.createElement("p");
	p.className = "admin-card-sub";
	p.textContent = desc;
	card.appendChild(p);
	var s = document.createElement("span");
	s.className = "admin-card-action";
	s.textContent = label + " →";
	card.appendChild(s);
	return card;
}

var DENSITY_OPTIONS = [
	{ label: "Mix", value: null },
	{ label: "10%", value: 0.10 },
	{ label: "15%", value: 0.15 },
	{ label: "20%", value: 0.20 },
	{ label: "25%", value: 0.25 },
	{ label: "30%", value: 0.30 },
	{ label: "35%", value: 0.35 },
	{ label: "40%", value: 0.40 },
	{ label: "45%", value: 0.45 }
];

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
	sub.textContent = "Server-side puzzle pool, persisted in SQLite. Each puzzle has a chess-style rating calibrated from the solver score (rating ≈ 400 + 350·score^0.6). Badge shows rating + tier; meta line shows board size, density, raw score, and solver pass counts.";
	view.appendChild(sub);

	var browseLink = document.createElement("p");
	browseLink.className = "puzzles-list-footer";
	browseLink.innerHTML = '<a href="#/admin/puzzles">Browse all puzzles →</a>';
	view.appendChild(browseLink);

	var actions = document.createElement("div");
	actions.className = "puzzles-actions";
	[20, 50, 100, 200].forEach(function(n) {
		var btn = document.createElement("button");
		btn.className = "btn " + (n === puzzleLabState.count ? "btn-primary" : "btn-secondary");
		btn.dataset.batch = String(n);
		btn.textContent = "Generate " + n;
		btn.addEventListener("click", function() {
			puzzleLabState.count = n;
			updateActionButtons();
			startGenerationJob();
		});
		actions.appendChild(btn);
	});
	view.appendChild(actions);

	var densityRow = document.createElement("div");
	densityRow.className = "puzzles-filter";
	var densityLabel = document.createElement("span");
	densityLabel.className = "puzzles-filter-label";
	densityLabel.textContent = "Mine density";
	densityRow.appendChild(densityLabel);
	DENSITY_OPTIONS.forEach(function(opt) {
		var btn = document.createElement("button");
		btn.className = "puzzles-filter-chip";
		btn.dataset.density = (opt.value == null) ? "mix" : String(opt.value);
		btn.textContent = opt.label;
		if (opt.value === puzzleLabState.density) btn.classList.add("active");
		btn.addEventListener("click", function() {
			puzzleLabState.density = opt.value;
			updateDensityChips();
		});
		densityRow.appendChild(btn);
	});
	view.appendChild(densityRow);

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
		if ((d === "all" && puzzleLabState.diff == null) || d === puzzleLabState.diff) btn.classList.add("active");
		if (d !== "all") btn.classList.add("puzzles-filter-chip-diff-" + d);
		btn.addEventListener("click", function() {
			puzzleLabState.diff = (d === "all") ? null : d;
			updateFilterChips();
			refreshPool();
		});
		filter.appendChild(btn);
	});
	view.appendChild(filter);

	var status = document.createElement("p");
	status.id = "puzzle_lab_status";
	status.className = "puzzle-lab-status";
	view.appendChild(status);

	var grid = document.createElement("div");
	grid.id = "puzzles_grid";
	grid.className = "puzzles-grid";
	view.appendChild(grid);

	refreshPool();
}

function updateActionButtons() {
	document.querySelectorAll(".puzzles-actions button[data-batch]").forEach(function(b) {
		var n = parseInt(b.dataset.batch, 10);
		b.className = "btn " + (n === puzzleLabState.count ? "btn-primary" : "btn-secondary");
	});
}

function updateFilterChips() {
	document.querySelectorAll("#puzzles_view .puzzles-filter-chip[data-diff]").forEach(function(b) {
		var d = b.dataset.diff;
		var match = (d === "all" && puzzleLabState.diff == null) || (parseInt(d, 10) === puzzleLabState.diff);
		b.classList.toggle("active", !!match);
	});
}

function updateDensityChips() {
	document.querySelectorAll("#puzzles_view .puzzles-filter-chip[data-density]").forEach(function(b) {
		var raw = b.dataset.density;
		var val = (raw === "mix") ? null : parseFloat(raw);
		b.classList.toggle("active", val === puzzleLabState.density);
	});
}

function startGenerationJob() {
	var status = document.getElementById("puzzle_lab_status");
	if (status) status.textContent = "Starting generation job…";
	var url = "/api/puzzles?count=" + puzzleLabState.count
		+ (puzzleLabState.diff ? "&diff=" + puzzleLabState.diff : "")
		+ (puzzleLabState.density != null ? "&density=" + puzzleLabState.density : "");
	fetch(url, { method: "POST", headers: puzzleAdminHeaders() }).then(function(r) {
		return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
	}).then(function(result) {
		if (!result.ok) {
			if (status) status.textContent = "Couldn't start: " + (result.data && result.data.error ? result.data.error : "HTTP " + result.status);
			return;
		}
		startPolling();
	}).catch(function(e) {
		if (status) status.textContent = "Error: " + e.message;
	});
}


function startPolling() {
	if (puzzleLabPollTimer) return;
	refreshPool();
	puzzleLabPollTimer = setInterval(refreshPool, 500);
}

function stopPolling() {
	if (puzzleLabPollTimer) {
		clearInterval(puzzleLabPollTimer);
		puzzleLabPollTimer = null;
	}
}

function refreshPool() {
	var diff = puzzleLabState.diff;
	var url = "/api/puzzles" + (diff ? "?diff=" + diff : "");
	fetch(url).then(function(r) { return r.json(); }).then(function(data) {
		var puzzles = (data && data.puzzles) || [];
		var poolSize = data && data.pool != null ? data.pool : puzzles.length;
		var job = data && data.job;
		// If we were polling but the job is gone, this is the last refresh.
		if (puzzleLabPollTimer && !job) stopPolling();

		var status = document.getElementById("puzzle_lab_status");
		if (status) {
			var bits = [];
			bits.push("Pool: " + poolSize + " puzzles");
			if (diff) bits.push("filter: diff " + diff + " (" + puzzles.length + ")");
			if (job) {
				var jobBit = "job " + job.id + " — " + job.done + "/" + job.target;
				if (job.diff) jobBit += " · diff " + job.diff;
				if (job.density != null) jobBit += " · density " + Math.round(job.density * 100) + "%";
				if (job.dupes) jobBit += " (" + job.dupes + " dupes skipped)";
				bits.push(jobBit);
			}
			status.textContent = bits.join(" · ");
		}

		var grid = document.getElementById("puzzles_grid");
		if (!grid) return;
		puzzles.sort(function(a, b) { return (a.score || 0) - (b.score || 0); });
		// Rebuild the grid in place; canvases are cheap enough that flicker
		// isn't worth the bookkeeping of an incremental update.
		grid.innerHTML = "";
		puzzles.forEach(function(p) { grid.appendChild(renderPuzzleCard(p)); });
	}).catch(function(e) {
		var status = document.getElementById("puzzle_lab_status");
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
	diffBadge.textContent = (p.rating != null ? p.rating : "?") + " · t" + p.difficulty;
	head.appendChild(diffBadge);
	var meta = document.createElement("span");
	meta.className = "puzzle-card-meta";
	var passBits = [];
	if (p.passes.trivial) passBits.push("t×" + p.passes.trivial);
	if (p.passes.subset) passBits.push("s×" + p.passes.subset);
	if (p.passes.overlap) passBits.push("o×" + p.passes.overlap);
	if (p.passes.chain) passBits.push("c×" + p.passes.chain);
	if (p.passes.enum) passBits.push("e×" + p.passes.enum + (p.maxEnumSize ? "(" + p.maxEnumSize + ")" : ""));
	var density = Math.round((p.mines.length / (p.rows * p.cols)) * 100);
	meta.textContent = p.rows + "×" + p.cols + " · " + p.coveredSafe + " covered · " + density + "% · score " + p.score.toFixed(1) + " · " + passBits.join(" ");
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
