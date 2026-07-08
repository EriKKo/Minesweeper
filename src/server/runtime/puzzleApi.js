// The admin / puzzle HTTP API, extracted from minesweeperServer. Everything behind
// /api/* (the All-Puzzles, Bots, Patterns, Starting-positions and Combined-puzzles
// admin pages) plus the background puzzle-generation job and the startup pool top-up.
// Pure HTTP + db + generators — it never touches the room/game/socket state, so it
// lives on its own. The server delegates /api/* to handleApiRoute and calls
// ensurePoolTopUp() at boot.
//
// NB the live puzzle *play* (serveRunPuzzle and its socket flow) stays in the server —
// it's coupled to sockets/sessions; only the read-only HTTP API + generator moved here.

var path = require("path");
var fs = require("fs");
var puzzleGen = require("../engine/PuzzleGenerator");
var insideOut = require("../engine/InsideOutGenerator");
var cspSolver = require("../engine/CSPSolver");
var BoardLogic = require("../../common/BoardLogic");
var botPlayer = require("../engine/BotPlayer");
var db = require("../db");
var oauth = require("./oauth");

var puzzleJob = null; // { id, target, diff, density, done, dupes, stalls, startedAt }
var nextPuzzleJobId = 1;

function startPuzzleJob(target, diff, density, source, targetRating) {
	source = source || "random";
	var generator = source === "inside_out" ? insideOut : puzzleGen;
	var job = {
		id: nextPuzzleJobId++,
		target: target,
		diff: diff || null,
		density: (typeof density === "number") ? density : null,
		source: source,
		targetRating: (typeof targetRating === "number") ? targetRating : null,
		done: 0,
		dupes: 0,
		stalls: 0,
		startedAt: Date.now()
	};
	puzzleJob = job;
	// 5 puzzles per tick so we yield to the event loop between chunks — keeps
	// the server responsive to socket traffic while the job runs.
	function tick() {
		if (puzzleJob !== job) return; // a newer job superseded this one
		if (job.done >= job.target) { puzzleJob = null; return; }
		var batch = generator.generatePuzzles({
			count: Math.min(5, job.target - job.done),
			diff: job.diff || undefined,
			density: (job.density != null) ? job.density : undefined,
			targetRating: (job.targetRating != null) ? job.targetRating : undefined
		});
		if (batch.length === 0) {
			// Generator gave up within its attempt budget. End the job rather
			// than spin forever on a difficulty that's exhausted random space.
			puzzleJob = null;
			return;
		}
		var added = 0;
		for (var i = 0; i < batch.length; i++) {
			var p = batch[i];
			if (!db.insertPuzzle(p)) { job.dupes++; continue; }
			added++;
			job.done++;
			if (job.done >= job.target) break;
		}
		// If a chunk produces only duplicates, the pool is saturated for this
		// difficulty — bail after a few stalls so we don't loop forever.
		if (added === 0) {
			job.stalls++;
			if (job.stalls >= 5) { puzzleJob = null; return; }
		} else {
			job.stalls = 0;
		}
		setImmediate(tick);
	}
	setImmediate(tick);
	return job;
}

// Pool-management endpoints (generate / clear) are admin-gated so an
// anonymous request can't nuke the prod puzzle pool. The client sends
// its existing session token via the X-Session-Token header; the
// server resolves it to a user and checks `is_admin`. DEV_AUTH=1
// still opens the gate locally for convenience.
function isPuzzleAdmin(req) {
	if (oauth.DEV_AUTH) return true;
	var token = req.headers["x-session-token"];
	if (!token) return false;
	var user = db.getUserByToken(token);
	return !!(user && user.is_admin);
}

// Read-only counterpart to isPuzzleAdmin: resolve the requesting user (if any) from the same
// X-Session-Token header, with no admin gate — used to personalize a GET response (e.g. attaching the
// caller's own marathon-board bests) without requiring elevated privileges just to read.
function puzzleApiUser(req) {
	var token = req.headers["x-session-token"];
	if (!token) return null;
	return db.getUserByToken(token);
}

