// Random small-puzzle generator with difficulty classification.
//
// generatePuzzles({ count, rows, cols, ... }) returns up to `count` puzzles
// that pass the filters below. For each random mine layout, we enumerate
// every connected zero-region on the board and emit one candidate puzzle
// per region (since clicking any cell in a zero-region produces the same
// cascade-reveal). One mine layout therefore yields 0..N puzzles, each with
// a distinct visible start. Filters:
//   - cascade reveals at least one cell (no single-cell starts).
//   - at least one covered safe cell remains (otherwise it's not a puzzle).
//   - 100% solvable with no guessing — the solver's ENUM_CAP of 18 cells
//     per frontier component is the real ceiling on active area.
//
// Each returned puzzle carries { rows, cols, mines, revealed, coveredSafe,
// difficulty, passes } so the caller can sort / bucket / display.

var BoardLogic = require("../common/BoardLogic");
var puzzleSolver = require("./PuzzleSolver");
var MINE = BoardLogic.MINE;
var KNOWN = BoardLogic.KNOWN;
var UNKNOWN = BoardLogic.UNKNOWN;
var FLAGGED = BoardLogic.FLAGGED;

function generatePuzzles(opts) {
	opts = opts || {};
	var batchSize = opts.count || 20;
	var targetDiff = (typeof opts.diff === "number" && opts.diff >= 1 && opts.diff <= 6) ? opts.diff : null;
	// Rarer difficulties need more attempts per puzzle — diff-5 ≈ 1.5% of
	// random rolls, diff-4 < 1%. Density-pinned jobs at the extremes (≥30%)
	// also reject most candidates because cascade rarely fires; ≥40% is
	// essentially edge-of-solvable so it gets an even bigger budget so the
	// rare success can be found within a single batch.
	var density = typeof opts.density === "number" ? opts.density : null;
	var attemptsPerPuzzle = opts.attempts
		|| (targetDiff ? 200
			: density != null && density >= 0.40 ? 500
			: density != null ? 100
			: 25);
	var totalAttemptBudget = batchSize * attemptsPerPuzzle;
	var puzzles = [];
	var attempts = 0;
	while (puzzles.length < batchSize && attempts < totalAttemptBudget) {
		attempts++;
		var candidates = tryGenerateLayout(opts);
		for (var i = 0; i < candidates.length; i++) {
			var p = candidates[i];
			if (targetDiff != null && p.difficulty !== targetDiff) continue;
			puzzles.push(p);
			if (puzzles.length >= batchSize) break;
		}
	}
	return puzzles;
}

// Generate ONE random mine layout and return every distinct cascade-puzzle
// it produces. A "distinct cascade" is one starting cell per connected
// zero-region — clicking any cell within a region produces the identical
// reveal set, so we only emit one puzzle per region.
function tryGenerateLayout(opts) {
	var rows = opts.rows || randInt(4, 8);
	var cols = opts.cols || randInt(4, 8);
	// Vary mine density across attempts — sparse boards generate easy diff-1
	// puzzles; denser boards (more constraints linking each frontier cell)
	// are where the harder case-analysis puzzles live. A caller-supplied
	// density gets ±3pp of jitter so consecutive attempts at the same chip
	// aren't all the same board.
	var density;
	if (typeof opts.density === "number") {
		density = opts.density + (Math.random() - 0.5) * 0.06;
		if (density < 0.05) density = 0.05;
		if (density > 0.50) density = 0.50;
	} else {
		density = 0.12 + Math.random() * 0.28; // 0.12 .. 0.40
	}
	var defaultMines = Math.max(2, Math.round(rows * cols * density));
	var mineCount = opts.mineCount || defaultMines;

	var positions = [];
	for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) positions.push([r, c]);
	if (positions.length <= mineCount) return [];
	shuffle(positions);
	var mines = positions.slice(0, mineCount).sort(comparePos);
	var board = buildBoard(rows, cols, mines);

	var zeroRegions = findZeroRegions(board);
	if (zeroRegions.length === 0) return [];

	var totalSafe = rows * cols - mines.length;
	var out = [];
	for (var z = 0; z < zeroRegions.length; z++) {
		var revealed = cascadeFrom(board, zeroRegions[z][0]);
		var coveredSafe = totalSafe - revealed.length;
		if (coveredSafe < 1) continue;
		var analysis = analyzeWithTracking(board, revealed, mines.length);
		if (!analysis.solved) continue;
		var puzzle = {
			rows: rows,
			cols: cols,
			mines: mines,
			revealed: revealed.slice().sort(comparePos),
			coveredSafe: coveredSafe,
			difficulty: analysis.difficulty,
			score: analysis.score,
			passes: analysis.passes,
			maxEnumSize: analysis.maxEnumSize || 0
		};
		puzzle.key = canonicalKey(puzzle);
		out.push(puzzle);
	}
	return out;
}

