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
var path = require("path");
var botPlayer = require("../src/server/BotPlayer");
var bench = require("../src/server/BotBench");

var POOL_SIZE = parseInt(process.env.POOL_SIZE, 10) || 1200;
var BOARDS = parseInt(process.env.BOARDS, 10) || 24;       // boards per density (shared by all bots)
var CAL_SAMPLES = parseInt(process.env.CAL_SAMPLES, 10) || 6; // configForElo samples per grid point

var ELO_MIN = 600, ELO_MAX = 1800, BUCKET = 100;
var MIN_PER_BUCKET = 8, MAX_PER_BUCKET = 40;
var FILL_MAX_EXTRA = POOL_SIZE * 3; // cap on top-up generation so we can't loop forever

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

// --- helper: benchmark one random config into a pool entry ---
function benchmarkRandomBot() {
	var config = botPlayer.randomBotConfig();
	var res = bench.ratingForConfig(config, templatesByDensity, curves);
	return {
		speedMs: config.speedMs,
		mistakeRate: Math.round(config.mistakeRate * 10000) / 10000,
		chordRate: Math.round(config.chordRate * 1000) / 1000,
		maxTier: config.maxTier,
		times: res.times,
		ratings: res.ratings,
		rating: res.rating
	};
}

// --- 3. benchmark the main batch ---
log("Benchmarking " + POOL_SIZE + " random bots...");
var bots = [];
for (var i = 0; i < POOL_SIZE; i++) {
	bots.push(benchmarkRandomBot());
	if ((i + 1) % 100 === 0) log("  " + (i + 1) + "/" + POOL_SIZE + " benchmarked");
}

// --- 4. coverage: top up sparse buckets, then trim overfull ones ---
function bucketCounts(list) {
	var counts = new Array(NUM_BUCKETS).fill(0);
	list.forEach(function(b) { counts[bucketIndex(b.rating)]++; });
	return counts;
}

var extra = 0;
function sparseBuckets() {
	var counts = bucketCounts(bots);
	var sparse = [];
	for (var b = 0; b < NUM_BUCKETS; b++) if (counts[b] < MIN_PER_BUCKET) sparse.push(b);
	return sparse;
}
log("Topping up sparse Elo buckets (target >=" + MIN_PER_BUCKET + " per " + BUCKET + "-pt bucket)...");
while (sparseBuckets().length && extra < FILL_MAX_EXTRA) {
	var bot = benchmarkRandomBot();
	var counts = bucketCounts(bots);
	// Only keep top-ups that land in a still-sparse bucket, so we converge instead
	// of just re-padding the dense middle of the distribution.
	if (counts[bucketIndex(bot.rating)] < MIN_PER_BUCKET) bots.push(bot);
	extra++;
}
log("  generated " + extra + " extra bots while filling");
var stillSparse = sparseBuckets();
if (stillSparse.length) {
	log("  WARNING: buckets still below target after " + FILL_MAX_EXTRA + " extra tries: " +
		stillSparse.map(function(b) { return (ELO_MIN + b * BUCKET) + "-" + (ELO_MIN + (b + 1) * BUCKET); }).join(", "));
}

// Trim overfull buckets (keep file balanced + bounded).
var byBucket = {};
bots.forEach(function(b) {
	var k = bucketIndex(b.rating);
	(byBucket[k] || (byBucket[k] = [])).push(b);
});
var trimmed = [];
var droppedToTrim = 0;
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
for (var b = 0; b < NUM_BUCKETS; b++) {
	var label = (ELO_MIN + b * BUCKET) + "-" + (ELO_MIN + (b + 1) * BUCKET);
	var bar = finalCounts[b] ? "#".repeat(Math.max(1, Math.round(40 * finalCounts[b] / maxCount))) : "";
	console.log("  " + label.padEnd(11) + String(finalCounts[b]).padStart(4) + "  " + bar);
}
console.log("  total: " + bots.length);
