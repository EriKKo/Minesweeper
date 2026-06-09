// Combine two (or more) starting-cascade deduction patterns into one start configuration and
// emit them as real, playable puzzles — written to combined-puzzles.json and shown on the
// "Combined puzzles" admin page (which reuses the All-Puzzles card + Analyze modal).
//
// The research question: single openings cap at ~cx 8; can *composing* building blocks at a
// shared seam manufacture a harder deduction? We take small wall patterns and the heavy cx-8
// rings, lay two side by side so their unknown rings either share a seam column or sit a gap
// apart, and let the real CSP analyzer rate the result.
//
// Each combination is built as an abstract clue board (block revealed, ring unknown, board edge
// = wall), then converted to a REAL board: we solve for one mine arrangement consistent with the
// clues, so the puzzle has concrete { rows, cols, mines, revealed } and plugs straight into the
// existing puzzle pipeline (buildLearnPuzzle, servePuzzleAnalyze, PuzzleGenerator scoring).
//
// Run: node scripts/combine-patterns.js   ->   writes combined-puzzles.json

var fs = require("fs");
var path = require("path");
var SP = require("../src/server/StartPatterns");
var puzzleGen = require("../src/server/PuzzleGenerator");
var CSP = require("../src/server/CSPSolver");
var RingSeed = require("../src/server/RingSeedGenerator");
var BoardLogic = require("../src/common/BoardLogic");
var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN;

function scoreToRating(score) { return (!score || score <= 0) ? 0 : Math.max(0, Math.round(240 * (score - 0.5))); }

var KEY15 = "C1,1:1;C1,2:1;D0,0:S;W0,3;W1,3;W2,3"; // two 1s on a wall -> forces a SAFE  (cx 2.69)
var KEY16 = "C1,1:1;C1,2:2;D0,3:M;W0,0;W1,0;W2,0"; // a 1 and a 2 on a wall -> forces a MINE (cx 2.69)

// Find the clue tuple for a 3x3 top-wall position that yields the target canonical pattern.
function findClues(targetKey) {
	var geo = SP.geometry(3, 3, { top: true });
	var poss = SP.enumeratePositions(geo);
	for (var i = 0; i < poss.length; i++) {
		var pat = SP.extractPattern(geo, poss[i].clues);
		if (pat && pat.key === targetKey) return { geo: geo, clues: poss[i].clues };
	}
	return null;
}

// The corners4-edges2 clue ring for an open H×W block (corners see 5 ring cells -> 4, edges -> 2).
function ringClues(H, W) {
	var geo = SP.geometry(H, W);
	return { geo: geo, clues: geo.degrees.map(function(deg) { return deg === 5 ? 4 : 2; }) };
}

// (board,state) for one position: block revealed (boundary clues + interior 0s), ring UNKNOWN.
function boardState(geo, clues) {
	var board = [], state = [];
	for (var r = 0; r < geo.BR; r++) { board.push(new Array(geo.BC).fill(null)); state.push(new Array(geo.BC).fill(UNKNOWN)); }
	for (var br = geo.r0; br < geo.r0 + geo.H; br++) for (var bc = geo.c0; bc < geo.c0 + geo.W; bc++) { state[br][bc] = KNOWN; board[br][bc] = 0; }
	for (var i = 0; i < geo.boundary.length; i++) board[geo.boundary[i][0]][geo.boundary[i][1]] = clues[i];
	return { board: board, state: state };
}

// Place two (board,state) blocks into one grid, A at col 0 and B shifted right so block B's
// left ring column lands `gap` columns past block A's right ring column. gap=0 -> the two rings
// share a single seam column (they constrain it jointly); gap>0 -> an unknown seam between them.
function mergeBlocks(ga, gb, gap) {
	var BR = Math.max(ga.board.length, gb.board.length);
	var shift = (ga.board[0].length - 1) + gap;
	var BC = shift + gb.board[0].length;
	var board = [], state = [];
	for (var r = 0; r < BR; r++) { board.push(new Array(BC).fill(null)); state.push(new Array(BC).fill(UNKNOWN)); }
	function blit(src, dc) {
		for (var r = 0; r < src.board.length; r++) for (var c = 0; c < src.board[0].length; c++) {
			if (src.state[r][c] !== KNOWN) continue;
			state[r][c + dc] = KNOWN; board[r][c + dc] = src.board[r][c];
		}
	}
	blit(ga, 0); blit(gb, shift);
	return { board: board, state: state };
}

