#!/usr/bin/env node
// Marathon/Nightmare board generator: long, dense, fully no-guess-solvable boards for the solo
// campaign — "a lot of medium-difficulty moves", not rare genius-level ones. Stored in the same
// `puzzles` table as the curriculum puzzle pool, tagged source="marathon" and browsable/playable
// from the admin "Marathon boards" page (/admin/marathon-boards).
//
// Method (hill-climb): start from a random board verified fully no-guess-solvable (the same
// generate-and-test approach NoGuessGenerator/racing already uses), then repeatedly find the
// WEAKEST region (least total deduction complexity), re-randomize just that region, and keep the
// swap only if (a) the whole board re-verifies as fully solvable and (b) total complexity went up.
// Every accepted improvement replaces this run's row in place (delete-by-id + re-insert, since the
// canonical_key changes with the mine layout) — so a run that's interrupted mid-way still leaves its
// latest good board saved, never just a console log. Each run adds ONE new row to the pool
// (accumulating across runs, so the admin page grows a real browsable collection over time).
//
// Random search + full-board re-verification per candidate is intentionally NOT cheap — this is
// meant to run offline (like the bot-pool/puzzle-pool generators), not live. Budget it with
// TIME_BUDGET_MS.
//
//   node scripts/generate-marathon-boards.js
//   ROWS=30 COLS=40 DENSITY=0.2 REGION_H=6 REGION_W=6 TRIALS_PER_REGION=12 TIME_BUDGET_MS=120000 \
//     node scripts/generate-marathon-boards.js

var csp = require("../src/server/engine/CSPSolver");
var puzzleGen = require("../src/server/engine/PuzzleGenerator");
var db = require("../src/server/db");
var BoardLogic = require("../src/common/BoardLogic");
var UNKNOWN = BoardLogic.UNKNOWN, KNOWN = BoardLogic.KNOWN, MINE = BoardLogic.MINE;

var ROWS = parseInt(process.env.ROWS, 10) || 24;
var COLS = parseInt(process.env.COLS, 10) || 30;
var DENSITY = parseFloat(process.env.DENSITY) || 0.20;
var REGION_H = parseInt(process.env.REGION_H, 10) || 6;
var REGION_W = parseInt(process.env.REGION_W, 10) || 6;
var TRIALS_PER_REGION = parseInt(process.env.TRIALS_PER_REGION, 10) || 12;
var TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MS, 10) || 120000;
// Complexity cap for the CSP solver during generation — kept below the case-split threshold (8) so
// generation stays fast (a full case-split re-solve costs orders of magnitude more per candidate).
// "Marathon" boards are meant to be long and dense, not case-split-hard (see Nightmare+ follow-up).
var MAX_COMPLEXITY = parseFloat(process.env.MAX_COMPLEXITY) || 7;
var SOURCE = process.env.SOURCE || "marathon";
var GEN_METHOD = "hillclimb:" + REGION_H + "x" + REGION_W;

function buildBoardFromMineGrid(isMine, R, C) {
	var board = [];
	for (var r = 0; r < R; r++) board.push(new Array(C).fill(0));
	for (var r2 = 0; r2 < R; r2++) {
		for (var c = 0; c < C; c++) {
			if (isMine[r2][c]) { board[r2][c] = MINE; continue; }
			var n = 0;
			for (var dr = -1; dr <= 1; dr++) {
				for (var dc = -1; dc <= 1; dc++) {
					if (!dr && !dc) continue;
					var nr = r2 + dr, nc = c + dc;
					if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
					if (isMine[nr][nc]) n++;
				}
			}
			board[r2][c] = n;
		}
	}
	return board;
}

function randomFillRegion(isMine, r0, c0, sh, sw, density) {
	for (var r = r0; r < r0 + sh; r++) for (var c = c0; c < c0 + sw; c++) isMine[r][c] = Math.random() < density;
}

function clearSafeZone(isMine, R, C, startR, startC, radius) {
	for (var r = startR - radius; r <= startR + radius; r++) {
		for (var c = startC - radius; c <= startC + radius; c++) {
			if (r >= 0 && c >= 0 && r < R && c < C) isMine[r][c] = false;
		}
	}
}

function analyzeFull(board, R, C, startR, startC, maxComplexity) {
	var state = [];
	for (var r = 0; r < R; r++) state.push(new Array(C).fill(UNKNOWN));
	// Reports back every cell this call revealed (including anything cascaded), so analyzeBoard can
	// skip its full-board diff scan and go straight to the cells that actually changed.
	function cascade(rr, cc) {
		var touched = [];
		BoardLogic.cascadeReveal(rr, cc, R, C,
			function(a, b) { return state[a][b] === UNKNOWN; },
			function(a, b) { state[a][b] = KNOWN; touched.push([a, b]); return false; },
			function(a, b) { return board[a][b]; });
		return touched;
	}
	cascade(startR, startC);
	return csp.analyzeBoard(board, state, { revealCell: cascade, maxComplexity: maxComplexity });
}

