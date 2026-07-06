// No-guess board generator + solvability analyzer.
//
// MSBattle plays every ranked round on a board that's solvable from the
// opening with pure logical deduction (no guessing). `createNoGuessTemplate`
// rolls boards from `GameCreator.createTemplate` and returns the first one
// `analyzeSolvability` proves reachable to 100% safe coverage.

var BoardLogic = require("../../common/BoardLogic");
var GameCreator = require("./GameCreator");
var csp = require("./CSPSolver");

var UNKNOWN = BoardLogic.UNKNOWN, KNOWN = BoardLogic.KNOWN;

var NOGUESS_MAX_TRIES = 100;
// Hardest move (CSP complexity) a generated board may require. The CSP verifier is
// capped here so (a) boards are solvable within a human-achievable difficulty, and
// (b) generation stays fast. Kept just below CASE_BASE (8): at the cap the solver
// skips the expensive 1-cell case-split entirely, which is the difference between
// ~25ms/board and ~3.8s/board at 20% density. Also the ceiling of the per-cell
// difficulty scale that drives bot pacing and the max-difficulty skill gate.
var GEN_MAX_COMPLEXITY = 7;

// Plays the board using only sound logical deduction (never guesses) starting
// from the pre-revealed opening, and reports whether every safe cell can be
// uncovered. Used to pick boards that don't force a guess.
function analyzeSolvability(board, knownCells, numMines) {
	var rows = board.length, cols = board[0].length;

	// Rebuild the pre-revealed opening as KNOWN, then let the (capped) CSP solver
	// play out pure-logic deductions. The board is no-guess iff it solves to 100%.
	var state = [];
	for (var r = 0; r < rows; r++) state.push(new Array(cols).fill(UNKNOWN));
	for (var i = 0; i < knownCells.length; i++) state[knownCells[i][0]][knownCells[i][1]] = KNOWN;

	// Reports back every cell this call revealed (including anything cascaded), so analyzeBoard can
	// skip its full-board diff scan and go straight to the cells that actually changed.
	function cascade(rr, cc) {
		var touched = [];
		BoardLogic.cascadeReveal(rr, cc, rows, cols,
			function(a, b) { return state[a][b] === UNKNOWN; },
			function(a, b) { state[a][b] = KNOWN; touched.push([a, b]); return false; },
			function(a, b) { return board[a][b]; });
		return touched;
	}

	var result = csp.analyzeBoard(board, state, { revealCell: cascade, maxComplexity: GEN_MAX_COMPLEXITY });

	// Per-cell difficulty = the complexity of the move that first determines that
	// cell (first write wins, since moves arrive in solve order). Cells opened by a
	// cascade aren't keyed here — callers treat a missing entry as trivial.
	var difficultyByCell = {};
	for (var m = 0; m < result.moves.length; m++) {
		var mv = result.moves[m];
		var cells = mv.changed || mv.cells || [];
		for (var k = 0; k < cells.length; k++) {
			var key = cells[k][0] + "," + cells[k][1];
			if (difficultyByCell[key] === undefined) difficultyByCell[key] = mv.complexity;
		}
	}

	var totalSafe = rows * cols - numMines;
	return {
		solved: result.solved,
		revealedSafe: totalSafe - result.safeCovered,
		difficultyByCell: difficultyByCell
	};
}

// Generate-and-test: return the first board solvable without guessing, or — if
// none turns up within maxTries — the closest (most logically-revealable) one.
function createNoGuessTemplate(startR, startC, mineCount, maxTries, tRows, tCols) {
	maxTries = maxTries > 0 ? maxTries : NOGUESS_MAX_TRIES;
	var best = null, bestScore = -1;
	for (var i = 0; i < maxTries; i++) {
		var cand = GameCreator.createTemplate(startR, startC, mineCount, tRows, tCols);
		var res = analyzeSolvability(cand.board, cand.knownCells, cand.numMines);
		// The per-cell difficulty map is computed here, once, and rides along on the
		// template to the server (round start) and the headless benchmark.
		cand.difficultyByCell = res.difficultyByCell;
		if (res.solved) return cand;
		if (res.revealedSafe > bestScore) { bestScore = res.revealedSafe; best = cand; }
	}
	return best;
}

exports.analyzeSolvability = analyzeSolvability;
exports.createNoGuessTemplate = createNoGuessTemplate;