// Solve for ONE mine arrangement over the UNKNOWN cells consistent with every revealed clue
// (each KNOWN clue value == number of mines among its UNKNOWN neighbours; KNOWN cells are safe).
// Backtracking with forward-checking. Returns the mine cell list, or null if unsatisfiable.
function solveMines(board, state) {
	var R = board.length, C = board[0].length;
	var varIdx = {}, vars = [];
	for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
		if (state[r][c] !== KNOWN) { varIdx[r + "," + c] = vars.length; vars.push([r, c]); }
	}
	var constraints = []; // { vars:[idx], need, assigned, remaining }
	for (var r2 = 0; r2 < R; r2++) for (var c2 = 0; c2 < C; c2++) {
		if (state[r2][c2] !== KNOWN) continue;
		var vs = [];
		for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
			if (!dr && !dc) continue;
			var nr = r2 + dr, nc = c2 + dc;
			if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
			var vi = varIdx[nr + "," + nc];
			if (vi !== undefined) vs.push(vi);
		}
		if (vs.length) constraints.push({ vars: vs, need: board[r2][c2], assigned: 0, remaining: vs.length });
	}
	var byVar = vars.map(function() { return []; });
	constraints.forEach(function(con, ci) { con.vars.forEach(function(vi) { byVar[vi].push(ci); }); });

	var assign = new Array(vars.length).fill(0);
	function feasible(ci) { var con = constraints[ci]; return con.assigned <= con.need && con.assigned + con.remaining >= con.need; }
	function bt(i) {
		if (i === vars.length) return constraints.every(function(con) { return con.assigned === con.need; });
		for (var val = 0; val <= 1; val++) {
			assign[i] = val; var ok = true;
			for (var k = 0; k < byVar[i].length; k++) { var con = constraints[byVar[i][k]]; con.assigned += val; con.remaining--; if (!feasible(byVar[i][k])) ok = false; }
			if (ok && bt(i + 1)) return true;
			for (var k2 = 0; k2 < byVar[i].length; k2++) { var con2 = constraints[byVar[i][k2]]; con2.assigned -= val; con2.remaining++; }
		}
		assign[i] = 0;
		return false;
	}
	if (!bt(0)) return null;
	var mines = [];
	for (var v = 0; v < vars.length; v++) if (assign[v]) mines.push(vars[v]);
	return mines;
}

function comparePos(a, b) { return a[0] - b[0] || a[1] - b[1]; }

// Difficulty tier from the hardest deduction's complexity (same bands PuzzleGenerator uses).
// Unlike the pool, a combined board need not be fully no-guess solvable — single small patterns
// only force a cell or two — so we rate by the hardest FORCED move rather than zeroing it out.
function tierFromComplexity(maxC) {
	if (maxC <= 1.5) return 1;
	if (maxC <= 3.0) return 2;
	if (maxC <= 5.0) return 3;
	if (maxC <= 7.0) return 4;
	if (maxC <= 10.0) return 5;
	return 6;
}

// Convert a merged abstract (board,state) into a real, scored puzzle object matching the pool shape.
var nextId = 1;
var unsatisfiable = [];
function makePuzzle(label, group, ms) {
	var rows = ms.board.length, cols = ms.board[0].length;
	var revealed = [];
	for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) if (ms.state[r][c] === KNOWN) revealed.push([r, c]);
	var mines = solveMines(ms.board, ms.state);
	if (!mines) { console.log("  ! " + label + ": no consistent mine layout — patterns conflict at the seam"); unsatisfiable.push({ label: label, group: group }); return null; }
	mines.sort(comparePos);
	var board = puzzleGen.buildBoard(rows, cols, mines);
	var a = puzzleGen.analyzeWithTracking(board, revealed, mines.length);
	var maxC = a.cspMaxComplexity;
	var score = a.complexityScore; // geometric score, computed even for not-fully-solvable boards
	var difficulty = tierFromComplexity(maxC);
	var coveredSafe = rows * cols - mines.length - revealed.length;
	var p = {
		id: nextId++, label: label, group: group,
		rows: rows, cols: cols, mines: mines, revealed: revealed.slice().sort(comparePos),
		coveredSafe: coveredSafe, difficulty: difficulty, score: score, rating: scoreToRating(score),
		solved: a.solved, cspMethod: a.cspMethod, needsCaseSplit: a.needsCaseSplit,
		cspMaxComplexity: maxC, passes: a.passes
	};
	console.log("  " + label.padEnd(40) + " " + rows + "x" + cols + "  cx " + maxC.toFixed(2)
		+ "  t" + difficulty + "  r" + p.rating + "  " + (a.solved ? "solvable" : "partial ") + "  via " + a.cspMethod);
	return p;
}

