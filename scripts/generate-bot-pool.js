// Generate the ranked filler-bot pool.
//
// Pipeline:
//   1. Pre-generate a fixed set of no-guess boards per ranked density (10/15/20%).
//   2. Calibrate the solve-time -> Elo curve from configForElo(600..1800) on those boards.
//   3. Generate a batch of random bots (randomBotConfig), benchmark each across the
//      three densities, and assign a measured rating.
//   4. Ensure every 100-pt Elo bucket in 600..1800 has at least MIN_PER_BUCKET bots
//      (top up by generating more), and trim overfull buckets to MAX_PER_BUCKET.
//   5. Write bots-pool.json (project root, committed) + print a rating histogram.
//
// Run:  node scripts/generate-bot-pool.js
// Tune: POOL_SIZE, BOARDS, CAL_SAMPLES env vars (defaults below). Lower them for a
//       quick smoke run, e.g.  POOL_SIZE=120 BOARDS=8 CAL_SAMPLES=3 node scripts/generate-bot-pool.js
//
// Expect a few minutes at the defaults (~1200 bots x 3 densities x 24 boards).

var fs = require("fs");
var os = require("os");
var path = require("path");
var Worker = require("worker_threads").Worker;
var botPlayer = require("../src/server/BotPlayer");
var bench = require("../src/server/BotBench");

var POOL_SIZE = parseInt(process.env.POOL_SIZE, 10) || 1200;
var BOARDS = parseInt(process.env.BOARDS, 10) || 24;       // boards per density (shared by all bots)
var CAL_SAMPLES = parseInt(process.env.CAL_SAMPLES, 10) || 6; // configForElo samples per grid point
// Benchmarking is CPU-bound and per-bot independent, so fan it out across cores.
var NUM_WORKERS = parseInt(process.env.WORKERS, 10) || Math.max(1, Math.min(8, (os.cpus() || []).length - 1));

var ELO_MIN = 0, ELO_MAX = 1800, BUCKET = 100;
var MIN_PER_BUCKET = 8, MAX_PER_BUCKET = 40;
var FILL_MAX_EXTRA = POOL_SIZE * 3; // hard cap on top-up generation so we can't loop forever
// Some Elo buckets (the very bottom, ~0–300) are effectively unreachable by random
// configs. Rather than burn the whole FILL_MAX_EXTRA budget chasing them (the bulk of
// generation time), give up once this many consecutive top-ups all land in already-full
// buckets — i.e. the remaining sparse buckets aren't being reached.
var FILL_GIVE_UP = 400;

function bucketIndex(rating) {
	var clamped = Math.max(ELO_MIN, Math.min(ELO_MAX - 1, rating));
	return Math.floor((clamped - ELO_MIN) / BUCKET);
}
var NUM_BUCKETS = Math.ceil((ELO_MAX - ELO_MIN) / BUCKET);

function ts() { return new Date().toISOString(); }
function log(msg) { console.log("[" + ts() + "] " + msg); }

// --- 1. boards ---
log("Generating " + BOARDS + " no-guess boards per density (" + bench.DENSITIES.join(", ") + ") on " + bench.ROWS + "x" + bench.COLS + " ...");
var templatesByDensity = {};
bench.DENSITIES.forEach(function(d) {
	var key = bench.densityKey(d);
	templatesByDensity[key] = bench.makeTemplates(d, BOARDS, bench.ROWS, bench.COLS);
	log("  density " + key + ": " + templatesByDensity[key].length + " boards (" + bench.minesFor(d, bench.ROWS, bench.COLS) + " mines)");
});

// --- 2. calibration ---
log("Calibrating solve-time -> Elo against configForElo grid (" + CAL_SAMPLES + " samples x " + bench.ELO_GRID.length + " grid points x 3 densities)...");
var curves = bench.calibrate(templatesByDensity, { samples: CAL_SAMPLES });
bench.DENSITIES.forEach(function(d) {
	var key = bench.densityKey(d);
	var c = curves[key];
	log("  density " + key + ": " + c[0][0] + "Elo=" + Math.round(c[0][1]) + "ms  ..  " + c[c.length - 1][0] + "Elo=" + Math.round(c[c.length - 1][1]) + "ms");
});

function bucketCounts(list) {
	var counts = new Array(NUM_BUCKETS).fill(0);
	list.forEach(function(b) { counts[bucketIndex(b.rating)]++; });
	return counts;
}

// Spawn the worker pool, handing each worker the shared boards + curves once.
function spawnWorkers() {
	var ws = [];
	for (var i = 0; i < NUM_WORKERS; i++) {
		ws.push(new Worker(path.join(__dirname, "bench-worker.js"), {
			workerData: { templatesByDensity: templatesByDensity, curves: curves }
		}));
	}
	return ws;
}