function findZeroRegions(board) {
	var rows = board.length, cols = board[0].length;
	var seen = {};
	var regions = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (board[r][c] !== 0 || seen[r + "," + c]) continue;
			var comp = [];
			var stack = [[r, c]];
			while (stack.length) {
				var p = stack.pop();
				var key = p[0] + "," + p[1];
				if (seen[key]) continue;
				if (board[p[0]][p[1]] !== 0) continue;
				seen[key] = true;
				comp.push(p);
				BoardLogic.forEachNeighbour(p[0], p[1], rows, cols, function(nr, nc) {
					if (!seen[nr + "," + nc] && board[nr][nc] === 0) stack.push([nr, nc]);
				});
			}
			if (comp.length) regions.push(comp);
		}
	}
	return regions;
}

// Canonical fingerprint: lex-min over the 8 dihedral symmetries (4 rotations
// × {identity, mirror}). Each cell is 'M' (mine), 'R' (cascade-revealed), or
// '.' (covered safe). Two puzzles that differ only by rotation or reflection
// share a key, so the pool can dedupe them without storing both copies.
function canonicalKey(puzzle) {
	var rows = puzzle.rows, cols = puzzle.cols;
	var grid = [];
	for (var r = 0; r < rows; r++) {
		var row = new Array(cols);
		for (var c = 0; c < cols; c++) row[c] = ".";
		grid.push(row);
	}
	puzzle.mines.forEach(function(m) { grid[m[0]][m[1]] = "M"; });
	puzzle.revealed.forEach(function(p) { grid[p[0]][p[1]] = "R"; });

	var best = null;
	var g = grid;
	for (var rot = 0; rot < 4; rot++) {
		var s1 = serializeGrid(g);
		if (best === null || s1 < best) best = s1;
		var s2 = serializeGrid(mirrorGrid(g));
		if (s2 < best) best = s2;
		g = rotateGrid(g);
	}
	return best;
}

function serializeGrid(g) {
	var rows = g.length, cols = g[0].length;
	var lines = new Array(rows);
	for (var r = 0; r < rows; r++) lines[r] = g[r].join("");
	return rows + "x" + cols + ":" + lines.join("/");
}

function rotateGrid(g) {
	var rows = g.length, cols = g[0].length;
	var out = new Array(cols);
	for (var c = 0; c < cols; c++) {
		var row = new Array(rows);
		for (var r = 0; r < rows; r++) row[r] = g[rows - 1 - r][c];
		out[c] = row;
	}
	return out;
}

function mirrorGrid(g) {
	var out = new Array(g.length);
	for (var r = 0; r < g.length; r++) out[r] = g[r].slice().reverse();
	return out;
}

function comparePos(a, b) { return a[0] - b[0] || a[1] - b[1]; }

