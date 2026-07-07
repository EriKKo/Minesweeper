// Admin "Generate marathon board" job runner (admin-only surface, [main-sp]).
//
// scripts/generate-marathon-boards.js is intentionally NOT cheap (see its own header) — random
// search + a full-board CSP re-verification per candidate, meant to run offline. It must never run
// inline on this process's event loop, which also serves every live game, so this spawns it as a
// CHILD PROCESS instead and streams its stdout back to admin sockets. Only ONE job runs at a time
// (module-level `job`); starting another while one is running is rejected.
//
// The child opens its own connection to the same ranked.db file (via its own `require("../db")`)
// alongside this process's connection — see db.js's WAL/busy_timeout pragmas, added specifically so
// the two connections don't collide with an instant SQLITE_BUSY.

var path = require("path");
var spawn = require("child_process").spawn;
var appState = require("./appState");

var SCRIPT_PATH = path.join(__dirname, "..", "..", "..", "scripts", "generate-marathon-boards.js");
var PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
var LOG_LIMIT = 300; // cap retained stdout/stderr lines so a long run can't grow this unboundedly

var isSocketAdmin = null;
function init(deps) { isSocketAdmin = deps.isSocketAdmin; }

var job = null; // see startJob for shape
var nextJobId = 1;

function clampInt(v, lo, hi, dflt) {
	var n = parseInt(v, 10);
	if (!Number.isFinite(n)) return dflt;
	return Math.max(lo, Math.min(hi, n));
}
function clampFloat(v, lo, hi, dflt) {
	var n = parseFloat(v);
	if (!Number.isFinite(n)) return dflt;
	return Math.max(lo, Math.min(hi, n));
}

// The handful of stdout line shapes generate-marathon-boards.js prints — pulls out the numbers a
// progress UI cares about. A line that matches none of these still lands in the raw log, it just
// doesn't move `latest`.
var RE_INITIAL = /^initial board found on try (\d+): totalC=([\d.]+) maxC=([\d.]+) moves=(\d+)/;
var RE_ITER = /^\s*iter (\d+): .* totalC=([\d.]+) maxC=([\d.]+) .*\[(\d+)ms elapsed\] saved as id (\d+)/;
var RE_DONE = /^stopped after (\d+) iterations \((\d+) accepted, (\d+) no-improvement\): totalC=([\d.]+) maxC=([\d.]+) moves=(\d+) solved=(true|false) \[(\d+)ms\] final puzzle id=(\d+)/;

function parseLine(line, latest) {
	var m;
	if ((m = RE_DONE.exec(line))) {
		latest.iter = +m[1]; latest.accepted = +m[2]; latest.rejected = +m[3];
		latest.totalC = +m[4]; latest.maxC = +m[5]; latest.moves = +m[6]; latest.solved = (m[7] === "true");
		latest.elapsedMs = +m[8]; latest.puzzleId = +m[9];
	} else if ((m = RE_ITER.exec(line))) {
		latest.iter = +m[1]; latest.totalC = +m[2]; latest.maxC = +m[3]; latest.elapsedMs = +m[4]; latest.puzzleId = +m[5];
	} else if ((m = RE_INITIAL.exec(line))) {
		latest.tries = +m[1]; latest.totalC = +m[2]; latest.maxC = +m[3]; latest.moves = +m[4];
	}
}

function appendLog(j, text) {
	text.split("\n").forEach(function(line) {
		line = line.replace(/\r$/, "");
		if (!line) return;
		j.log.push(line);
		if (j.log.length > LOG_LIMIT) j.log.shift();
		parseLine(line, j.latest);
	});
}

function snapshot() {
	if (!job) return { status: "idle" };
	return {
		id: job.id, status: job.status, params: job.params,
		startedAt: job.startedAt, finishedAt: job.finishedAt,
		latest: job.latest, log: job.log, exitCode: job.exitCode, error: job.error
	};
}