// Benchmark `count` random bots spread evenly across the pool; resolves with all entries.
function benchmarkAcross(workers, count) {
	var per = Math.ceil(count / workers.length);
	var remaining = count;
	return Promise.all(workers.map(function(w) {
		var n = Math.min(per, Math.max(0, remaining));
		remaining -= n;
		if (n <= 0) return Promise.resolve([]);
		return new Promise(function(resolve, reject) {
			w.once("message", resolve);
			w.once("error", reject);
			w.postMessage({ count: n });
		});
	})).then(function(chunks) { return [].concat.apply([], chunks); });
}

// --- 3+4. benchmark + coverage fill, fanned across worker threads ---
(async function main() {
	var workers = spawnWorkers();
	log("Benchmarking " + POOL_SIZE + " random bots across " + NUM_WORKERS + " workers...");
	var bots = await benchmarkAcross(workers, POOL_SIZE);
	log("  " + bots.length + " benchmarked");

	// Top up sparse Elo buckets in parallel rounds, keeping only bots that land in a
	// still-sparse bucket. Give up once a run of top-ups reaches no sparse bucket — the
	// remainder (mostly the very bottom) is unreachable by random configs.
	var fillCounts = bucketCounts(bots);
	function anySparse() {
		for (var b = 0; b < NUM_BUCKETS; b++) if (fillCounts[b] < MIN_PER_BUCKET) return true;
		return false;
	}
	log("Topping up sparse Elo buckets (target >=" + MIN_PER_BUCKET + " per " + BUCKET + "-pt bucket)...");
	var extra = 0, sinceProgress = 0;
	var FILL_BATCH = NUM_WORKERS * 8;
	while (anySparse() && extra < FILL_MAX_EXTRA && sinceProgress < FILL_GIVE_UP) {
		var batch = await benchmarkAcross(workers, FILL_BATCH);
		extra += batch.length;
		var progressed = false;
		batch.forEach(function(bot) {
			var bi = bucketIndex(bot.rating);
			if (fillCounts[bi] < MIN_PER_BUCKET) { bots.push(bot); fillCounts[bi]++; progressed = true; }
		});
		sinceProgress = progressed ? 0 : sinceProgress + batch.length;
	}
	log("  generated " + extra + " extra bots while filling" + (sinceProgress >= FILL_GIVE_UP ? " (gave up on unreachable buckets)" : ""));
	workers.forEach(function(w) { w.terminate(); });

	var stillSparse = [];
	for (var sb = 0; sb < NUM_BUCKETS; sb++) if (fillCounts[sb] < MIN_PER_BUCKET) stillSparse.push(sb);
	if (stillSparse.length) {
		log("  note: buckets left below target (unreachable by random configs): " +
			stillSparse.map(function(b) { return (ELO_MIN + b * BUCKET) + "-" + (ELO_MIN + (b + 1) * BUCKET); }).join(", "));
	}

	// Trim overfull buckets (keep the file balanced + bounded).
	var byBucket = {};
	bots.forEach(function(b) { var k = bucketIndex(b.rating); (byBucket[k] || (byBucket[k] = [])).push(b); });
	var trimmed = [], droppedToTrim = 0;
	Object.keys(byBucket).forEach(function(k) {
		var arr = byBucket[k];
		if (arr.length > MAX_PER_BUCKET) { droppedToTrim += arr.length - MAX_PER_BUCKET; arr = arr.slice(0, MAX_PER_BUCKET); }
		trimmed = trimmed.concat(arr);
	});
	if (droppedToTrim) log("  trimmed " + droppedToTrim + " bots from overfull buckets (cap " + MAX_PER_BUCKET + "/bucket)");
	trimmed.sort(function(a, b) { return a.rating - b.rating; });
	bots = trimmed;

	// --- 5. write + report ---
	var out = {
		generatedAt: ts(),
		board: { rows: bench.ROWS, cols: bench.COLS },
		densities: bench.DENSITIES,
		roundMs: bench.ROUND_MS,
		calibration: curves,
		bots: bots
	};
	var outPath = path.join(__dirname, "..", "bots-pool.json");
	fs.writeFileSync(outPath, JSON.stringify(out, null, "\t"));
	log("Wrote " + bots.length + " bots to " + outPath);

	console.log("\nRating distribution:");
	var finalCounts = bucketCounts(bots);
	var maxCount = Math.max.apply(null, finalCounts);
	for (var b2 = 0; b2 < NUM_BUCKETS; b2++) {
		var label = (ELO_MIN + b2 * BUCKET) + "-" + (ELO_MIN + (b2 + 1) * BUCKET);
		var bar = finalCounts[b2] ? "#".repeat(Math.max(1, Math.round(40 * finalCounts[b2] / maxCount))) : "";
		console.log("  " + label.padEnd(11) + String(finalCounts[b2]).padStart(4) + "  " + bar);
	}
	console.log("  total: " + bots.length);
})().catch(function(e) { console.error("generation failed:", e); process.exit(1); });
