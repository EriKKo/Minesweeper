// Re-rank the existing filler-bot pool onto the new 0–3000 ladder WITHOUT re-simulating.
//
// Why this works: each pool bot already stores its measured mean solve time per density
// (`times`), and the pool stores the calibration curve those times were rated against. The bot
// AI itself isn't changing — only the Elo ladder is being relabeled (tiers are now 200 wide,
// 0 → 3000, Master from 3000). The old calibration anchored the fastest reference config at
// 1800; the new ladder anchors it at 3000 (see BotBench ELO_MIN/ELO_MAX = 1000/3000), which is a
// pure ×(3000/1800) relabel of the Elo axis. So we relabel the stored curve and re-map each bot's
// stored times through it — exact, and orders of magnitude cheaper than re-benchmarking 530 bots.
//
// Run:  node scripts/rerank-bot-pool.js

var fs = require("fs");
var path = require("path");
var bench = require("../src/server/engine/BotBench");

var poolPath = path.join(__dirname, "..", "bots-pool.json");
var pool = JSON.parse(fs.readFileSync(poolPath, "utf8"));

var NEW_MASTER = 3000;
// The stored curve's top grid point is the fastest reference config — that's our Master anchor.
var densKeys = Object.keys(pool.calibration);
var oldMax = 0;
densKeys.forEach(function(k) {
	var c = pool.calibration[k];
	oldMax = Math.max(oldMax, c[c.length - 1][0]);
});
var SCALE = NEW_MASTER / oldMax;
console.log("Re-ranking " + pool.bots.length + " bots: old top Elo " + oldMax + " → " + NEW_MASTER + " (×" + SCALE.toFixed(4) + ")");

// Relabel the calibration curves: same measured times, Elo axis stretched to the new ladder.
var newCurves = {};
densKeys.forEach(function(k) {
	newCurves[k] = pool.calibration[k].map(function(pt) { return [Math.round(pt[0] * SCALE), pt[1]]; });
});

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// Re-rate every bot from its STORED times against the relabeled curve (no simulation).
pool.bots.forEach(function(b) {
	var sum = 0, n = 0;
	var ratings = {};
	densKeys.forEach(function(k) {
		var ms = b.times && b.times[k] != null ? b.times[k] : null;
		// Fall back to scaling the stored rating if a time is somehow missing.
		var elo = ms != null ? bench.timeToElo(ms, newCurves[k])
			: clamp(Math.round((b.ratings && b.ratings[k] != null ? b.ratings[k] : b.rating) * SCALE), 0, NEW_MASTER);
		ratings[k] = clamp(elo, 0, NEW_MASTER);
		sum += ratings[k]; n++;
	});
	b.ratings = ratings;
	b.rating = Math.round(sum / n);
});

pool.calibration = newCurves;
pool.ladder = { min: 0, master: NEW_MASTER, subTierWidth: 200 };
pool.rerankedNote = "Re-ranked onto the 0–3000 ladder from stored solve times (×" + SCALE.toFixed(4) + "); AI configs unchanged.";

fs.writeFileSync(poolPath, JSON.stringify(pool, null, "\t"));

// Histogram by tier band so we can eyeball the spread.
var rs = pool.bots.map(function(b) { return b.rating; }).sort(function(a, b) { return a - b; });
var bands = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master"];
function band(r) { return r >= 3000 ? "Master" : bands[Math.min(4, Math.floor(r / 600))]; }
var counts = {};
rs.forEach(function(r) { counts[band(r)] = (counts[band(r)] || 0) + 1; });
console.log("New ratings: min " + rs[0] + " / median " + rs[Math.floor(rs.length / 2)] + " / max " + rs[rs.length - 1]);
bands.forEach(function(t) { console.log("  " + t.padEnd(9) + (counts[t] || 0)); });
console.log("Wrote " + poolPath);
