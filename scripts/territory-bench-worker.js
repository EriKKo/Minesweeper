// Worker for scripts/calibrate-territory.js. Clearing a territory board with a bot is CPU-bound and
// per-config independent, so we fan it across cores. The shared board set is passed once via
// workerData; each message carries a batch of configs and gets back each config's mean clear time
// (ms) over those boards. The parent owns the curve-building and time->Elo mapping.

var path = require("path");
var workerThreads = require("worker_threads");
var parentPort = workerThreads.parentPort;
var workerData = workerThreads.workerData;

var tbench = require(path.join(__dirname, "..", "src", "server", "TerritoryBench"));

var boards = workerData.boards;

parentPort.on("message", function(msg) {
	if (!msg || !Array.isArray(msg.configs)) return;
	var out = [];
	for (var i = 0; i < msg.configs.length; i++) out.push(tbench.avgClearTime(msg.configs[i], boards));
	parentPort.postMessage(out);
});