// ---- Build the combination set ----
var A = findClues(KEY15), B = findClues(KEY16);
if (!A || !B) { console.error("could not find source positions for the wall patterns"); process.exit(1); }
var bsA = boardState(A.geo, A.clues), bsB = boardState(B.geo, B.clues);
var r33 = ringClues(3, 3), r34 = ringClues(3, 4);
var ring33 = boardState(r33.geo, r33.clues), ring34 = boardState(r34.geo, r34.clues);

var puzzles = [];
function add(p) { if (p) puzzles.push(p); }

console.log("Reference (each pattern alone):");
add(makePuzzle("#15 alone — 1·1 wall → safe", "Reference", bsA));
add(makePuzzle("#16 alone — 1·2 wall → mine", "Reference", bsB));
add(makePuzzle("3×3 corners4-edges2 ring alone", "Reference", ring33));

console.log("\nWall-pattern pairs (#15 ⊕ #16):");
add(makePuzzle("#15 ⊕ #16 — shared seam column", "Wall pair", mergeBlocks(bsA, bsB, 0)));
add(makePuzzle("#15 ⊕ #16 — 1-column gap", "Wall pair", mergeBlocks(bsA, bsB, 1)));
add(makePuzzle("#15 ⊕ #16 — 2-column gap", "Wall pair", mergeBlocks(bsA, bsB, 2)));
add(makePuzzle("#15 ⊕ #15 — shared seam column", "Wall pair", mergeBlocks(bsA, bsA, 0)));
add(makePuzzle("#16 ⊕ #16 — shared seam column", "Wall pair", mergeBlocks(bsB, bsB, 0)));

console.log("\nHeavy cx-8 ring pairs (corners4-edges2):");
add(makePuzzle("two 3×3 cx-8 rings — shared seam", "cx-8 rings", mergeBlocks(ring33, ring33, 0)));
add(makePuzzle("two 3×3 cx-8 rings — 1-column gap", "cx-8 rings", mergeBlocks(ring33, ring33, 1)));
add(makePuzzle("3×3 ⊕ 3×4 cx-8 rings — shared seam", "cx-8 rings", mergeBlocks(ring33, ring34, 0)));

// Ring starts made solvable: take the corners4-edges2 ring, change the fewest clues needed to
// break its two-fold symmetry (one change provably can't — it has exactly 2 solutions), pick the
// hardest reveal-producing change-set, and finish into a full puzzle via the inside-out generator.
console.log("\nRing starts made solvable (perturb fewest clues + inside-out finish):");
[[3, 3], [3, 4]].forEach(function(d) {
	var t0 = Date.now();
	var rp = RingSeed.generateFromRing(d[0], d[1], {});
	var secs = ((Date.now() - t0) / 1000).toFixed(1);
	if (!rp) { console.log("  " + d[0] + "x" + d[1] + " corners4-edges2: no solvable variant found (" + secs + "s)"); return; }
	var chDesc = rp.perturbation.changes.map(function(c) { return c.from + "→" + c.to; }).join(", ");
	rp.id = nextId++;
	rp.group = "Ring → solvable";
	rp.label = d[0] + "×" + d[1] + " corners4-edges2 → solvable (" + rp.perturbation.changes.length + " clues " + chDesc + ", inside-out)";
	puzzles.push(rp);
	console.log("  " + rp.label.padEnd(54) + " " + rp.rows + "x" + rp.cols + "  cx " + rp.cspMaxComplexity.toFixed(2) + "  t" + rp.difficulty + "  r" + rp.rating + "  solvable  (" + secs + "s)");
});

var outPath = path.join(__dirname, "..", "combined-puzzles.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), puzzles: puzzles, unsatisfiable: unsatisfiable }, null, "\t"));
console.log("\nWrote " + puzzles.length + " combined puzzles (" + unsatisfiable.length + " unsatisfiable) to " + outPath);
