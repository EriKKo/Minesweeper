// Add a TERRITORY rating to every bot in the existing pool.
//
// Territory punishes mine hits differently (lost ground + freeze, not a flat penalty), so a bot's
// territory strength is measured separately: each bot's real decision loop is replayed clearing a
// no-guess territory board against a non-moving opponent, on a virtual clock (TerritoryBench), and the
// clear time mapped to an Elo against a configForElo calibration curve (BotBench.timeToElo). This
// script loads bots-pool.json, computes `ratings.territory` / `times.territory` for each bot, stores
// the curve under `territoryCalibration`, and writes the file back. Racing ratings are untouched.
//
// Clearing a board is CPU-bound and per-config independent, so it's fanned across worker threads.
//
// Run:  node scripts/calibrate-territory.js
// Tune: BOARDS (boards shared by all bots), CAL_SAMPLES (configForElo draws per grid point),
//       LIMIT (benchmark only the first N bots — quick smoke), WORKERS.

var fs = require("fs");
var os = require("os");
var path = require("path");
var Worker = require("worker_threads").Worker;
var bench = require("../src/server/engine/BotBench");
var tbench = require("../src/server/engine/TerritoryBench");

var BOARDS = parseInt(process.env.BOARDS, 10) || 12;
var CAL_SAMPLES = parseInt(process.env.CAL_SAMPLES, 10) || 5;
var LIMIT = parseInt(process.env.LIMIT, 10) || 0; // 0 = all bots
var NUM_WORKERS = parseInt(process.env.WORKERS, 10) || Math.max(1, Math.min(8, (os.cpus() || []).length - 1));

function ts() { return new Date().toISOString(); }
function log(m) { console.log("[" + ts() + "] " + m); }

var poolPath = path.join(__dirname, "..", "bots-pool.json");
var pool = JSON.parse(fs.readFileSync(poolPath, "utf8"));
if (!pool.bots || !pool.bots.length) { console.error("no bots in pool"); process.exit(1); }

log("Generating " + BOARDS + " no-guess territory boards (" + tbench.ROWS + "x" + tbench.COLS + ", density " + tbench.DENSITY + ")...");
var t0 = Date.now();
var boards = tbench.makeBoards(BOARDS);
log("  " + boards.length + " boards in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

var workers = [];
for (var w = 0; w < NUM_WORKERS; w++) workers.push(new Worker(path.join(__dirname, "territory-bench-worker.js"), { workerData: { boards: boards } }));

// Run a list of configs across the workers; resolves with their mean clear times (ms), in order.
function runConfigs(configs) {
	var per = Math.ceil(configs.length / workers.length);
	return Promise.all(workers.map(function(wk, idx) {
		var slice = configs.slice(idx * per, (idx + 1) * per);
		if (!slice.length) return Promise.resolve([]);
		return new Promise(function(resolve, reject) {
			wk.once("message", resolve);
			wk.once("error", reject);
			wk.postMessage({ configs: slice });
		});
	})).then(function(chunks) { return [].concat.apply([], chunks); });
}

(async function main() {
	log("Benchmarking on " + NUM_WORKERS + " workers.");

	// --- calibration: configForElo across the grid, `CAL_SAMPLES` style draws each ---
	log("Calibrating territory clear-time -> Elo (" + tbench.ELO_GRID.length + " grid points x " + CAL_SAMPLES + " samples)...");
	t0 = Date.now();
	var calConfigs = [], calElo = [];
	for (var g = 0; g < tbench.ELO_GRID.length; g++) {
		for (var s = 0; s < CAL_SAMPLES; s++) { calConfigs.push(bench.configForElo(tbench.ELO_GRID[g])); calElo.push(tbench.ELO_GRID[g]); }
	}
	var calTimes = await runConfigs(calConfigs);
	var byElo = {};
	for (var i = 0; i < calTimes.length; i++) { var e = calElo[i]; (byElo[e] || (byElo[e] = [])).push(calTimes[i]); }
	var curve = tbench.ELO_GRID.map(function(elo) {
		var arr = byElo[elo]; var sum = 0; for (var k = 0; k < arr.length; k++) sum += arr[k];
		return [elo, sum / arr.length];
	});
	log("  curve: " + curve[0][0] + "Elo=" + Math.round(curve[0][1] / 1000) + "s .. " +
		curve[curve.length - 1][0] + "Elo=" + Math.round(curve[curve.length - 1][1] / 1000) + "s  (" + ((Date.now() - t0) / 1000).toFixed(1) + "s)");

	// --- rate every pool bot ---
	var bots = LIMIT > 0 ? pool.bots.slice(0, LIMIT) : pool.bots;
	log("Benchmarking " + bots.length + " bots on territory...");
	t0 = Date.now();
	var times = await runConfigs(bots);
	for (var b = 0; b < bots.length; b++) {
		if (!bots[b].ratings) bots[b].ratings = {};
		if (!bots[b].times) bots[b].times = {};
		bots[b].times.territory = Math.round(times[b]);
		bots[b].ratings.territory = bench.timeToElo(times[b], curve);
	}
	log("  done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

	workers.forEach(function(wk) { wk.terminate(); });

	pool.territoryCalibration = { board: { rows: tbench.ROWS, cols: tbench.COLS }, density: tbench.DENSITY, clearCapMs: tbench.CLEAR_CAP_MS, curve: curve, calibratedAt: ts() };
	fs.writeFileSync(poolPath, JSON.stringify(pool, null, "\t"));
	log("Wrote territory ratings to " + poolPath);

	var BUCKET = 100, counts = {};
	bots.forEach(function(bt) { var k = Math.floor(bt.ratings.territory / BUCKET) * BUCKET; counts[k] = (counts[k] || 0) + 1; });
	console.log("\nTerritory rating distribution:");
	Object.keys(counts).map(Number).sort(function(a, c) { return a - c; }).forEach(function(k) {
		console.log("  " + String(k).padStart(5) + "-" + (k + BUCKET) + "  " + String(counts[k]).padStart(4) + "  " + "#".repeat(Math.min(counts[k], 60)));
	});
})().catch(function(e) { console.error("calibration failed:", e); process.exit(1); });
