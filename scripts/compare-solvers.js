// Compare the existing pass-based solver against the new CSP solver on
// the current puzzle pool. Reports: how many puzzles each solver fully
// solves, distribution of CSP max-complexity vs existing tier, and which
// puzzles differ.
//
// Run: node scripts/compare-solvers.js

var path = require("path");
process.env.RANKED_DB = process.env.RANKED_DB || path.join(__dirname, "..", "ranked.db");

var db = require("../src/server/db");
var puzzleGen = require("../src/server/PuzzleGenerator");
var csp = require("../src/server/CSPSolver");
var BoardLogic = require("../src/common/BoardLogic");
var K = BoardLogic.KNOWN, U = BoardLogic.UNKNOWN;

function stateForPuzzle(p) {
	var state = [];
	for (var r = 0; r < p.rows; r++) {
		state.push([]);
		for (var c = 0; c < p.cols; c++) state[r].push(U);
	}
	p.revealed.forEach(function(rc) { state[rc[0]][rc[1]] = K; });
	return state;
}

function cascadeFor(board, state) {
	var rows = board.length, cols = board[0].length;
	return function(r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			function(rr, cc) { return state[rr][cc] === U; },
			function(rr, cc) { state[rr][cc] = K; return false; },
			function(rr, cc) { return board[rr][cc]; }
		);
	};
}

var pageSize = 200;
var all = [];
for (var page = 0; ; page++) {
	var batch = db.listPuzzles({ pageSize: pageSize, page: page, sort: "asc" });
	if (!batch.length) break;
	for (var i = 0; i < batch.length; i++) all.push(batch[i]);
}
console.log("Pool size:", all.length);

var bins = {}; // bin: existing-tier-or-method -> { count, cspSolved, complexities }
function key(p) {
	if (p.passes.enum > 0) return "enum (tier " + p.difficulty + ")";
	if (p.passes.chain > 0) return "chain";
	if (p.passes.overlap > 0) return "overlap";
	if (p.passes.subset > 0) return "subset";
	return "trivial";
}

var totalStart = Date.now();
all.forEach(function(p) {
	var board = puzzleGen.buildBoard(p.rows, p.cols, p.mines);
	var state = stateForPuzzle(p);
	var t0 = Date.now();
	var result = csp.analyzeBoard(board, state, { revealCell: cascadeFor(board, state) });
	var dt = Date.now() - t0;
	var k = key(p);
	var bin = bins[k] || (bins[k] = { count: 0, solved: 0, complexities: [], totalMs: 0 });
	bin.count++;
	bin.totalMs += dt;
	if (result.solved) {
		bin.solved++;
		bin.complexities.push(result.maxComplexity);
	}
});
var totalDt = Date.now() - totalStart;
console.log("Total time:", totalDt, "ms  (avg " + (totalDt / all.length).toFixed(1) + " ms/puzzle)");
console.log();

function pct(num, den) { return den ? (100 * num / den).toFixed(0) + "%" : "—"; }
function stats(arr) {
	if (!arr.length) return "—";
	arr = arr.slice().sort(function(a, b) { return a - b; });
	var p50 = arr[Math.floor(arr.length * 0.5)];
	var p90 = arr[Math.floor(arr.length * 0.9)];
	return "p50=" + p50 + " p90=" + p90 + " max=" + arr[arr.length - 1];
}

Object.keys(bins).sort().forEach(function(k) {
	var b = bins[k];
	console.log(k.padEnd(20),
		" n=" + String(b.count).padEnd(4),
		" csp-solved=" + (b.solved + "/" + b.count).padEnd(8) + pct(b.solved, b.count),
		" complexity " + stats(b.complexities),
		" avg " + (b.totalMs / b.count).toFixed(1) + " ms");
});
