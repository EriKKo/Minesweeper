// Puzzle Lab — internal experimentation page.
//
// The server keeps an in-memory pool of generated puzzles. The lab shows
// what's currently in the pool (optionally filtered by difficulty tier) and
// lets us trigger a server-side generation *job* that fills the pool in the
// background. Polling refreshes job progress + pool contents while a job
// runs, then stops once the server reports the job is done.

var puzzleLabState = { count: 50, diff: null, density: null };
var puzzleLabPollTimer = null;

var DENSITY_OPTIONS = [
	{ label: "Mix", value: null },
	{ label: "10%", value: 0.10 },
	{ label: "15%", value: 0.15 },
	{ label: "20%", value: 0.20 },
	{ label: "25%", value: 0.25 },
	{ label: "30%", value: 0.30 },
	{ label: "35%", value: 0.35 }
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
	sub.textContent = "Server-side puzzle pool. Trigger a generation job, then browse the pool sorted by continuous difficulty score (subset/enum steps drive it; longer trivial chains add a small bonus capped below the first subset step). Badge shows score + tier (t1–t6).";
	view.appendChild(sub);

	var browseLink = document.createElement("p");
	browseLink.className = "puzzles-list-footer";
	browseLink.innerHTML = '<a href="#/puzzles/list">Browse all puzzles →</a>';
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
	var clearBtn = document.createElement("button");
	clearBtn.className = "btn btn-secondary";
	clearBtn.id = "puzzles_clear_btn";
	clearBtn.textContent = "Clear pool";
	clearBtn.addEventListener("click", clearPool);
	actions.appendChild(clearBtn);
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
	fetch(url, { method: "POST" }).then(function(r) {
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

function clearPool() {
	fetch("/api/puzzles/clear", { method: "POST" })
		.then(function() { refreshPool(); });
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
	diffBadge.textContent = (p.score != null ? p.score.toFixed(1) : "?") + " · t" + p.difficulty;
	head.appendChild(diffBadge);
	var meta = document.createElement("span");
	meta.className = "puzzle-card-meta";
	var passBits = [];
	if (p.passes.trivial) passBits.push("t×" + p.passes.trivial);
	if (p.passes.subset) passBits.push("s×" + p.passes.subset);
	if (p.passes.enum) passBits.push("e×" + p.passes.enum + (p.maxEnumSize ? "(" + p.maxEnumSize + ")" : ""));
	var density = Math.round((p.mines.length / (p.rows * p.cols)) * 100);
	meta.textContent = p.rows + "×" + p.cols + " · " + p.coveredSafe + " covered · " + density + "% · " + passBits.join(" ");
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