function broadcast() {
	var payload = snapshot();
	var sockets = appState.sockets;
	for (var pid in sockets) {
		if (isSocketAdmin(pid)) sockets[pid].emit("marathon_gen_update", payload);
	}
}

function startJob(params) {
	params = params || {};
	if (job && job.status === "running") return { error: "already_running" };

	var rows = clampInt(params.rows, 8, 40, 24);
	var cols = clampInt(params.cols, 8, 60, 30);
	var density = clampFloat(params.density, 0.05, 0.35, 0.20);
	var target = clampFloat(params.target, 1, 100000, 300);
	var timeBudgetSec = clampInt(params.timeBudgetSec, 5, 900, 90);
	var strategy = params.strategy === "grid" ? "grid" : "weighted";
	var maxComplexity = clampFloat(params.maxComplexity, 1, 9.9, 7);

	var env = Object.assign({}, process.env, {
		ROWS: String(rows), COLS: String(cols), DENSITY: String(density),
		REGION_STRATEGY: strategy, TARGET_COMPLEXITY: String(target),
		TIME_BUDGET_MS: String(timeBudgetSec * 1000), MAX_COMPLEXITY: String(maxComplexity)
	});

	var child = spawn(process.execPath, [SCRIPT_PATH], { cwd: PROJECT_ROOT, env: env });

	job = {
		id: nextJobId++,
		params: {
			rows: rows, cols: cols, density: density, target: target,
			timeBudgetSec: timeBudgetSec, strategy: strategy, maxComplexity: maxComplexity
		},
		status: "running",
		startedAt: Date.now(),
		finishedAt: null,
		log: [],
		latest: {},
		child: child,
		exitCode: null,
		error: null
	};
	var thisJob = job;

	child.stdout.on("data", function(chunk) { appendLog(thisJob, chunk.toString()); broadcast(); });
	child.stderr.on("data", function(chunk) { appendLog(thisJob, chunk.toString()); broadcast(); });
	child.on("error", function(err) {
		thisJob.status = "error"; thisJob.error = err.message; thisJob.finishedAt = Date.now(); thisJob.child = null;
		broadcast();
	});
	child.on("exit", function(code) {
		if (thisJob.status === "stopping") thisJob.status = "stopped";
		else thisJob.status = (code === 0) ? "done" : "error";
		thisJob.exitCode = code; thisJob.finishedAt = Date.now(); thisJob.child = null;
		broadcast();
	});

	broadcast();
	return snapshot();
}

function stopJob() {
	if (!job || job.status !== "running") return { error: "not_running" };
	job.status = "stopping";
	if (job.child) job.child.kill("SIGTERM");
	broadcast();
	return snapshot();
}

// `npm run stop` / a deploy sends SIGTERM to THIS process by matching its own command line — it
// would never match the child's ("node scripts/generate-marathon-boards.js"), so without this the
// child would keep running as an orphan after the server exits. Fires alongside lifecycle.js's own
// SIGTERM drain handler (Node allows multiple listeners per signal); this one is synchronous so
// ordering between the two doesn't matter.
function killRunningChild() {
	if (job && job.child) job.child.kill("SIGTERM");
}
process.on("SIGTERM", killRunningChild);
process.on("SIGINT", killRunningChild);

function registerSocketHandlers(socket, playerID) {
	socket.on("marathon_gen_status", function() {
		if (!isSocketAdmin(playerID)) return;
		socket.emit("marathon_gen_update", snapshot());
	});
	socket.on("marathon_gen_start", function(data) {
		if (!isSocketAdmin(playerID)) return;
		socket.emit("marathon_gen_update", startJob(data));
	});
	socket.on("marathon_gen_stop", function() {
		if (!isSocketAdmin(playerID)) return;
		socket.emit("marathon_gen_update", stopJob());
	});
}

module.exports = {
	init: init,
	registerSocketHandlers: registerSocketHandlers,
	startJob: startJob,
	stopJob: stopJob,
	getStatus: snapshot
};