// Admin bot browser: list the benchmarked pool, sorted/filtered/paginated in JS (the
// pool is ~500 entries, in memory). Each returned bot carries its pool index so the
// demo modal can request it back. Density keys map to ranked modes (10/15/20%).
var BOT_SORT_FIELDS = {
	rating: function(b) { return b.rating; },
	r10: function(b) { return b.ratings ? b.ratings["0.10"] : 0; },
	r15: function(b) { return b.ratings ? b.ratings["0.15"] : 0; },
	r20: function(b) { return b.ratings ? b.ratings["0.20"] : 0; },
	speedMs: function(b) { return b.speedMs; },
	difficultyMs: function(b) { return b.difficultyMs; },
	distanceMult: function(b) { return b.distanceMult; },
	maxDifficulty: function(b) { return b.maxDifficulty; },
	mistakeRate: function(b) { return b.mistakeRate; },
	chordRate: function(b) { return b.chordRate; }
};

function serveBots(req, res, url) {
	if (!isPuzzleAdmin(req)) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Admin token required." }));
		return;
	}
	var q = url.searchParams;
	var sortKey = BOT_SORT_FIELDS[q.get("sort")] ? q.get("sort") : "rating";
	var keyFn = BOT_SORT_FIELDS[sortKey];
	var dir = q.get("dir") === "asc" ? 1 : -1;
	var page = Math.max(0, parseInt(q.get("page"), 10) || 0);
	var pageSize = Math.max(1, Math.min(200, parseInt(q.get("pageSize"), 10) || 30));
	var minRating = q.get("minRating") !== null ? parseFloat(q.get("minRating")) : null;
	var maxRating = q.get("maxRating") !== null ? parseFloat(q.get("maxRating")) : null;

	// Tag each bot with its pool index, then filter by overall-Elo range.
	var all = botPlayer.getPool().map(function(b, i) {
		var o = {};
		for (var k in b) o[k] = b[k];
		o.index = i;
		return o;
	});
	if (minRating !== null && !isNaN(minRating)) all = all.filter(function(b) { return b.rating >= minRating; });
	if (maxRating !== null && !isNaN(maxRating)) all = all.filter(function(b) { return b.rating <= maxRating; });
	all.sort(function(a, b) { return (keyFn(a) - keyFn(b)) * dir; });

	var total = all.length;
	var pageBots = all.slice(page * pageSize, page * pageSize + pageSize);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		bots: pageBots,
		total: total,
		pool: botPlayer.getPool().length,
		page: page,
		pageSize: pageSize,
		densities: botPlayer.getPoolMeta().densities || [0.10, 0.15, 0.20]
	}));
}

function servePuzzles(req, res, url) {
	if (req.method === "POST") {
		if (!isPuzzleAdmin(req)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Admin token required to generate puzzles." }));
			return;
		}
		var count = Math.max(1, Math.min(500, parseInt(url.searchParams.get("count"), 10) || 20));
		var diff = parseInt(url.searchParams.get("diff"), 10);
		var density = parseFloat(url.searchParams.get("density"));
		var sourceRaw = url.searchParams.get("source");
		var source = (sourceRaw === "inside_out") ? "inside_out" : "random";
		var targetRatingRaw = parseInt(url.searchParams.get("targetRating"), 10);
		var targetRating = (source === "inside_out" && targetRatingRaw >= 0 && targetRatingRaw <= 3000) ? targetRatingRaw : null;
		if (puzzleJob) {
			res.writeHead(409, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "A generation job is already running.", job: puzzleJobStatus() }));
			return;
		}
		var job = startPuzzleJob(
			count,
			(diff >= 1 && diff <= 6) ? diff : null,
			(density >= 0.05 && density <= 0.50) ? density : null,
			source,
			targetRating
		);
		res.writeHead(202, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, job: { id: job.id, target: job.target, diff: job.diff, density: job.density, source: job.source, targetRating: job.targetRating } }));
		return;
	}
	// GET — return DB-backed puzzles. Paginated: `page` (0-indexed) +
	// `pageSize` (default 50, max 200), optionally filtered by `diff`,
	// sorted by rating asc/desc. Response carries total count for the
	// active filter so the client can size its page nav.
	var diff = parseInt(url.searchParams.get("diff"), 10);
	var page = parseInt(url.searchParams.get("page"), 10) || 0;
	var pageSize = parseInt(url.searchParams.get("pageSize"), 10) || 50;
	var sort = url.searchParams.get("sort") === "desc" ? "desc" : "asc";
	var methodRaw = url.searchParams.get("method");
	var method = (methodRaw === "trivial" || methodRaw === "subset" || methodRaw === "union" || methodRaw === "intersect" || methodRaw === "case" || methodRaw === "enum") ? methodRaw : null;
	var diffFilter = (diff >= 1 && diff <= 6) ? diff : null;
	var scoreBandRaw = url.searchParams.get("score");
	var scoreBand = (scoreBandRaw && /^(\d+(\.\d+)?-\d+(\.\d+)?|\d+(\.\d+)?\+)$/.test(scoreBandRaw)) ? scoreBandRaw : null;
	var listSourceRaw = url.searchParams.get("source");
	// Accept any well-formed source (random, inside_out, template:<id>, …); the DB query is parameterized.
	var listSource = (listSourceRaw && /^[\w:.-]+$/.test(listSourceRaw)) ? listSourceRaw : null;
	var orderByRaw = url.searchParams.get("orderBy");
	// Whitelisted against db.js's ORDER_BY_COLUMNS — lets the marathon-boards admin page sort by the
	// raw complexity floats instead of the curriculum pool's `rating` metric (the default).
	var orderBy = (orderByRaw === "max_complexity" || orderByRaw === "total_complexity" || orderByRaw === "created_at") ? orderByRaw : null;
	var puzzles = db.listPuzzles({ difficulty: diffFilter, method: method, scoreBand: scoreBand, source: listSource, page: page, pageSize: pageSize, sort: sort, orderBy: orderBy });
	var total = db.puzzleCount(diffFilter, method, scoreBand, listSource);
	// Personalize marathon rows with the requesting user's own best, if any — read-only, no admin gate
	// (see puzzleApiUser). Every other source is untouched (bestStars/attempts stay undefined for them).
	var apiUser = puzzleApiUser(req);
	if (apiUser) {
		var marathonIds = puzzles.filter(function(p) { return p.source === "marathon"; }).map(function(p) { return p.id; });
		if (marathonIds.length) {
			var bests = db.getMarathonBests(apiUser.id, marathonIds);
			puzzles.forEach(function(p) {
				var b = bests[p.id];
				if (b) { p.bestStars = b.bestStars; p.attempts = b.attempts; }
			});
		}
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		puzzles: puzzles,
		pool: db.puzzleCount(),
		total: total,
		page: page,
		pageSize: pageSize,
		job: puzzleJobStatus()
	}));
}