function shuffle(arr) {
	for (var i = arr.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
	}
	return arr;
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function buildBoard(rows, cols, mines) {
	var board = [];
	for (var r = 0; r < rows; r++) board[r] = new Array(cols).fill(0);
	mines.forEach(function(m) { board[m[0]][m[1]] = MINE; });
	for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
		if (board[r][c] === MINE) continue;
		var cnt = 0;
		BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
			if (board[nr][nc] === MINE) cnt++;
		});
		board[r][c] = cnt;
	}
	return board;
}

function cascadeFrom(board, start) {
	var rows = board.length, cols = board[0].length;
	var seen = {};
	var revealed = [];
	BoardLogic.cascadeReveal(start[0], start[1], rows, cols,
		function(r, c) { return !seen[r + "," + c] && board[r][c] !== MINE; },
		function(r, c) {
			seen[r + "," + c] = true;
			revealed.push([r, c]);
			return false;
		},
		function(r, c) { return board[r][c]; }
	);
	return revealed;
}

// Per-pass tracking solver. Mirrors NoGuessGenerator.analyzeSolvability but
// adds a subset-rule pass between trivial and enum, and tracks how each
// pass progressed so we can pick a finer difficulty level.
//
// Pass hierarchy (cheapest → most expensive):
//   trivialPass — forced mines (board - km == |unk|) and satisfied clear
//                 (board == km). Pure counting on one clue at a time.
//   subsetPass  — for each pair of revealed clue cells A, B with A's covered
//                 candidates ⊆ B's, derive a sub-constraint on B's extras.
//                 If A's remaining mine count == B's, extras are all safe;
//                 if (B - A) == |extras|, extras are all mines.
//   enumPass    — brute-force enumeration over each independent frontier
//                 component (catches 1-2-1 patterns, multi-clue chains,
//                 case analysis). Capped at ENUM_CAP variables per component.
//
// Difficulty derived from the trace. Counts per pass + the largest enum
// component size encountered (`maxEnumSize`). The enum component size maps
// directly to "how many cells did you have to mentally test together" —
// the backtracking depth that humans perceive as hard.
//   1 — only trivial.
//   2 — exactly one subset deduction (small non-trivial step).
//   3 — chain of subset deductions (subsetCount ≥ 2).
//   4 — case analysis on 2–4 frontier cells (light backtracking — "what if
//       this one cell is a mine?").
//   5 — case analysis on 5–6 frontier cells (medium backtracking — chain
//       reasoning over multiple coupled cells).
//   6 — case analysis on ≥ 7 frontier cells OR multiple enum passes
//       (deep backtracking — long inference chains).
//
// If the puzzle isn't fully solved by these passes, the frontier was too
// big to enumerate (>ENUM_CAP=18 cells) OR the puzzle genuinely needs a
// guess. Both cases get rejected upstream — those puzzles are never shown.

