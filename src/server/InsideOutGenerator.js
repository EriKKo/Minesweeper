// Deduction-driven inside-out puzzle generator.
//
// Construction is driven by the analyzer itself: at each step we ask
// the analyzer "what move would you make next given the clues committed
// so far?" The answer is either a forced reveal or a forced flag.
//
//   * For a reveal: we commit the new cell, then choose its clue value
//     by trying every legal candidate and scoring each by the resulting
//     full-solve max-complexity. This is the difficulty knob: a target
//     rating maps to a target complexity and we pick the value whose
//     full-solve complexity lands closest to it.
//   * For a flag: we just record it. Mines are never explicitly placed —
//     they emerge from the analyzer's deductions, so isolated pockets
//     can't form by construction.
//
// The starting state is a single seed cell with clue 0 plus its eight
// neighbours (state=KNOWN, clue uncommitted). The boundary cells get
// their clue values from ambiguity-biased random sampling because the
// deduction-driven search has nothing to score against until at least
// some constraints exist. From there the analyzer takes over.
//
// A construction is kept only if the analyzer reaches a fully-classified
// state (every cell KNOWN or FLAGGED). That guarantees solvability by
// construction — no analyzer-blind-spot puzzles survive.

var BoardLogic = require("../common/BoardLogic");
var puzzleGen = require("./PuzzleGenerator");
var cspSolver = require("./CSPSolver");
var KNOWN = BoardLogic.KNOWN;
var UNKNOWN = BoardLogic.UNKNOWN;
var FLAGGED = BoardLogic.FLAGGED;

function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

function neighbours(rows, cols, r, c) {
	var out = [];
	for (var dr = -1; dr <= 1; dr++) {
		for (var dc = -1; dc <= 1; dc++) {
			if (dr === 0 && dc === 0) continue;
			var nr = r + dr, nc = c + dc;
			if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
			out.push([nr, nc]);
		}
	}
	return out;
}

function cloneState(state) {
	var n = state.length;
	var out = new Array(n);
	for (var i = 0; i < n; i++) out[i] = state[i].slice();
	return out;
}

function makeGrid(rows, cols, val) {
	var g = new Array(rows);
	for (var r = 0; r < rows; r++) g[r] = new Array(cols).fill(val);
	return g;
}

function countNeighboursWithState(rows, cols, state, r, c, target) {
	var n = 0;
	for (var dr = -1; dr <= 1; dr++) {
		for (var dc = -1; dc <= 1; dc++) {
			if (dr === 0 && dc === 0) continue;
			var nr = r + dr, nc = c + dc;
			if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
			if (state[nr][nc] === target) n++;
		}
	}
	return n;
}

function shuffle(a) {
	for (var i = a.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var t = a[i]; a[i] = a[j]; a[j] = t;
	}
}

// Pick a clue value for `cell` using ambiguity-biased binomial sampling.
// Used for the cascade boundary, where no other constraints exist yet,
// so the deduction-driven search has nothing to evaluate against.
function pickClueValueAmbiguous(cell, state, rows, cols, density) {
	var r = cell[0], c = cell[1];
	var flaggedCount = countNeighboursWithState(rows, cols, state, r, c, FLAGGED);
	var unknownCount = countNeighboursWithState(rows, cols, state, r, c, UNKNOWN);
	if (unknownCount <= 0) return flaggedCount;
	// Sample several binomial draws and pick the most-ambiguous (middle).
	var best = 0, bestScore = -1;
	for (var t = 0; t < 5; t++) {
		var k = 0;
		for (var i = 0; i < unknownCount; i++) if (Math.random() < density) k++;
		var halved = Math.max(1, Math.floor(unknownCount / 2));
		var amb = Math.min(k, unknownCount - k) / halved;
		if (amb > bestScore) { bestScore = amb; best = k; }
	}
	return flaggedCount + best;
}

// Run the analyzer on the current partial state and report what it
// could do. Returns { firstMove, maxComplexity } or null. We clone
// state because analyzeBoard mutates it; board is read-only for
// analyzeBoard, so it's safe to share.
function probeAnalyzer(board, state) {
	var stateCopy = cloneState(state);
	var result;
	try {
		result = cspSolver.analyzeBoard(board, stateCopy, {});
	} catch (e) {
		return null;
	}
	if (!result || !result.moves || result.moves.length === 0) return null;
	return { firstMove: result.moves[0], maxComplexity: result.maxComplexity };
}

