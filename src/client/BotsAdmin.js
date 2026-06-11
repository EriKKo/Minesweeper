// Admin: browse the benchmarked ranked-bot pool and watch any bot play.
//
// Mirrors the All-puzzles browser (Puzzles.js): a sortable/filterable, paginated
// grid backed by `GET /api/bots`. Each bot card shows its six per-move variables, its
// overall Elo, and a row per ranked mode (Sprint/Tournament/Standard = 10/15/20%) with
// the mode's measured Elo and a "Watch" button that opens a live demo modal. The demo
// itself is server-driven (bot_demo_start/stop + bot_demo_board/move sockets); this
// module only renders the streamed frames on its own canvas.

var botListState = { sort: "rating", dir: "desc", minRating: null, maxRating: null, page: 0, pageSize: 30 };

// Sortable fields (must match BOT_SORT_FIELDS on the server).
var BOT_SORT_OPTIONS = [
	{ value: "rating", label: "Overall Elo" },
	{ value: "r10", label: "Sprint Elo (10%)" },
	{ value: "r15", label: "Tournament Elo (15%)" },
	{ value: "r20", label: "Standard Elo (20%)" },
	{ value: "speedMs", label: "Speed (ms/move)" },
	{ value: "difficultyMs", label: "Thinking (ms/difficulty)" },
	{ value: "distanceMult", label: "Distance mult" },
	{ value: "maxDifficulty", label: "Max difficulty" },
	{ value: "mistakeRate", label: "Mistake rate" },
	{ value: "chordRate", label: "Chord rate" }
];

// Density → ranked mode. ratings/times in the pool are keyed by these density strings.
var BOT_MODES = [
	{ density: 0.10, key: "0.10", label: "Sprint", pct: "10%" },
	{ density: 0.15, key: "0.15", label: "Tournament", pct: "15%" },
	{ density: 0.20, key: "0.20", label: "Standard", pct: "20%" }
];

// --- hash persistence (#/admin/bots?sort=rating&dir=desc&page=2&minRating=…) ---
function readBotListStateFromHash() {
	if (!location.search) return;
	var p = new URLSearchParams(location.search);
	var sort = p.get("sort");
	if (BOT_SORT_OPTIONS.some(function(o) { return o.value === sort; })) botListState.sort = sort;
	botListState.dir = p.get("dir") === "asc" ? "asc" : "desc";
	var mn = parseFloat(p.get("minRating")); botListState.minRating = isNaN(mn) ? null : mn;
	var mx = parseFloat(p.get("maxRating")); botListState.maxRating = isNaN(mx) ? null : mx;
	var page = parseInt(p.get("page"), 10); botListState.page = page > 0 ? page : 0;
}

function writeBotListStateToHash() {
	var bits = [];
	if (botListState.sort !== "rating") bits.push("sort=" + botListState.sort);
	if (botListState.dir !== "desc") bits.push("dir=" + botListState.dir);
	if (botListState.minRating != null) bits.push("minRating=" + botListState.minRating);
	if (botListState.maxRating != null) bits.push("maxRating=" + botListState.maxRating);
	if (botListState.page) bits.push("page=" + botListState.page);
	var qs = bits.length ? "?" + bits.join("&") : "";
	if (location.search !== qs) history.replaceState(null, "", location.pathname + qs);
}