function servePuzzlesClear(req, res, url) {
	if (!isPuzzleAdmin(req)) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Admin token required to clear puzzles." }));
		return;
	}
	db.clearPuzzles();
	puzzleJob = null;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
}

// Browse enumerated starting positions. Paged list with optional
// size filter and sort direction.
function serveStartingPositions(req, res, url) {
	var page = parseInt(url.searchParams.get("page"), 10) || 0;
	var pageSize = parseInt(url.searchParams.get("pageSize"), 10) || 50;
	var sort = url.searchParams.get("sort") === "desc" ? "desc" : "asc";
	var size = parseInt(url.searchParams.get("size"), 10);
	var actionRaw = url.searchParams.get("action");
	var firstAction = (actionRaw === "reveal" || actionRaw === "flag" || actionRaw === "case") ? actionRaw : null;
	var minRatingRaw = parseInt(url.searchParams.get("minRating"), 10);
	var maxRatingRaw = parseInt(url.searchParams.get("maxRating"), 10);
	var uniqueRaw = url.searchParams.get("unique");
	var uniqueSolution = (uniqueRaw === "true") ? true : (uniqueRaw === "false") ? false : null;
	var primeRaw = url.searchParams.get("prime");
	var prime = (primeRaw === "true") ? true : (primeRaw === "false") ? false : null;
	var filterOpts = {
		size: (size >= 3 && size <= 9) ? size : null,
		firstAction: firstAction,
		minRating: !isNaN(minRatingRaw) ? minRatingRaw : null,
		maxRating: !isNaN(maxRatingRaw) ? maxRatingRaw : null,
		uniqueSolution: uniqueSolution,
		prime: prime
	};
	var listOpts = Object.assign({ page: page, pageSize: pageSize, sort: sort }, filterOpts);
	var positions = db.listStartingPositions(listOpts);
	var total = db.startingPositionCount(filterOpts);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ positions: positions, total: total, page: page, pageSize: pageSize }));
}

