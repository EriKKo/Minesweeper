// Inside-out puzzle generator (prototype).
//
// Instead of "place random mines → solve → keep or reject", build the
// puzzle by simulated solving: start from a seed safe cell with a
// fixed clue, then iteratively expand outward. At each expansion the
// generator picks a frontier cell, commits a clue value for it, and
// commits the mine status of as many of its neighbours as the chosen
// clue value forces. The construction stops when the revealed region
// reaches the target size or no expansion remains consistent.
//
// The resulting puzzle goes through PuzzleGenerator.analyzeWithTracking
// for rating, so the score and difficulty come from the same CSP-based
// analyzer that scores the random-source pool. The only difference
// between the two sources is the construction path — the rating curve
// is shared.
//
// This is a first cut. Known limitations:
//   * Uniqueness of the mine layout isn't guaranteed yet — we rely on
//     the analyzer's "solved" flag to filter inconsistent constructions.
//   * Clue values are picked with a simple density-biased random draw;
//     a future iteration will steer the choice toward a target deduction.

var BoardLogic = require("../common/BoardLogic");
var puzzleGen = require("./PuzzleGenerator");
var MINE = BoardLogic.MINE;

function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function key(r, c) { return r + "," + c; }

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

// Returns { mines, revealed, rows, cols } for a successfully constructed
// puzzle, or null if the run painted itself into a corner before
// reaching the target. Caller (generatePuzzles) retries with a fresh
// seed when this happens.
function tryConstruct(opts) {
	var rows = opts.rows || randInt(5, 8);
	var cols = opts.cols || randInt(5, 8);
	var density = typeof opts.density === "number" ? opts.density : 0.18;
	var targetCovered = opts.targetCoveredSafe || randInt(6, 14);

	// status[r][c]: "unknown" | "safe" (will be a revealed clue) | "mine"
	var status = new Array(rows);
	var clueOf = new Array(rows);
	for (var r = 0; r < rows; r++) {
		status[r] = new Array(cols);
		clueOf[r] = new Array(cols);
		for (var c = 0; c < cols; c++) {
			status[r][c] = "unknown";
			clueOf[r][c] = null;
		}
	}

	// Pick a seed cell and place 0–2 random adjacent mines to give the
	// starting clue a non-trivial value.
	var seedR = randInt(1, rows - 2);
	var seedC = randInt(1, cols - 2);
	status[seedR][seedC] = "safe";
	var seedNeighbours = neighbours(rows, cols, seedR, seedC);
	// Random clue between 0 and 2 (cap at neighbour count).
	var seedClue = Math.min(seedNeighbours.length, randInt(0, 2));
	shuffle(seedNeighbours);
	for (var i = 0; i < seedClue; i++) {
		var m = seedNeighbours[i];
		status[m[0]][m[1]] = "mine";
	}
	clueOf[seedR][seedC] = seedClue;

	var revealedCount = 1;

	// Frontier = unknown cells adjacent to any safe cell. Pre-seed with
	// the seed's not-yet-mine neighbours.
	function addFrontier(set, r, c) {
		var ns = neighbours(rows, cols, r, c);
		for (var i = 0; i < ns.length; i++) {
			var nr = ns[i][0], nc = ns[i][1];
			if (status[nr][nc] === "unknown") set[key(nr, nc)] = [nr, nc];
		}
	}
	var frontier = {};
	addFrontier(frontier, seedR, seedC);

	var safeBudget = targetCovered; // how many more safe cells we still want
	while (revealedCount < targetCovered) {
		var fkeys = Object.keys(frontier);
		if (!fkeys.length) break;
		// Pick a frontier cell at random.
		var fk = fkeys[Math.floor(Math.random() * fkeys.length)];
		var cell = frontier[fk];
		delete frontier[fk];
		var fr = cell[0], fc = cell[1];
		if (status[fr][fc] !== "unknown") continue;

		// Probabilistically commit this cell as a mine or as safe.
		// We bias toward "safe" so the revealed region grows fast enough
		// to hit the target, but density nudges some cells into mines.
		var rollDensity = density;
		// As we run out of unfilled frontier, force more safes through.
		if (revealedCount + safeBudget < targetCovered) rollDensity *= 0.4;
		if (Math.random() < rollDensity) {
			status[fr][fc] = "mine";
			// Mines on the frontier don't expand the revealed region,
			// but they do contribute to nearby clue values.
			continue;
		}

		// Commit as safe and choose a clue value. The value must equal
		// the number of mine-status neighbours; undecided neighbours can
		// still be either, so we have wiggle room here.
		status[fr][fc] = "safe";
		var ns = neighbours(rows, cols, fr, fc);
		var commitedMines = 0;
		var undecided = [];
		for (var j = 0; j < ns.length; j++) {
			var nr = ns[j][0], nc = ns[j][1];
			if (status[nr][nc] === "mine") commitedMines++;
			else if (status[nr][nc] === "unknown") undecided.push([nr, nc]);
		}
		// Pick how many of the undecided neighbours should become mines.
		// Bias toward density; cap by undecided.length.
		var extraMines = 0;
		for (var k = 0; k < undecided.length; k++) {
			if (Math.random() < density) extraMines++;
		}
		extraMines = Math.min(extraMines, undecided.length);
		// Choose which undecided cells become the new mines.
		shuffle(undecided);
		for (var x = 0; x < extraMines; x++) {
			var m2 = undecided[x];
			status[m2[0]][m2[1]] = "mine";
		}
		// Anything still undecided in `undecided` becomes new frontier.
		for (var y = extraMines; y < undecided.length; y++) {
			var u = undecided[y];
			frontier[key(u[0], u[1])] = u;
		}
		clueOf[fr][fc] = commitedMines + extraMines;
		revealedCount++;
		safeBudget = Math.max(0, safeBudget - 1);
	}

	if (revealedCount < Math.max(3, targetCovered * 0.6)) return null;

	// Convert into PuzzleGenerator's shape.
	var mines = [];
	var revealed = [];
	for (var r2 = 0; r2 < rows; r2++) {
		for (var c2 = 0; c2 < cols; c2++) {
			if (status[r2][c2] === "mine") mines.push([r2, c2]);
			else if (status[r2][c2] === "safe") revealed.push([r2, c2]);
		}
	}
	return { rows: rows, cols: cols, mines: mines, revealed: revealed };
}

function shuffle(a) {
	for (var i = a.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var t = a[i]; a[i] = a[j]; a[j] = t;
	}
}

// Public entry point. Generates up to `count` puzzles, runs each through
// the shared analyzer for rating, and dedups by canonical key. Returns an
// array of puzzle objects suitable for db.insertPuzzle. Stamps source
// = "inside_out" on each.
function generatePuzzles(opts) {
	opts = opts || {};
	var count = opts.count || 50;
	var attemptsPerPuzzle = opts.attempts || 30;
	var seen = {};
	var out = [];
	var attempts = count * attemptsPerPuzzle;
	for (var a = 0; a < attempts && out.length < count; a++) {
		var raw = tryConstruct(opts);
		if (!raw) continue;
		var coveredSafe = raw.rows * raw.cols - raw.mines.length - raw.revealed.length;
		if (coveredSafe < 1) continue;
		var board = puzzleGen.buildBoard(raw.rows, raw.cols, raw.mines);
		var analysis = puzzleGen.analyzeWithTracking(board, raw.revealed, raw.mines.length);
		if (!analysis.solved) continue;
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