function renderBotsList() {
	var view = document.getElementById("bots_view");
	if (!view) return;
	readBotListStateFromHash();
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Ranked bots";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Browse the benchmarked bot pool. Each bot's variables and per-mode Elo were measured by simulating it on the three ranked densities. Click Watch to see one play an example board in real time.";
	view.appendChild(sub);

	var statusP = document.createElement("p");
	statusP.id = "bots_list_status";
	statusP.className = "puzzles-list-status";
	view.appendChild(statusP);

	var toolbar = document.createElement("div");
	toolbar.className = "puzzles-toolbar";

	// Sort field + direction
	var sortWrap = document.createElement("div");
	sortWrap.className = "puzzles-sort-wrap";
	var sortLabel = document.createElement("span");
	sortLabel.className = "puzzles-filter-label";
	sortLabel.textContent = "Sort";
	sortWrap.appendChild(sortLabel);
	var sortSelect = document.createElement("select");
	sortSelect.className = "puzzles-sort-select";
	BOT_SORT_OPTIONS.forEach(function(opt) {
		var o = document.createElement("option");
		o.value = opt.value; o.textContent = opt.label;
		if (opt.value === botListState.sort) o.selected = true;
		sortSelect.appendChild(o);
	});
	sortSelect.addEventListener("change", function() {
		botListState.sort = sortSelect.value; botListState.page = 0;
		writeBotListStateToHash(); refreshBotsList();
	});
	sortWrap.appendChild(sortSelect);
	var dirSelect = document.createElement("select");
	dirSelect.className = "puzzles-sort-select";
	[{ value: "desc", label: "High → low" }, { value: "asc", label: "Low → high" }].forEach(function(opt) {
		var o = document.createElement("option");
		o.value = opt.value; o.textContent = opt.label;
		if (opt.value === botListState.dir) o.selected = true;
		dirSelect.appendChild(o);
	});
	dirSelect.addEventListener("change", function() {
		botListState.dir = dirSelect.value; botListState.page = 0;
		writeBotListStateToHash(); refreshBotsList();
	});
	sortWrap.appendChild(dirSelect);
	toolbar.appendChild(sortWrap);

	// Elo range filter
	var eloWrap = document.createElement("div");
	eloWrap.className = "puzzles-filter";
	var eloLabel = document.createElement("span");
	eloLabel.className = "puzzles-filter-label";
	eloLabel.textContent = "Elo";
	eloWrap.appendChild(eloLabel);
	function eloInput(which, placeholder) {
		var inp = document.createElement("input");
		inp.type = "number"; inp.className = "bots-elo-input"; inp.placeholder = placeholder;
		inp.value = botListState[which] != null ? botListState[which] : "";
		inp.addEventListener("change", function() {
			var v = parseFloat(inp.value);
			botListState[which] = isNaN(v) ? null : v;
			botListState.page = 0;
			writeBotListStateToHash(); refreshBotsList();
		});
		return inp;
	}
	eloWrap.appendChild(eloInput("minRating", "min"));
	var dash = document.createElement("span"); dash.textContent = "–"; dash.className = "bots-elo-dash";
	eloWrap.appendChild(dash);
	eloWrap.appendChild(eloInput("maxRating", "max"));
	toolbar.appendChild(eloWrap);

	view.appendChild(toolbar);

	var grid = document.createElement("div");
	grid.id = "bots_list_grid";
	grid.className = "bots-grid";
	view.appendChild(grid);

	var pager = document.createElement("div");
	pager.id = "bots_list_pager";
	pager.className = "puzzles-pager";
	view.appendChild(pager);

	refreshBotsList();
}

function refreshBotsList() {
	var qs = "sort=" + botListState.sort + "&dir=" + botListState.dir
		+ "&page=" + (botListState.page || 0) + "&pageSize=" + (botListState.pageSize || 30)
		+ (botListState.minRating != null ? "&minRating=" + botListState.minRating : "")
		+ (botListState.maxRating != null ? "&maxRating=" + botListState.maxRating : "");
	fetch("/api/bots?" + qs, { headers: (typeof puzzleAdminHeaders === "function" ? puzzleAdminHeaders() : {}) })
		.then(function(r) {
			if (r.status === 403) throw new Error("Admin access required.");
			return r.json();
		})
		.then(function(data) {
			var bots = (data && data.bots) || [];
			var total = data && typeof data.total === "number" ? data.total : bots.length;
			var pool = data && data.pool != null ? data.pool : total;
			var page = botListState.page || 0, pageSize = botListState.pageSize || 30;

			var status = document.getElementById("bots_list_status");
			if (status) {
				var fromN = total ? (page * pageSize + 1) : 0;
				var toN = Math.min(total, (page + 1) * pageSize);
				status.textContent = "Pool: " + pool + " bots · matching " + total + " · showing " + fromN + "–" + toN;
			}

			var grid = document.getElementById("bots_list_grid");
			if (!grid) return;
			grid.innerHTML = "";
			if (bots.length === 0) {
				var empty = document.createElement("p");
				empty.className = "puzzles-list-empty";
				empty.textContent = page > 0 ? "No bots on this page — try going back." : "No bots match this filter.";
				grid.appendChild(empty);
			} else {
				bots.forEach(function(b) { grid.appendChild(renderBotCard(b)); });
			}
			renderBotsListPager(total, page, pageSize);
		})
		.catch(function(e) {
			var status = document.getElementById("bots_list_status");
			if (status) status.textContent = "Error: " + e.message;
		});
}