function generateValidBoard(R, C, density, startR, startC, maxComplexity, maxTries) {
	for (var i = 0; i < maxTries; i++) {
		var isMine = [];
		for (var r = 0; r < R; r++) isMine.push(new Array(C).fill(false));
		randomFillRegion(isMine, 0, 0, R, C, density);
		clearSafeZone(isMine, R, C, startR, startC, 2);
		var board = buildBoardFromMineGrid(isMine, R, C);
		var result = analyzeFull(board, R, C, startR, startC, maxComplexity);
		if (result.solved) return { isMine: isMine, board: board, result: result, tries: i + 1 };
	}
	return null;
}

function regionDifficulties(moves, R, C, regionH, regionW) {
	var regionsC = Math.ceil(C / regionW);
	var diff = new Map();
	moves.forEach(function(mv) {
		var cells = mv.changed || mv.cells || [];
		var seen = new Set();
		cells.forEach(function(rc) {
			var r = rc[0], c = rc[1];
			var key = Math.floor(r / regionH) * regionsC + Math.floor(c / regionW);
			if (seen.has(key)) return;
			seen.add(key);
			diff.set(key, (diff.get(key) || 0) + mv.complexity);
		});
	});
	return diff;
}

// The starting reveal set: the plain click-point cascade (no CSP deduction) — what the player
// actually sees before making any move.
function startingReveal(board, R, C, startR, startC) {
	var seen = {};
	var revealed = [];
	BoardLogic.cascadeReveal(startR, startC, R, C,
		function(r, c) { return !seen[r + "," + c] && board[r][c] !== MINE; },
		function(r, c) { seen[r + "," + c] = true; revealed.push([r, c]); return false; },
		function(r, c) { return board[r][c]; });
	return revealed;
}

// Tier band on max complexity — same bands PuzzleGenerator.analyzeWithTracking uses (kept in sync
// manually here since we score from `result` directly instead of re-analyzing — see below).
function difficultyTier(maxC) {
	if (maxC <= 1.5) return 1;
	if (maxC <= 3.0) return 2;
	if (maxC <= 5.0) return 3;
	if (maxC <= 7.0) return 4;
	if (maxC <= 10.0) return 5;
	return 6;
}
var METHOD_ORDER = { trivial: 0, subset: 1, union: 2, intersect: 3, case: 4, enum: 5 };
function hardestMethod(moves) {
	var m = "trivial", needsCase = false, maxEnumSize = 0;
	moves.forEach(function(mv) {
		var mm = mv.method || "trivial";
		if (mm === "case") needsCase = true;
		if (METHOD_ORDER[mm] != null && METHOD_ORDER[m] < METHOD_ORDER[mm]) m = mm;
		if (mv.componentSize > maxEnumSize) maxEnumSize = mv.componentSize;
	});
	return { method: m, needsCaseSplit: needsCase, maxEnumSize: maxEnumSize };
}

// Persist the current board as THIS run's row — first call inserts, every later call (as the board
// improves) deletes the previous insert and re-inserts, so one run never accumulates more than one
// row no matter how many times it improves, while different runs' rows never touch each other.
//
// Scores from `result` (the capped analysis the hill-climb loop already ran to decide this was an
// improvement) rather than re-analyzing via PuzzleGenerator.analyzeWithTracking — that helper runs
// UNCAPPED, so it can find a different (higher) total complexity than what generation actually
// selected for, which would make the stored numbers inconsistent with the log / with each other.
var currentRowId = null;
function saveBoard(isMine, board, result, R, C, startR, startC, iterations) {
	var mines = [];
	for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) if (isMine[r][c]) mines.push([r, c]);
	var revealed = startingReveal(board, R, C, startR, startC);
	var key = puzzleGen.canonicalKey({ rows: R, cols: C, mines: mines, revealed: revealed });
	var hm = hardestMethod(result.moves);
	var score = puzzleGen.complexityScore(result.moves);

	if (currentRowId != null) db.deletePuzzleById(currentRowId);
	db.insertPuzzle({
		key: key, rows: R, cols: C, mines: mines, revealed: revealed,
		coveredSafe: R * C - mines.length - revealed.length,
		difficulty: difficultyTier(result.maxComplexity), score: score,
		maxEnumSize: hm.maxEnumSize, needsCaseSplit: hm.needsCaseSplit, cspMethod: hm.method,
		maxComplexity: result.maxComplexity, totalComplexity: result.totalComplexity,
		genMethod: GEN_METHOD, genIterations: iterations,
		source: SOURCE
	});
	var row = db.listPuzzles({ source: SOURCE, orderBy: "created_at", sort: "desc", pageSize: 1 })[0];
	currentRowId = row ? row.id : null;
	return currentRowId;
}