// The start-pattern catalogue (scripts/generate-patterns.js → deduction-patterns.json):
// unique first-deduction patterns from 3x3/3x4 starting cascades. Tiny file, read once and
// cached; re-read if it changes on disk (so a regenerate shows up without a restart).
var START_PATTERNS_PATH = process.env.START_PATTERNS_PATH || path.join(__dirname, "..", "..", "..", "deduction-patterns.json");
var startPatternsCache = null, startPatternsMtime = 0;
function loadStartPatterns() {
	try {
		var mtime = fs.statSync(START_PATTERNS_PATH).mtimeMs;
		if (!startPatternsCache || mtime !== startPatternsMtime) {
			startPatternsCache = JSON.parse(fs.readFileSync(START_PATTERNS_PATH, "utf8"));
			startPatternsMtime = mtime;
		}
	} catch (e) {
		startPatternsCache = { patterns: [], sizes: [], error: e.message };
	}
	return startPatternsCache;
}

function serveStartPatterns(req, res) {
	var data = loadStartPatterns();
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

// Browse the deduction-pattern catalogue (first-move templates
// extracted from every starting position). Sortable by occurrences or
// rating, filterable by action and rating band.
function servePatterns(req, res, url) {
	var page = parseInt(url.searchParams.get("page"), 10) || 0;
	var pageSize = parseInt(url.searchParams.get("pageSize"), 10) || 50;
	var sort = url.searchParams.get("sort") === "asc" ? "asc" : "desc";
	var orderByRaw = url.searchParams.get("orderBy");
	var orderBy = (orderByRaw === "occurrences" || orderByRaw === "rating") ? orderByRaw : "rating";
	var methodRaw = url.searchParams.get("method");
	var validMethod = { trivial: 1, subset: 1, union: 1, intersect: 1, case: 1, enum: 1 };
	var method = validMethod[methodRaw] ? methodRaw : null;
	var minRatingRaw = parseInt(url.searchParams.get("minRating"), 10);
	var maxRatingRaw = parseInt(url.searchParams.get("maxRating"), 10);
	var filterOpts = {
		method: method,
		minRating: !isNaN(minRatingRaw) ? minRatingRaw : null,
		maxRating: !isNaN(maxRatingRaw) ? maxRatingRaw : null
	};
	var patterns = db.listPatterns(Object.assign({ page: page, pageSize: pageSize, sort: sort, orderBy: orderBy }, filterOpts));
	var total = db.patternCount(filterOpts);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ patterns: patterns, total: total, page: page, pageSize: pageSize }));
}

// Aggregate stats for the All-Puzzles dashboard.
function servePuzzleStats(req, res) {
	var stats = db.puzzleStats();
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(stats));
}

// Run the CSP analyzer on a puzzle ({rows,cols,mines,revealed}) and return the trace payload
// the Analyze modal expects. Shared by the pool's analyze endpoint and the combined-puzzles one.
function analyzePuzzleBoard(puzzle) {
	var board = puzzleGen.buildBoard(puzzle.rows, puzzle.cols, puzzle.mines);
	var state = [];
	for (var r = 0; r < puzzle.rows; r++) {
		state.push([]);
		for (var c = 0; c < puzzle.cols; c++) state[r].push(BoardLogic.UNKNOWN);
	}
	puzzle.revealed.forEach(function(rc) { state[rc[0]][rc[1]] = BoardLogic.KNOWN; });
	function cascade(rr, cc) {
		BoardLogic.cascadeReveal(rr, cc, puzzle.rows, puzzle.cols,
			function(r2, c2) { return state[r2][c2] === BoardLogic.UNKNOWN; },
			function(r2, c2) { state[r2][c2] = BoardLogic.KNOWN; return false; },
			function(r2, c2) { return board[r2][c2]; }
		);
	}
	var result = cspSolver.analyzeBoard(board, state, { revealCell: cascade });
	return {
		solved: result.solved,
		maxComplexity: result.maxComplexity,
		totalComplexity: result.totalComplexity,
		safeCovered: result.safeCovered,
		moves: result.moves
	};
}

// CSP solver trace for a single puzzle. Used by the Analyze modal in
// the admin All-Puzzles view to compare the new solver's complexity
// scoring against the existing pass-based tier on a per-board basis.
function servePuzzleAnalyze(req, res, puzzleId) {
	var puzzle = db.getPuzzleById(puzzleId);
	if (!puzzle) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Puzzle not found" }));
		return;
	}
	var payload = analyzePuzzleBoard(puzzle);
	payload.puzzleId = puzzleId;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}

