// Run the CSP analyzer over the entire pool and report the distribution
// of max-complexity and total-complexity by current pass-tag, so we can
// see where each method's complexity range sits and how cleanly the
// boundaries between methods overlap.

var path = require("path");
process.env.RANKED_DB = process.env.RANKED_DB || path.join(__dirname, "..", "ranked.db");

var db = require("../src/server/db");
var puzzleGen = require("../src/server/engine/PuzzleGenerator");
var csp = require("../src/server/engine/CSPSolver");
var BoardLogic = require("../src/common/BoardLogic");
var K = BoardLogic.KNOWN, U = BoardLogic.UNKNOWN;

function stateForPuzzle(p) {
	var state = [];
	for (var r = 0; r < p.rows; r++) { state.push([]); for (var c = 0; c < p.cols; c++) state[r].push(U); }
	p.revealed.forEach(function(rc) { state[rc[0]][rc[1]] = K; });
	return state;
}
function cascadeFor(board, state) {
	var rows = board.length, cols = board[0].length;
	return function(r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			function(rr, cc) { return state[rr][cc] === U; },
			function(rr, cc) { state[rr][cc] = K; return false; },
			function(rr, cc) { return board[rr][cc]; });
	};
}

function tag(p) {
	// The CSP analyzer's hardest-op classification (trivial/subset/union/
	// intersect/case/enum) — replaces the old per-technique pass counts.
	return p.cspMethod || "trivial";
}

var all = [];
for (var page = 0; ; page++) {
	var batch = db.listPuzzles({ pageSize: 200, page: page });
	if (!batch.length) break;
	for (var i = 0; i < batch.length; i++) all.push(batch[i]);
}

var byTag = {};
all.forEach(function(p) {
	var board = puzzleGen.buildBoard(p.rows, p.cols, p.mines);
	var state = stateForPuzzle(p);
	var result = csp.analyzeBoard(board, state, { revealCell: cascadeFor(board, state) });
	var hardestAction = "trivial";
	(result.moves || []).forEach(function(m) {
		if (m.action === "enum") hardestAction = "enum";
		else if (m.action === "case" && hardestAction !== "enum") hardestAction = "case";
	});
	var bucket = byTag[tag(p)] || (byTag[tag(p)] = { maxC: [], totC: [], hardest: {} });
	bucket.maxC.push(result.maxComplexity);
	bucket.totC.push(result.totalComplexity);
	bucket.hardest[hardestAction] = (bucket.hardest[hardestAction] || 0) + 1;
});

function pcts(arr) {
	arr = arr.slice().sort(function(a, b) { return a - b; });
	function q(p) { return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]; }
	return "min=" + arr[0].toFixed(1) + " p25=" + q(0.25).toFixed(1) + " med=" + q(0.5).toFixed(1) + " p75=" + q(0.75).toFixed(1) + " p90=" + q(0.9).toFixed(1) + " max=" + arr[arr.length - 1].toFixed(1);
}

console.log("CSP complexity by current pass-tag:");
var order = ["trivial", "subset", "overlap", "chain", "enum"];
order.forEach(function(t) {
	if (!byTag[t]) return;
	var b = byTag[t];
	console.log("\n[" + t + "] n=" + b.maxC.length);
	console.log("  max-cx:  " + pcts(b.maxC));
	console.log("  tot-cx:  " + pcts(b.totC));
	console.log("  hardest method:  " + JSON.stringify(b.hardest));
});

// Overall histogram of max-complexity by bins.
console.log("\nMax-complexity histogram across pool:");
var bins = {};
all.forEach(function(p, idx) {
	// re-run using stored result above? quicker to just look at the bucket
});
// Use sums we already computed
var all_maxC = [];
order.forEach(function(t) { if (byTag[t]) all_maxC = all_maxC.concat(byTag[t].maxC); });
all_maxC.sort(function(a, b) { return a - b; });
var bands = [0, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 8, 10, 15, 25, 100];
for (var b = 0; b < bands.length - 1; b++) {
	var lo = bands[b], hi = bands[b + 1];
	var n = all_maxC.filter(function(x) { return x >= lo && x < hi; }).length;
	if (n) console.log("  " + lo.toString().padStart(4) + " ≤ c < " + hi.toString().padEnd(5) + " " + n);
}