function renderBotsListPager(total, page, pageSize) {
	var pager = document.getElementById("bots_list_pager");
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
			botListState.page = Math.max(0, Math.min(totalPages - 1, target));
			writeBotListStateToHash(); refreshBotsList();
		});
		pager.appendChild(b);
	}
	addBtn("← Prev", page - 1, { disabled: page <= 0 });
	var windowSize = 5;
	var start = Math.max(0, page - Math.floor(windowSize / 2));
	var end = Math.min(totalPages - 1, start + windowSize - 1);
	start = Math.max(0, end - windowSize + 1);
	if (start > 0) {
		addBtn("1", 0);
		if (start > 1) { var d = document.createElement("span"); d.className = "puzzles-pager-dots"; d.textContent = "…"; pager.appendChild(d); }
	}
	for (var i = start; i <= end; i++) addBtn(String(i + 1), i, { current: i === page });
	if (end < totalPages - 1) {
		if (end < totalPages - 2) { var d2 = document.createElement("span"); d2.className = "puzzles-pager-dots"; d2.textContent = "…"; pager.appendChild(d2); }
		addBtn(String(totalPages), totalPages - 1);
	}
	addBtn("Next →", page + 1, { disabled: page >= totalPages - 1 });
}

function renderBotCard(bot) {
	var card = document.createElement("div");
	card.className = "bot-card";

	var head = document.createElement("div");
	head.className = "bot-card-head";
	var rating = document.createElement("span");
	rating.className = "bot-rating-badge";
	rating.textContent = (bot.rating != null ? bot.rating : "?") + " Elo";
	head.appendChild(rating);
	var idTag = document.createElement("span");
	idTag.className = "bot-card-id";
	idTag.textContent = "#" + bot.index;
	head.appendChild(idTag);
	card.appendChild(head);

	// Six per-move variables.
	var vars = document.createElement("div");
	vars.className = "bot-vars";
	[
		["speed", bot.speedMs + "ms"],
		["think", bot.difficultyMs + "ms/d"],
		["dist×", bot.distanceMult],
		["maxDiff", bot.maxDifficulty],
		["mistakes", (bot.mistakeRate * 100).toFixed(1) + "%"],
		["chord", (bot.chordRate * 100).toFixed(0) + "%"]
	].forEach(function(pair) {
		var v = document.createElement("div");
		v.className = "bot-var";
		var k = document.createElement("span"); k.className = "bot-var-key"; k.textContent = pair[0];
		var val = document.createElement("span"); val.className = "bot-var-val"; val.textContent = pair[1];
		v.appendChild(k); v.appendChild(val);
		vars.appendChild(v);
	});
	card.appendChild(vars);

	// Per-mode Elo + Watch button.
	BOT_MODES.forEach(function(mode) {
		var row = document.createElement("div");
		row.className = "bot-mode-row";
		var name = document.createElement("span");
		name.className = "bot-mode-name";
		name.textContent = mode.label + " · " + mode.pct;
		row.appendChild(name);
		var elo = document.createElement("span");
		elo.className = "bot-mode-elo";
		elo.textContent = (bot.ratings && bot.ratings[mode.key] != null ? bot.ratings[mode.key] : "?") + " Elo";
		row.appendChild(elo);
		var watch = document.createElement("button");
		watch.className = "bot-watch-btn";
		watch.textContent = "▶ Watch";
		watch.addEventListener("click", function() {
			openBotDemoModal(bot.index, mode.density, "#" + bot.index + " · " + bot.rating + " Elo", mode, bot);
		});
		row.appendChild(watch);
		card.appendChild(row);
	});

	return card;
}

// ---------------------------------------------------------------------------
// Watch-a-bot-play modal (server-driven). One open at a time.
// ---------------------------------------------------------------------------
var activeBotDemo = null;

function openBotDemoModal(botIndex, density, label, mode, bot) {
	closeBotDemoModal();

	var backdrop = document.createElement("div");
	backdrop.id = "bot_demo_modal";
	backdrop.className = "analyze-modal-backdrop";
	backdrop.addEventListener("click", function(e) { if (e.target === backdrop) closeBotDemoModal(); });

	var panel = document.createElement("div");
	panel.className = "analyze-modal";

	var head = document.createElement("div");
	head.className = "analyze-modal-head";
	var htitle = document.createElement("div");
	htitle.className = "bot-demo-title";
	htitle.textContent = "Bot " + label + " — " + mode.label + " (" + mode.pct + ")";
	head.appendChild(htitle);
	var statusSpan = document.createElement("span");
	statusSpan.className = "bot-demo-status";
	statusSpan.id = "bot_demo_status";
	statusSpan.textContent = "Generating board…";
	head.appendChild(statusSpan);
	var newBtn = document.createElement("button");
	newBtn.className = "btn btn-secondary bot-demo-new";
	newBtn.textContent = "New board";
	newBtn.addEventListener("click", function() { startActiveDemo(); });
	head.appendChild(newBtn);
	var close = document.createElement("button");
	close.className = "analyze-modal-close";
	close.textContent = "✕";
	close.addEventListener("click", closeBotDemoModal);
	head.appendChild(close);
	panel.appendChild(head);

	var body = document.createElement("div");
	body.className = "analyze-modal-body bot-demo-body";
	var boardWrap = document.createElement("div");
	boardWrap.className = "bot-demo-board";
	var canvas = document.createElement("canvas");
	canvas.id = "bot_demo_canvas";
	boardWrap.appendChild(canvas);
	body.appendChild(boardWrap);
	panel.appendChild(body);

	backdrop.appendChild(panel);
	document.body.appendChild(backdrop);

	activeBotDemo = { botIndex: botIndex, density: density, canvas: canvas, rows: 0, cols: 0, board: null, state: null, finished: false };
	startActiveDemo();
}

