// Inside-out puzzle generator.
//
// Builds puzzles by simulated solving: start from a seed safe cell
// with a fixed clue, then iteratively expand outward. At each step the
// generator picks a frontier cell, commits a clue value for it, and
// commits the mine status of as many of its neighbours as the chosen
// clue value forces. The construction stops when the revealed region
// reaches the target size or no expansion remains consistent.
//
// The resulting puzzle goes through PuzzleGenerator.analyzeWithTracking
// so the rating comes from the same CSP-based analyzer used for the
// random-source pool.
//
// Difficulty steering: opts.targetRating biases construction toward a
// rating band. Internally that maps to an ambiguityBias in [0, 1]:
//   * Low bias (target ≤ 300) prefers clue values that fully resolve
//     their neighbourhood (trivial deductions).
//   * High bias (target ≥ 1500) prefers clue values that leave each
//     neighbourhood under-determined, forcing subset/intersect-style
//     reasoning across overlapping clue clusters.
// Results are still validated against target ± ratingWindow after the
// analyzer runs, so the construction-time bias is a hit-rate booster,
// not a guarantee.

var BoardLogic = require("../common/BoardLogic");
var puzzleGen = require("./PuzzleGenerator");
var MINE = BoardLogic.MINE;

function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function key(r, c) { return r + "," + c; }
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// Map a target rating onto a 0..1 ambiguity dial. Rating 0 → 0 (force
// trivial-only clue choices), rating ≥ 1500 → 1 (prefer maximally
// ambiguous clue choices). Below 200 we still allow some randomness so
// the easy band doesn't collapse to clue-0 cascades only.
function ambiguityBiasForRating(targetRating) {
	if (targetRating == null) return 0.55; // unset → mild ambiguity (matches old natural skew)
	return clamp((targetRating - 150) / 1350, 0, 1);
}

// Score how "ambiguous" a candidate extra-mine count is — i.e. how
// little it constrains its undecided neighbours. 0 means extreme
// (everything forced safe or all forced mine); 1 means split evenly.
function ambiguityOf(k, total) {
	if (total <= 0) return 0;
	var halved = Math.max(1, Math.floor(total / 2));
	return Math.min(k, total - k) / halved;
}

// Pick the number of additional mines among `undecidedCount`
// undecided neighbours. Draws several density-binomial samples and
// picks the one whose ambiguity best matches the requested bias.
function pickExtraMines(undecidedCount, density, ambiguityBias) {
	if (undecidedCount === 0) return 0;
	var samples = [];
	for (var t = 0; t < 5; t++) {
		var k = 0;
		for (var i = 0; i < undecidedCount; i++) {
			if (Math.random() < density) k++;
		}
		samples.push(k);
	}
	var best = samples[0];
	var bestScore = -1;
	for (var s = 0; s < samples.length; s++) {
		var amb = ambiguityOf(samples[s], undecidedCount);
		// Weight: ambiguityBias = 1 → prefer high amb; ambiguityBias = 0 → prefer low amb.
		var w = (1 - ambiguityBias) * (1 - amb) + ambiguityBias * amb;
		// Small jitter so equal-weight samples don't always lose to the first.
		w += Math.random() * 0.01;
		if (w > bestScore) { bestScore = w; best = samples[s]; }
	}
	return best;
}

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
	var ambiguityBias = typeof opts.ambiguityBias === "number" ? opts.ambiguityBias : 0.55;

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

	// Pick a seed cell and seed its neighbourhood. The clue value is
	// chosen via the same ambiguity-biased sampler so the very first
	// clue already nudges the puzzle toward the requested rating band:
	// trivial targets favour clue 0 (cascade) or clue = full count;
	// hard targets favour middle values that leave the seed's
	// neighbourhood under-determined.
	var seedR = randInt(1, rows - 2);
	var seedC = randInt(1, cols - 2);
	status[seedR][seedC] = "safe";
	var seedNeighbours = neighbours(rows, cols, seedR, seedC);
	var seedClue = pickExtraMines(seedNeighbours.length, density, ambiguityBias);
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

	// Count of decided (safe-or-mine) neighbours per frontier cell.
	// Used to bias selection toward more-connected cells when we want
	// dense, overlapping clue clusters (high ambiguityBias).
	function decidedNeighbourCount(r, c) {
		var ns = neighbours(rows, cols, r, c);
		var n = 0;
		for (var i = 0; i < ns.length; i++) {
			var st = status[ns[i][0]][ns[i][1]];
			if (st === "safe" || st === "mine") n++;
		}
		return n;
	}

	function pickFrontierKey(fkeys) {
		if (ambiguityBias < 0.4) {
			// Easier targets: random selection keeps the construction loose
			// so clue values can stay extreme without creating chains.
			return fkeys[Math.floor(Math.random() * fkeys.length)];
		}
		// Harder targets: prefer cells with more decided neighbours so
		// overlapping clue clusters form. We still keep some randomness.
		var best = fkeys[0], bestN = -1;
		for (var i = 0; i < fkeys.length; i++) {
			var cell = frontier[fkeys[i]];
			var n = decidedNeighbourCount(cell[0], cell[1]) + Math.random() * 0.5;
			if (n > bestN) { bestN = n; best = fkeys[i]; }
		}
		return best;
	}

	var safeBudget = targetCovered; // how many more safe cells we still want
	while (revealedCount < targetCovered) {
		var fkeys = Object.keys(frontier);
		if (!fkeys.length) break;
		var fk = pickFrontierKey(fkeys);
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
		var extraMines = pickExtraMines(undecided.length, density, ambiguityBias);
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

// Convert a CSP score to the rating shown in the lab. Mirrors
// db.scoreToRating; duplicated here to avoid a require() cycle.
function scoreToRating(score) {
	return Math.max(0, Math.round(240 * (score - 0.5)));
}

// Public entry point. Generates up to `count` puzzles, runs each through
// the shared analyzer for rating, and dedups by canonical key. Returns an
// array of puzzle objects suitable for db.insertPuzzle. Stamps source
// = "inside_out" on each.
//
// opts.targetRating (optional): when set, derives ambiguityBias and
// filters output to target ± ratingWindow (default 250).
function generatePuzzles(opts) {
	opts = opts || {};
	var count = opts.count || 50;
	var targetRating = (typeof opts.targetRating === "number") ? opts.targetRating : null;
	// At high targets the natural distribution from max-bias construction
	// tapers off (intersect-method tops out around 2000), so scale both
	// the per-puzzle attempt budget and the accept window up with the
	// requested rating to keep yield reasonable.
	var hardness = (targetRating != null) ? Math.max(0, targetRating - 1000) / 1000 : 0;
	var attemptsPerPuzzle = opts.attempts || (targetRating != null ? Math.round(60 + 240 * hardness) : 30);
	var ratingWindow = (typeof opts.ratingWindow === "number") ? opts.ratingWindow : Math.round(250 + 200 * hardness);
	var ambiguityBias = (typeof opts.ambiguityBias === "number")
		? opts.ambiguityBias
		: ambiguityBiasForRating(targetRating);
	var seen = {};
	var out = [];
	var attempts = count * attemptsPerPuzzle;
	var subOpts = {
		rows: opts.rows, cols: opts.cols,
		density: opts.density,
		targetCoveredSafe: opts.targetCoveredSafe,
		ambiguityBias: ambiguityBias
	};
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
	tryConstruct: tryConstruct,
	ambiguityBiasForRating: ambiguityBiasForRating
};
