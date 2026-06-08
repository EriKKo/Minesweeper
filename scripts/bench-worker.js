// Worker for scripts/generate-bot-pool.js. Benchmarking each random bot is independent
// and CPU-bound, so we fan the pool out across cores. The shared board set and the
// time→Elo calibration curves are passed once via workerData; each "benchmark N bots"
// message generates N random configs, rates them on those boards, and returns the
// finished pool entries.

var path = require("path");
var workerThreads = require("worker_threads");
var parentPort = workerThreads.parentPort;
var workerData = workerThreads.workerData;

var bench = require(path.join(__dirname, "..", "src", "server", "BotBench"));
var botPlayer = require(path.join(__dirname, "..", "src", "server", "BotPlayer"));

var templatesByDensity = workerData.templatesByDensity;
var curves = workerData.curves;

parentPort.on("message", function(msg) {
	if (!msg || typeof msg.count !== "number") return;
	var out = [];
	for (var i = 0; i < msg.count; i++) {
		var cfg = botPlayer.randomBotConfig();
		var res = bench.ratingForConfig(cfg, templatesByDensity, curves);
		out.push({
			speedMs: cfg.speedMs,
			difficultyMs: cfg.difficultyMs,
			distanceMult: cfg.distanceMult,
			maxDifficulty: cfg.maxDifficulty,
			mistakeRate: cfg.mistakeRate,
			chordRate: cfg.chordRate,
			times: res.times,
			ratings: res.ratings,
			rating: res.rating
		});
	}
	parentPort.postMessage(out);
});