function startActiveDemo() {
	if (!activeBotDemo) return;
	activeBotDemo.finished = false;
	var status = document.getElementById("bot_demo_status");
	if (status) status.textContent = "Generating board…";
	socket.emit("bot_demo_start", { botIndex: activeBotDemo.botIndex, density: activeBotDemo.density });
}

function closeBotDemoModal() {
	if (activeBotDemo) { try { socket.emit("bot_demo_stop"); } catch (e) {} }
	activeBotDemo = null;
	var m = document.getElementById("bot_demo_modal");
	if (m) m.remove();
}

// Socket frame handlers (wired in index.html → these globals).
function onBotDemoBoard(data) {
	if (!activeBotDemo) return;
	activeBotDemo.rows = data.rows;
	activeBotDemo.cols = data.cols;
	activeBotDemo.board = data.board;
	activeBotDemo.state = data.state;
	activeBotDemo.finished = false;
	var status = document.getElementById("bot_demo_status");
	if (status) status.textContent = "Playing… 0%";
	drawDemoBoard(null);
}

function onBotDemoMove(data) {
	if (!activeBotDemo) return;
	if (data.state) activeBotDemo.state = data.state;
	var status = document.getElementById("bot_demo_status");
	if (status) {
		var pct = Math.round((data.progress || 0) * 100);
		if (data.finished || data.done) status.textContent = data.finished ? ("Solved! " + pct + "%") : ("Stopped · " + pct + "%");
		else status.textContent = "Playing… " + pct + "%";
	}
	if (data.finished || data.done) activeBotDemo.finished = true;
	drawDemoBoard(data.move || null);
}

function onBotDemoRejected(data) {
	var status = document.getElementById("bot_demo_status");
	if (status) status.textContent = (data && data.reason) || "Couldn't start demo.";
}

// Self-contained board renderer — draws (board, state) onto the modal canvas via the
// shared drawCell primitive, with no dependence on the live-game globals.
function drawDemoBoard(lastMove) {
	var d = activeBotDemo;
	if (!d || !d.board || !d.canvas) return;
	var rows = d.rows, cols = d.cols;
	// Fit the board into a target box, capped cell size, DPR-aware.
	var box = 560;
	var cellPx = Math.max(14, Math.min(40, Math.floor(box / Math.max(rows, cols))));
	var canvas = d.canvas;
	canvas.width = Math.round(cols * cellPx * DPR);
	canvas.height = Math.round(rows * cellPx * DPR);
	canvas.style.width = (cols * cellPx) + "px";
	canvas.style.height = (rows * cellPx) + "px";
	var ctx = canvas.getContext("2d");
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	var board = d.board, state = d.state;
	var view = {
		xray: false,
		isRevealed: function(r, c) { return state[r][c] === KNOWN; },
		isFlagged: function(r, c) { return state[r][c] === FLAGGED; },
		isMine: function(r, c) { return board[r][c] === MINE; },
		getClue: function(r, c) { var v = board[r][c]; return v > 0 ? v : 0; }
	};
	var sw = canvas.width / cols, sh = canvas.height / rows;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) drawCell(ctx, r, c, view, sw, sh, null);
	}
	// Outline the bot's most recent move so the eye can follow it.
	if (lastMove) {
		ctx.save();
		ctx.strokeStyle = lastMove.stuck ? "rgba(248,113,113,0.95)" : "rgba(250,204,21,0.95)";
		ctx.lineWidth = Math.max(2, sw * 0.08);
		ctx.strokeRect(lastMove.c * sw + ctx.lineWidth / 2, lastMove.r * sh + ctx.lineWidth / 2, sw - ctx.lineWidth, sh - ctx.lineWidth);
		ctx.restore();
	}
}