// Try each legal clue value for `cell` and pick the one whose
// resulting full-solve max-complexity is highest. Scoring on the full
// solve (rather than just the first move) rewards clue values that
// contribute meaningful constraints, not just values that happen to
// produce a trivial deduction immediately. If a target rating is
// provided, prefer values whose max complexity is closest to the
// target's per-move complexity. Returns the picked value (and the
// matching first move for the caller to apply), or null if no
// candidate yields any analyzer progress at all.
function chooseClueValue(cell, board, state, rows, cols, opts) {
	var r = cell[0], c = cell[1];
	var flaggedCount = countNeighboursWithState(rows, cols, state, r, c, FLAGGED);
	var unknownCount = countNeighboursWithState(rows, cols, state, r, c, UNKNOWN);
	var minV = flaggedCount;
	var maxV = flaggedCount + unknownCount;
	if (minV > maxV) return null;

	var targetComplexity = null;
	if (opts && typeof opts.targetRating === "number") {
		// CSP score ≈ rating/240 + 0.5. Approximate "complexity per move"
		// from the target rating.
		targetComplexity = Math.max(0, opts.targetRating / 240 + 0.5);
	}

	var best = null;
	for (var v = minV; v <= maxV; v++) {
		board[r][c] = v;
		var probe = probeAnalyzer(board, state);
		board[r][c] = null;
		if (!probe) continue;
		var maxC = probe.maxComplexity;
		var score;
		if (targetComplexity != null) {
			score = -Math.abs(maxC - targetComplexity);
		} else {
			score = maxC;
		}
		if (!best || score > best.score) best = { v: v, score: score, maxC: maxC };
	}
	if (!best) return null;
	return best.v;
}

// Apply a move from the analyzer to our construction state. Cells
// revealed by the move become KNOWN with their clue values still
// uncommitted (added to `pending`); cells flagged become FLAGGED with
// board=-1.
function applyMove(move, board, state, pending) {
	if (!move) return;
	if (move.action === "reveal") {
		var cells = move.cells || [];
		for (var i = 0; i < cells.length; i++) {
			var c = cells[i];
			if (state[c[0]][c[1]] !== UNKNOWN) continue;
			state[c[0]][c[1]] = KNOWN;
			pending.push(c);
		}
	} else if (move.action === "flag") {
		var fcells = move.cells || [];
		for (var j = 0; j < fcells.length; j++) {
			var c2 = fcells[j];
			if (state[c2[0]][c2[1]] !== UNKNOWN) continue;
			state[c2[0]][c2[1]] = FLAGGED;
			board[c2[0]][c2[1]] = -1;
		}
	} else if (move.action === "case") {
		// Case-split move: revealed[] and flagged[] are separate.
		var revs = move.revealed || [];
		for (var k = 0; k < revs.length; k++) {
			var rc = revs[k];
			if (state[rc[0]][rc[1]] !== UNKNOWN) continue;
			state[rc[0]][rc[1]] = KNOWN;
			pending.push(rc);
		}
		var fls = move.flagged || [];
		for (var m = 0; m < fls.length; m++) {
			var fc = fls[m];
			if (state[fc[0]][fc[1]] !== UNKNOWN) continue;
			state[fc[0]][fc[1]] = FLAGGED;
			board[fc[0]][fc[1]] = -1;
		}
	}
}

// Grow a random connected cascade of `targetSize` clue=0 cells starting
// from somewhere on the board. Each new cell is picked at random from
// the current cascade's not-yet-included neighbours. The cascade can
// touch board edges. Returns the list of cells in the cascade (the
// caller derives the boundary from there).
function growCascade(rows, cols, targetSize) {
	var sr = randInt(0, rows - 1);
	var sc = randInt(0, cols - 1);
	var seen = {};
	seen[sr + "," + sc] = true;
	var cascade = [[sr, sc]];
	while (cascade.length < targetSize) {
		var pool = [];
		var poolSeen = {};
		for (var i = 0; i < cascade.length; i++) {
			var ns = neighbours(rows, cols, cascade[i][0], cascade[i][1]);
			for (var j = 0; j < ns.length; j++) {
				var k = ns[j][0] + "," + ns[j][1];
				if (seen[k] || poolSeen[k]) continue;
				poolSeen[k] = true;
				pool.push(ns[j]);
			}
		}
		if (pool.length === 0) break;
		var pick = pool[Math.floor(Math.random() * pool.length)];
		seen[pick[0] + "," + pick[1]] = true;
		cascade.push(pick);
	}
	return cascade;
}