// Combined-puzzle catalogue (scripts/combine-patterns.js -> combined-puzzles.json): starting
// patterns composed at a shared seam, emitted as real {rows,cols,mines,revealed} boards. Served
// to the "Combined puzzles" admin page, which reuses the All-Puzzles card + Analyze modal.
var COMBINED_PUZZLES_PATH = process.env.COMBINED_PUZZLES_PATH || path.join(__dirname, "..", "..", "..", "combined-puzzles.json");
var combinedPuzzlesCache = null, combinedPuzzlesMtime = 0;
function loadCombinedPuzzles() {
	try {
		var mtime = fs.statSync(COMBINED_PUZZLES_PATH).mtimeMs;
		if (!combinedPuzzlesCache || mtime !== combinedPuzzlesMtime) {
			combinedPuzzlesCache = JSON.parse(fs.readFileSync(COMBINED_PUZZLES_PATH, "utf8"));
			combinedPuzzlesMtime = mtime;
		}
	} catch (e) {
		combinedPuzzlesCache = { puzzles: [], unsatisfiable: [], error: e.message };
	}
	return combinedPuzzlesCache;
}

function serveCombinedPuzzles(req, res) {
	var data = loadCombinedPuzzles();
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function serveCombinedPuzzleAnalyze(req, res, puzzleId) {
	var data = loadCombinedPuzzles();
	var puzzle = (data.puzzles || []).filter(function(p) { return p.id === puzzleId; })[0];
	if (!puzzle) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Puzzle not found" }));
		return;
	}
	var payload = analyzePuzzleBoard(puzzle);
	payload.puzzleId = puzzleId;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}

// Reconstruct a concrete, consistent board for a stored "corner-mine" (variant corner4) starting
// position so the Analyze modal can render and solve it like any other puzzle. The pattern is 16
// row-major tokens over the inner 4x4 (rows/cols 1..4) of a 6x6 board: token 0 is "M" (the corner
// mine), the rest are revealed clues. The surrounding 20-cell ring is covered and underconstrained
// (these openings are NOT fully solvable) — we just need ONE ring mine layout whose clues match the
// pattern, and we pick the lexicographically-smallest arrangement so the result is deterministic
// (the client board and the analyze trace are reconstructed from the same layout).
function cornerStartingPuzzle(pos) {
	if (pos.size !== 4) return null;
	var tokens = String(pos.pattern).split(".");
	if (tokens.length !== 16) return null;
	var N = 6, cR = 1, cC = 1;
	var inRect = function(r, c) { return r >= 1 && r <= 4 && c >= 1 && c <= 4; };
	// Ring cells (row-major over everything outside the inner rectangle), with a bit index each.
	var ringIdx = {}, ring = 0;
	for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) if (!inRect(r, c)) ringIdx[r + "," + c] = ring++;
	// Revealed interior clue cells (everything in the rectangle except the corner mine), each with
	// its target clue and the ring-neighbour bitmask + whether it touches the corner mine.
	var clueCells = [];
	var k = 0;
	for (var ir = 1; ir <= 4; ir++) {
		for (var ic = 1; ic <= 4; ic++) {
			var tok = tokens[k++];
			if (ir === cR && ic === cC) continue; // the corner mine — not a clue
			var mask = 0, adjM = false;
			for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
				if (!dr && !dc) continue;
				var nr = ir + dr, nc = ic + dc;
				if (nr === cR && nc === cC) { adjM = true; continue; }
				if (ringIdx[nr + "," + nc] !== undefined) mask |= (1 << ringIdx[nr + "," + nc]);
			}
			clueCells.push({ r: ir, c: ic, clue: parseInt(tok, 10) || 0, mask: mask, adjM: adjM });
		}
	}
	var popcount = BoardLogic.popcount;
	// First ring arrangement consistent with every interior clue (corner counts as a mine).
	var total = 1 << ring, found = -1;
	for (var a = 0; a < total && found < 0; a++) {
		var ok = true;
		for (var i = 0; i < clueCells.length; i++) {
			var cc2 = clueCells[i];
			if (popcount(a & cc2.mask) + (cc2.adjM ? 1 : 0) !== cc2.clue) { ok = false; break; }
		}
		if (ok) found = a;
	}
	if (found < 0) return null;
	var mines = [[cR, cC]];
	for (var key in ringIdx) {
		if (found & (1 << ringIdx[key])) { var p = key.split(","); mines.push([parseInt(p[0], 10), parseInt(p[1], 10)]); }
	}
	var revealed = [];
	for (var rr = 1; rr <= 4; rr++) for (var rc = 1; rc <= 4; rc++) if (!(rr === cR && rc === cC)) revealed.push([rr, rc]);
	return { rows: N, cols: N, mines: mines, revealed: revealed };
}