function analyzeWithTracking(board, revealedList, numMines) {
	var rows = board.length, cols = board[0].length;
	// Build the standard state grid the shared solver operates on.
	var state = new Array(rows);
	for (var r = 0; r < rows; r++) {
		state[r] = new Array(cols);
		for (var c = 0; c < cols; c++) state[r][c] = UNKNOWN;
	}
	revealedList.forEach(function(p) { state[p[0]][p[1]] = KNOWN; });

	// Cascade-reveal helper passed into each apply* pass: when a safe cell
	// is determined, open it and its zero-neighbours just like the player's
	// click would. Stops at flagged cells (mineKnown equivalent).
	function cascadeReveal(r, c) {
		BoardLogic.cascadeReveal(r, c, rows, cols,
			function(rr, cc) { return state[rr][cc] === UNKNOWN; },
			function(rr, cc) { state[rr][cc] = KNOWN; return false; },
			function(rr, cc) { return board[rr][cc]; }
		);
	}

	var trivCount = 0, subsetCount = 0, overlapCount = 0, chainCount = 0, enumCount = 0;
	var maxEnumSize = 0;
	while (true) {
		if (puzzleSolver.applyTrivialPass(board, state, cascadeReveal)) { trivCount++; continue; }
		if (puzzleSolver.applySubsetPass(board, state, cascadeReveal))  { subsetCount++; continue; }
		if (puzzleSolver.applyOverlapPass(board, state, cascadeReveal)) { overlapCount++; continue; }
		if (puzzleSolver.applyChainPass(board, state, cascadeReveal))   { chainCount++; continue; }
		var enumResult = puzzleSolver.applyEnumPass(board, state, cascadeReveal);
		if (enumResult.progress) {
			enumCount++;
			if (enumResult.maxComponentSize > maxEnumSize) maxEnumSize = enumResult.maxComponentSize;
			continue;
		}
		break;
	}

	var revealedSafe = 0;
	for (var rr = 0; rr < rows; rr++) {
		for (var cc2 = 0; cc2 < cols; cc2++) if (state[rr][cc2] === KNOWN) revealedSafe++;
	}
	var totalSafe = rows * cols - numMines;
	var solved = revealedSafe === totalSafe;

	// Tiering: trivial (1) → subset (2/3) → overlap (3/4) → chain (4/5) → enum (4–6).
	// Chain steps are visibly harder than overlap for humans (you have to
	// see two sub-clues feeding a super-clue at once), so a single chain
	// step is already tier 4 and two chains push to tier 5.
	var difficulty;
	if (!solved) difficulty = 0;
	else if (enumCount >= 2 || maxEnumSize >= 7) difficulty = 6;
	else if (maxEnumSize >= 5) difficulty = 5;
	else if (chainCount >= 2) difficulty = 5;
	else if (enumCount === 1) difficulty = 4;
	else if (chainCount === 1) difficulty = 4;
	else if (overlapCount >= 2) difficulty = 4;
	else if (overlapCount === 1) difficulty = 3;
	else if (subsetCount >= 2) difficulty = 3;
	else if (subsetCount === 1) difficulty = 2;
	else difficulty = 1;

	// Continuous difficulty score (~1.0 .. ~10.0). Trivial chains contribute a
	// small bonus capped just below the first subset step (1.8) so a longer
	// trivial chain rates higher than a single click but never crosses into
	// "real deduction" territory. The non-trivial steps + hardest enum
	// component dominate everything past that. Tiers:
	//   1.0       one trivial step (or zero work)
	//   1.0 → 1.7 trivial chain, asymptotic
	//   1.8 / 2.6 / 3.4 …    +0.8 per subset step
	//   ~3.3      enum on 3 cells
	//   ~5.5      enum on 5 cells
	//   ~8.0      enum on 7 cells
	//   ~10+      enum ≥ 9 cells
	// Overlap weighted higher than subset: pair-of-clue constraint subtraction
	// is harder for humans to spot than a clean subset, even though the pass
	// is structurally similar. Lifts overlap-needing puzzles into the
	// 1100–1500 rating band so the Advanced tier actually has supply.
	var trivBonus = Math.min(0.7, 0.1 * Math.max(0, trivCount - 1));
	var score = 1.0
		+ trivBonus
		+ 0.8 * subsetCount
		+ 1.8 * overlapCount
		+ 3.4 * chainCount
		+ 0.8 * enumCount
		+ (maxEnumSize > 1 ? 0.6 * Math.pow(maxEnumSize - 1, 1.3) : 0);
	if (!solved) score = 0;
	score = Math.round(score * 10) / 10;

	return {
		solved: solved,
		difficulty: difficulty,
		score: score,
		passes: { trivial: trivCount, subset: subsetCount, overlap: overlapCount, chain: chainCount, enum: enumCount },
		maxEnumSize: maxEnumSize
	};
}

exports.generatePuzzles = generatePuzzles;
exports.canonicalKey = canonicalKey;
exports.buildBoard = buildBoard;
exports.analyzeWithTracking = analyzeWithTracking;