// Given a cascade region, compute the boundary cells (cells adjacent
// to the cascade but not in it). The cascade and its boundary together
// form the "starting revealed" set the player sees.
function cascadeBoundary(cascade, rows, cols) {
	var cascadeKey = {};
	cascade.forEach(function(c) { cascadeKey[c[0] + "," + c[1]] = true; });
	var seen = {};
	var boundary = [];
	for (var i = 0; i < cascade.length; i++) {
		var ns = neighbours(rows, cols, cascade[i][0], cascade[i][1]);
		for (var j = 0; j < ns.length; j++) {
			var k = ns[j][0] + "," + ns[j][1];
			if (cascadeKey[k] || seen[k]) continue;
			seen[k] = true;
			boundary.push(ns[j]);
		}
	}
	return boundary;
}

// Initialize a board/state from a cascade: mark the cascade cells
// KNOWN with clue=0, mark the boundary cells KNOWN with clue still
// uncommitted, then commit boundary clues via ambiguity-biased
// sampling. Returns { board, state, startRevealed }.
function initWithCascade(cascade, boundary, rows, cols, density) {
	var board = makeGrid(rows, cols, null);
	var state = makeGrid(rows, cols, UNKNOWN);
	var startRevealed = [];
	for (var i = 0; i < cascade.length; i++) {
		var c = cascade[i];
		state[c[0]][c[1]] = KNOWN;
		board[c[0]][c[1]] = 0;
		startRevealed.push(c);
	}
	for (var j = 0; j < boundary.length; j++) {
		var b = boundary[j];
		state[b[0]][b[1]] = KNOWN;
		startRevealed.push(b);
	}
	// Boundary clue values via ambiguity-biased sampling, in random order.
	var order = boundary.slice();
	shuffle(order);
	for (var k = 0; k < order.length; k++) {
		var bc = order[k];
		board[bc[0]][bc[1]] = pickClueValueAmbiguous(bc, state, rows, cols, density);
	}
	return { board: board, state: state, startRevealed: startRevealed };
}

function tryConstruct(opts) {
	opts = opts || {};
	var rows = opts.rows || randInt(5, 7);
	var cols = opts.cols || randInt(5, 7);
	var density = typeof opts.density === "number" ? opts.density : 0.20;

	// Pick a target complexity for the first move (mapped from target
	// rating). Cascade variants with different sizes produce different
	// first-move complexities; we'll sample several and pick the one
	// closest to this target.
	var targetComplexity = null;
	if (typeof opts.targetRating === "number") {
		targetComplexity = Math.max(0, opts.targetRating / 240 + 0.5);
	}

	// Sample several cascade variants of different sizes and pick the
	// one whose first-move complexity (after boundary commits) is
	// closest to the target. When no target is set, pick uniformly at
	// random across variants for natural variety.
	var cascadeCandidates = opts.cascadeCandidates || 6;
	var picks = [];
	for (var attempt = 0; attempt < cascadeCandidates; attempt++) {
		var size = randInt(1, 4);
		var cascade = growCascade(rows, cols, size);
		if (cascade.length === 0) continue;
		var boundary = cascadeBoundary(cascade, rows, cols);
		if (boundary.length === 0) continue;
		var init = initWithCascade(cascade, boundary, rows, cols, density);
		var probe = probeAnalyzer(init.board, init.state);
		var firstC = probe ? probe.firstMove.complexity : 0;
		picks.push({ init: init, boundary: boundary, firstComplexity: firstC, size: cascade.length });
	}
	if (picks.length === 0) return null;

	var chosen;
	if (targetComplexity != null) {
		chosen = picks[0];
		var bestDist = Math.abs(chosen.firstComplexity - targetComplexity);
		for (var p = 1; p < picks.length; p++) {
			var d = Math.abs(picks[p].firstComplexity - targetComplexity);
			if (d < bestDist) { bestDist = d; chosen = picks[p]; }
		}
	} else {
		chosen = picks[Math.floor(Math.random() * picks.length)];
	}

	var board = chosen.init.board;
	var state = chosen.init.state;
	var startRevealed = chosen.init.startRevealed;

	// Main loop: drive construction from the analyzer's deductions.
	// Each "reveal" move adds cells to `pending`, which then get clue
	// values via search before the next analyzer probe runs.
	var pending = [];
	var maxIters = 4 * rows * cols;
	while (maxIters-- > 0) {
		if (pending.length > 0) {
			var cell = pending.shift();
			var v = chooseClueValue(cell, board, state, rows, cols, opts);
			if (v == null) {
				// No candidate yielded analyzer progress — fall back to
				// the ambiguity-biased pick so the construction doesn't
				// stall on this cell.
				v = pickClueValueAmbiguous(cell, state, rows, cols, density);
			}
			board[cell[0]][cell[1]] = v;
			continue;
		}

		var probe = probeAnalyzer(board, state);
		if (!probe) break;
		applyMove(probe.firstMove, board, state, pending);
	}

	// Only keep fully-classified constructions: every cell must be
	// KNOWN or FLAGGED, otherwise the puzzle isn't uniquely solvable.
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] === UNKNOWN) return null;
		}
	}

	// Build output. `revealed` is the *starting* cascade only — the
	// cells the player sees before making any move. Everything else
	// the analyzer derived stays covered (mines flagged, safes to be
	// re-deduced).
	var mines = [];
	for (var r2 = 0; r2 < rows; r2++) {
		for (var c2 = 0; c2 < cols; c2++) {
			if (state[r2][c2] === FLAGGED) mines.push([r2, c2]);
		}
	}
	return { rows: rows, cols: cols, mines: mines, revealed: startRevealed };
}