// Analyze a stored starting position: rebuild a concrete board and return the same trace payload the
// Analyze modal uses elsewhere, plus the board layout so the client can render it.
function serveStartingPositionAnalyze(req, res, posId) {
	var pos = db.getStartingPositionById(posId);
	if (!pos) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Starting position not found" }));
		return;
	}
	var puzzle = cornerStartingPuzzle(pos);
	if (!puzzle) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Analyze is only supported for the 4x4 corner-mine family" }));
		return;
	}
	var payload = analyzePuzzleBoard(puzzle);
	payload.rows = puzzle.rows;
	payload.cols = puzzle.cols;
	payload.mines = puzzle.mines;
	payload.revealed = puzzle.revealed;
	payload.positionId = posId;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(payload));
}

function puzzleJobStatus() {
	if (!puzzleJob) return null;
	return {
		id: puzzleJob.id,
		target: puzzleJob.target,
		diff: puzzleJob.diff,
		density: puzzleJob.density,
		source: puzzleJob.source || "random",
		targetRating: puzzleJob.targetRating || null,
		done: puzzleJob.done,
		dupes: puzzleJob.dupes
	};
}
function ensurePuzzlePoolTopUp() {
	if (process.env.PUZZLE_POOL_TOPUP_DISABLED === "1") return;
	var target = parseInt(process.env.PUZZLE_POOL_TARGET, 10);
	if (!target || target <= 0) return;
	var have = db.curriculumPuzzleCount();
	if (have >= target) {
		console.log("puzzle pool: " + have + " / " + target + " (full)");
		return;
	}
	var toGenerate = target - have;
	console.log("puzzle pool: " + have + " / " + target + " — generating " + toGenerate + " in background");
	function tick() {
		if (puzzleJob) {
			// User-triggered job in flight; wait it out and retry later.
			setTimeout(tick, 30 * 1000);
			return;
		}
		var current = db.curriculumPuzzleCount();
		if (current >= target) {
			console.log("puzzle pool top-up complete (" + current + " / " + target + ")");
			return;
		}
		var batch = Math.min(200, target - current);
		startPuzzleJob(batch, null, null);
		// Poll until the job clears, then loop.
		var watchdog = setInterval(function() {
			if (!puzzleJob) { clearInterval(watchdog); tick(); }
		}, 1000);
	}
	setTimeout(tick, 2000);
}

// Dispatch an /api/* request to the right handler. Returns true if it handled it,
// so the server's HTTP handler can early-return before its static-file fallback.
function handleApiRoute(req, res, url) {
	var pathname = url.pathname;
	if (pathname === "/api/bots") { serveBots(req, res, url); return true; }
	if (pathname === "/api/puzzles") { servePuzzles(req, res, url); return true; }
	if (pathname === "/api/puzzle-sources") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ sources: db.puzzleSources() }));
		return true;
	}
	if (pathname === "/api/puzzles/stats") { servePuzzleStats(req, res); return true; }
	if (pathname === "/api/puzzles/clear") { servePuzzlesClear(req, res, url); return true; }
	if (pathname === "/api/starting-positions") { serveStartingPositions(req, res, url); return true; }
	var startPosAnalyzeMatch = pathname.match(/^\/api\/starting-positions\/(\d+)\/analyze$/);
	if (startPosAnalyzeMatch) { serveStartingPositionAnalyze(req, res, parseInt(startPosAnalyzeMatch[1], 10)); return true; }
	if (pathname === "/api/patterns") { servePatterns(req, res, url); return true; }
	if (pathname === "/api/start-patterns") { serveStartPatterns(req, res); return true; }
	if (pathname === "/api/combined-puzzles") { serveCombinedPuzzles(req, res); return true; }
	var combinedAnalyzeMatch = pathname.match(/^\/api\/combined-puzzles\/(\d+)\/analyze$/);
	if (combinedAnalyzeMatch) { serveCombinedPuzzleAnalyze(req, res, parseInt(combinedAnalyzeMatch[1], 10)); return true; }
	var analyzeMatch = pathname.match(/^\/api\/puzzles\/(\d+)\/analyze$/);
	if (analyzeMatch) { servePuzzleAnalyze(req, res, parseInt(analyzeMatch[1], 10)); return true; }
	return false;
}

module.exports = {
	handleApiRoute: handleApiRoute,
	ensurePoolTopUp: ensurePuzzlePoolTopUp
};
