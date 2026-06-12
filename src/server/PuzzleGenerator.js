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
var cspSolver = require("./CSPSolver");
var MINE = BoardLogic.MINE;
var KNOWN = BoardLogic.KNOWN;
var UNKNOWN = BoardLogic.UNKNOWN;
var FLAGGED = BoardLogic.FLAGGED;

// Difficulty score: sort the solve's per-move complexities high→low and sum c / SCORE_X^rank.
// The hardest move counts fully (rank 0); each further hard move adds a geometrically-decaying
// share, so a puzzle that demands several hard deductions scores well above one with a single hard
// move, while a long tail of easy moves saturates (the sum is bounded by c_max · X/(X-1)). This
// replaces the old maxC + totalC/20, which weighted every move equally and let length inflate the
// rating. X = 3.5 caps the multiplier over the hardest move at X/(X-1) ≈ 1.4×.
var SCORE_X = 3.5;
function complexityScore(moves) {
	var comps = (moves || []).map(function(m) { return m.complexity; }).sort(function(a, b) { return b - a; });
	var s = 0;
	for (var k = 0; k < comps.length; k++) s += comps[k] / Math.pow(SCORE_X, k);
	return Math.round(s * 100) / 100;
}

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

	// The pass-based PuzzleSolver loop that used to count techniques here was removed with that module.
	// Per-technique pass counts are no longer tracked (kept at 0 for schema compatibility); maxEnumSize
	// is derived from the CSP analyzer's enum moves below.
	var trivCount = 0, subsetCount = 0, overlapCount = 0, chainCount = 0, enumCount = 0;
	var maxEnumSize = 0;

	var revealedSafe = 0;
	for (var rr = 0; rr < rows; rr++) {
		for (var cc2 = 0; cc2 < cols; cc2++) if (state[rr][cc2] === KNOWN) revealedSafe++;
	}
	var totalSafe = rows * cols - numMines;
	var solved = revealedSafe === totalSafe;

	// The pass-based analyzer above gives us the method classification
	// (which the All Puzzles filter uses). Score, difficulty, and rating
	// now come from the CSP analyzer's max-complexity instead — a more
	// principled measure that tracks the cost of the hardest deduction
	// the player had to do. Run it on a fresh state copy since both
	// analyzers mutate.
	var cspState = new Array(rows);
	for (var rr2 = 0; rr2 < rows; rr2++) {
		cspState[rr2] = new Array(cols);
		for (var cc3 = 0; cc3 < cols; cc3++) cspState[rr2][cc3] = UNKNOWN;
	}
	revealedList.forEach(function(p) { cspState[p[0]][p[1]] = KNOWN; });
	function cspCascade(rrr, ccc) {
		BoardLogic.cascadeReveal(rrr, ccc, rows, cols,
			function(rr3, cc4) { return cspState[rr3][cc4] === UNKNOWN; },
			function(rr3, cc4) { cspState[rr3][cc4] = KNOWN; return false; },
			function(rr3, cc4) { return board[rr3][cc4]; }
		);
	}
	var cspResult = cspSolver.analyzeBoard(board, cspState, { revealCell: cspCascade });
	var maxC = cspResult.maxComplexity;
	var totalC = cspResult.totalComplexity;
	// Solvability comes from the sound CSP analyzer (the only solver now); maxEnumSize from its enum moves.
	solved = cspResult.solved;
	cspResult.moves.forEach(function(mv) { if (mv.componentSize > maxEnumSize) maxEnumSize = mv.componentSize; });
	// Geometric difficulty score (see complexityScore): rewards many hard moves, saturates length.
	// `cscore` is computed regardless of solvability so callers that rate not-fully-solvable boards
	// (e.g. the combined-puzzles experiment) can still surface a difficulty; the pool keeps the
	// convention that an unsolved board scores 0.
	var cscore = complexityScore(cspResult.moves);
	var score = solved ? cscore : 0;
	// Tier bands by max complexity. Each band ~2 wide except the last.
	var difficulty;
	if (!solved) difficulty = 0;
	else if (maxC <= 1.5) difficulty = 1;
	else if (maxC <= 3.0) difficulty = 2;
	else if (maxC <= 5.0) difficulty = 3;
	else if (maxC <= 7.0) difficulty = 4;
	else if (maxC <= 10.0) difficulty = 5;
	else difficulty = 6;

	// Highest-tier CSP op the analyzer needed for this puzzle.
	// Ordering: trivial < subset < union < intersect < case < enum.
	// analyzeBoard returns BUNDLED moves whose `method` field already carries the op (trivial/subset/
	// union/intersect/case/enum) — earlier code read `mv.action`, which bundling drops, so every case/enum
	// move was silently mislabeled as a lesser op and needsCaseSplit was always false.
	var methodOrder = { trivial: 0, subset: 1, union: 2, intersect: 3, case: 4, enum: 5 };
	var cspMethod = "trivial";
	var needsCaseSplit = false;
	for (var mi = 0; mi < (cspResult.moves || []).length; mi++) {
		var m = cspResult.moves[mi].method || "trivial";
		if (m === "case") needsCaseSplit = true;
		if (methodOrder[m] != null && methodOrder[cspMethod] < methodOrder[m]) cspMethod = m;
	}
	return {
		solved: solved,
		difficulty: difficulty,
		score: score,
		complexityScore: cscore,
		passes: { trivial: trivCount, subset: subsetCount, overlap: overlapCount, chain: chainCount, enum: enumCount },
		maxEnumSize: maxEnumSize,
		needsCaseSplit: needsCaseSplit,
		cspMethod: cspMethod,
		cspMaxComplexity: Math.round(maxC * 10) / 10,
		cspTotalComplexity: Math.round(totalC * 10) / 10
	};
}

exports.generatePuzzles = generatePuzzles;
exports.canonicalKey = canonicalKey;
exports.buildBoard = buildBoard;
exports.complexityScore = complexityScore;
exports.analyzeWithTracking = analyzeWithTracking;