// Public entry point. Generates up to `count` puzzles, runs each
// through the shared analyzer to confirm solvability and score them,
// dedupes by canonical key. Returns an array of puzzle objects ready
// for db.insertPuzzle. Each is stamped source="inside_out".
function scoreToRating(score) {
	return Math.max(0, Math.round(240 * (score - 0.5)));
}

function generatePuzzles(opts) {
	opts = opts || {};
	var count = opts.count || 50;
	var targetRating = (typeof opts.targetRating === "number") ? opts.targetRating : null;
	var hardness = (targetRating != null) ? Math.max(0, targetRating - 1000) / 1000 : 0;
	var attemptsPerPuzzle = opts.attempts || (targetRating != null ? Math.round(60 + 240 * hardness) : 30);
	var ratingWindow = (typeof opts.ratingWindow === "number") ? opts.ratingWindow : Math.round(250 + 200 * hardness);

	var subOpts = {
		rows: opts.rows, cols: opts.cols,
		targetRating: targetRating
	};

	var seen = {};
	var out = [];
	var attempts = count * attemptsPerPuzzle;
	for (var a = 0; a < attempts && out.length < count; a++) {
		var raw = tryConstruct(subOpts);
		if (!raw) continue;
		var coveredSafe = raw.rows * raw.cols - raw.mines.length - raw.revealed.length;
		if (coveredSafe < 1) continue;
		var board = puzzleGen.buildBoard(raw.rows, raw.cols, raw.mines);
		var analysis = puzzleGen.analyzeWithTracking(board, raw.revealed, raw.mines.length);
		if (!analysis.solved) continue;
		if (targetRating != null) {
			var rating = scoreToRating(analysis.score);
			if (Math.abs(rating - targetRating) > ratingWindow) continue;
		}
		var k = puzzleGen.canonicalKey({ rows: raw.rows, cols: raw.cols, mines: raw.mines, revealed: raw.revealed });
		if (seen[k]) continue;
		seen[k] = true;
		out.push({
			key: k,
			rows: raw.rows, cols: raw.cols,
			mines: raw.mines, revealed: raw.revealed,
			coveredSafe: coveredSafe,
			difficulty: analysis.difficulty,
			score: analysis.score,
			passes: analysis.passes,
			maxEnumSize: analysis.maxEnumSize,
			needsCaseSplit: !!analysis.needsCaseSplit,
			cspMethod: analysis.cspMethod || "trivial",
			source: "inside_out"
		});
	}
	return out;
}

module.exports = {
	generatePuzzles: generatePuzzles,
	tryConstruct: tryConstruct
};