function hillClimb() {
	var R = ROWS, C = COLS, density = DENSITY;
	var startR = Math.floor(R / 2), startC = Math.floor(C / 2);
	var t0 = Date.now();

	console.log("Marathon board generator: " + R + "x" + C + " @ " + density + " density, " +
		"regions " + REGION_H + "x" + REGION_W + ", cap=" + MAX_COMPLEXITY + ", budget=" + TIME_BUDGET_MS + "ms\n");

	var start = generateValidBoard(R, C, density, startR, startC, MAX_COMPLEXITY, 200);
	if (!start) { console.log("could not find an initial valid board — try a lower density."); return; }
	var isMine = start.isMine, board = start.board, result = start.result;
	console.log("initial board found on try " + start.tries + ": totalC=" + result.totalComplexity.toFixed(1) +
		" maxC=" + result.maxComplexity.toFixed(2) + " moves=" + result.moves.length);
	var id = saveBoard(isMine, board, result, R, C, startR, startC, 0);
	console.log("  saved as puzzle id " + id);

	var regionsR = Math.ceil(R / REGION_H), regionsC = Math.ceil(C / REGION_W);
	var totalRegions = regionsR * regionsC;
	var accepted = 0, rejectedNoImprovement = 0, iter = 0;

	var startRegionKey = Math.floor(startR / REGION_H) * regionsC + Math.floor(startC / REGION_W);
	var backedOff = new Set([startRegionKey]);
	var convergedStreak = 0;

	while (Date.now() - t0 < TIME_BUDGET_MS) {
		if (backedOff.size >= totalRegions) { convergedStreak++; if (convergedStreak > 3) break; continue; }
		var diffs = regionDifficulties(result.moves, R, C, REGION_H, REGION_W);
		var weakestKey = -1, weakestVal = Infinity;
		for (var k = 0; k < totalRegions; k++) {
			if (backedOff.has(k)) continue;
			var v = diffs.get(k) || 0;
			if (v < weakestVal) { weakestVal = v; weakestKey = k; }
		}
		var sr = Math.floor(weakestKey / regionsC), sc = weakestKey % regionsC;
		var r0 = sr * REGION_H, c0 = sc * REGION_W;
		var sh = Math.min(REGION_H, R - r0), sw = Math.min(REGION_W, C - c0);

		var bestTotalC = result.totalComplexity, bestIsMine = null, bestBoard = null, bestResult = null;
		for (var t = 0; t < TRIALS_PER_REGION; t++) {
			if (Date.now() - t0 > TIME_BUDGET_MS) break;
			var candidate = isMine.map(function(row) { return row.slice(); });
			randomFillRegion(candidate, r0, c0, sh, sw, density);
			clearSafeZone(candidate, R, C, startR, startC, 2);
			var candBoard = buildBoardFromMineGrid(candidate, R, C);
			var candResult = analyzeFull(candBoard, R, C, startR, startC, MAX_COMPLEXITY);
			if (!candResult.solved) continue;
			if (candResult.totalComplexity > bestTotalC) {
				bestTotalC = candResult.totalComplexity;
				bestIsMine = candidate; bestBoard = candBoard; bestResult = candResult;
			}
		}
		if (bestIsMine) {
			isMine = bestIsMine; board = bestBoard; result = bestResult;
			accepted++;
			backedOff = new Set([startRegionKey]);
			convergedStreak = 0;
			id = saveBoard(isMine, board, result, R, C, startR, startC, accepted);
			console.log("  iter " + iter + ": region (" + sr + "," + sc + ") improved -> totalC=" +
				result.totalComplexity.toFixed(1) + " maxC=" + result.maxComplexity.toFixed(2) +
				" [" + (Date.now() - t0) + "ms elapsed] saved as id " + id);
		} else {
			rejectedNoImprovement++;
			backedOff.add(weakestKey);
		}
		iter++;
	}

	console.log("\nstopped after " + iter + " iterations (" + accepted + " accepted, " + rejectedNoImprovement +
		" no-improvement): totalC=" + result.totalComplexity.toFixed(1) + " maxC=" + result.maxComplexity.toFixed(2) +
		" moves=" + result.moves.length + " solved=" + result.solved + " [" + (Date.now() - t0) + "ms] final puzzle id=" + id);
}

hillClimb();
