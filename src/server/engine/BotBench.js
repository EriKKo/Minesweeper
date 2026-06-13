// Headless bot benchmarking + Elo calibration.
//
// A ranked bot's "strength" is no longer hand-assigned — it's measured. This
// module replays a bot's real decision loop (BotPlayer.decideMove +
// computeMoveDelay) against no-guess boards on a *virtual clock*: every move
// delay and every mine-penalty freeze is simply added to a running total, never
// actually waited on. The result is the time the bot would take to solve that
// board in a real ranked round.
//
// Those solve times become an Elo by calibrating against the existing
// configForElo curve (see calibrate / timeToElo), so the pool stays on the same
// ladder real players are rated on.
//
// Used offline by scripts/generate-bot-pool.js; pure logic, no I/O of its own.

var gameCreator = require("./GameCreator");
var noGuess = require("./NoGuessGenerator");
var botPlayer = require("./BotPlayer");

var MINE = gameCreator.MINE;

// Ranked reference: medium board, the three ranked densities, 2-minute rounds,
// 5s death penalty. (Mirrors RANKED_MODES / RANKED_RULES in minesweeperServer.js.)
var ROWS = 15, COLS = 20;
var DENSITIES = [0.10, 0.15, 0.20];
var ROUND_MS = 120 * 1000;            // round cap; a board not solved in time is a DNF
var PENALTY_MS = botPlayer.PENALTY_MS || 5000;

// Calibration grid: configForElo bots sampled across the full 0–3000 ladder. Extends below
// the baseline config Elo (configForElo extrapolates there) so the curve — and the pool — reach 0.
var ELO_GRID = [0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1350, 1500, 1650, 1800, 1950, 2100, 2250, 2400, 2550, 2700, 2850, 3000];

function densityKey(d) { return d.toFixed(2); }

function minesFor(density, rows, cols) {
	return Math.round(density * rows * cols);
}

// Generate `count` no-guess templates at a density. Boards are generated once and
// reused across every bot so all bots are timed on the *same* boards — fair
// comparison, and far cheaper than regenerating per bot.
function makeTemplates(density, count, rows, cols) {
	rows = rows || ROWS; cols = cols || COLS;
	var mines = minesFor(density, rows, cols);
	var centerR = Math.floor(rows / 2), centerC = Math.floor(cols / 2);
	var templates = [];
	for (var i = 0; i < count; i++) {
		templates.push(noGuess.createNoGuessTemplate(centerR, centerC, mines, undefined, rows, cols));
	}
	return templates;
}

// Smallest cleared fraction we'll extrapolate from, so a bot that barely touched
// the board doesn't produce an absurd (near-infinite) derived time. Anything this
// stuck is floor-Elo regardless.
var MIN_CLEARED_FRACTION = 0.02;

// Simulate one bot solving one board on a virtual clock, stopping at the round cap
// (the real 2-minute ranked round). Returns { ms, solved, clearedFraction }.
//
// If the bot clears the board before the round ends, `ms` is its true solve time.
// If the round ends first, we don't flat-line it at the cap — that would make every
// slow bot indistinguishable. Instead we extrapolate an effective solve time from how
// much of the board it cleared (linear model: time ≈ cap / fractionCleared), so a bot
// stuck at 30% rates far slower than one that reached 85%.
function simulateSolveTime(config, template, opts) {
	opts = opts || {};
	var capMs = opts.capMs || ROUND_MS;
	var rows = template.rows, cols = template.cols;
	var game = gameCreator.createGame(template.numMines, rows, cols);

	// All six per-bot variables, plus the board's precomputed difficulty map — the
	// same fields the server sets on a bot's game at round start.
	game.botSpeedMs = config.speedMs;
	game.botDifficultyMs = config.difficultyMs || 0;
	game.botDistanceMult = (typeof config.distanceMult === "number") ? config.distanceMult : 1;
	game.botMaxDifficulty = (typeof config.maxDifficulty === "number") ? config.maxDifficulty : 1;
	game.botMistakeRate = config.mistakeRate || 0;
	game.botChordRate = (typeof config.chordRate === "number") ? config.chordRate : 0;
	game.botDifficultyByCell = template.difficultyByCell || null;

	var virtualMs = 0;
	game.win = function() { game.finished = true; };
	// A clicked mine: no real freeze (frozenUntil stays 0 so clicks keep applying);
	// the 5s cost is just added to the virtual clock, per the benchmark model.
	game.mineHit = function() { virtualMs += PENALTY_MS; };

	game.init(template);
	game.playing = true;
	game.frozenUntil = 0;

	var lastClick = null;
	var maxIters = rows * cols * 6; // safety backstop against a non-terminating loop
	for (var iter = 0; iter < maxIters && !game.finished && virtualMs < capMs; iter++) {
		var move = botPlayer.decideMove(game);
		if (!move) break;
		virtualMs += botPlayer.computeMoveDelay(game, lastClick, move);
		if (move.type === "right") game.handleRightClick(move.r, move.c);
		else game.handleLeftClick(move.r, move.c);
		lastClick = { r: move.r, c: move.c };
	}

	if (game.finished) {
		// Solved within the round. Clamp the rare buzzer-beater that a final mine
		// penalty pushed just past the cap, so solved time is always <= cap < any DNF.
		return { ms: Math.min(virtualMs, capMs), solved: true, clearedFraction: 1 };
	}
	var frac = game.revealedSafeCount() / game.totalSafeSquares;
	if (frac < MIN_CLEARED_FRACTION) frac = MIN_CLEARED_FRACTION;
	return { ms: capMs / frac, solved: false, clearedFraction: frac };
}

// Average effective solve time of a config over a fixed set of templates. DNF boards
// already carry an extrapolated time from simulateSolveTime, so this is a plain mean.
function avgSolveTime(config, templates, opts) {
	opts = opts || {};
	var total = 0;
	for (var i = 0; i < templates.length; i++) {
		total += simulateSolveTime(config, templates[i], opts).ms;
	}
	return total / templates.length;
}

// The per-Elo reference-bot curve — the calibration anchor (relocated here from
// BotPlayer, whose runtime no longer needs it; this offline module is its only
// caller). Higher Elo = faster pace, less per-difficulty thinking, a higher
// max-difficulty ceiling, fewer blunders, more chording. configForElo(600) is the
// weak reference and configForElo(3000) the strong one; below 1000 it extrapolates
// toward an even slower, sloppier bot so the calibrated pool can reach 0 Elo. The anchors
// span the 0–3000 ladder (Bronze I = 0, Master from 3000); the fastest config is Master.
var ELO_MIN = 1000, ELO_MAX = 3000, ELO_FLOOR = 0;
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
function configForElo(elo) {
	var s = clamp((elo - ELO_MIN) / (ELO_MAX - ELO_MIN), (ELO_FLOOR - ELO_MIN) / (ELO_MAX - ELO_MIN), 1);
	return {
		rating: Math.round(elo),
		speedMs: Math.round(clamp(lerp(950, 130, s), 70, 1400)),       // pace; faster as s rises
		difficultyMs: Math.round(clamp(lerp(320, 60, s), 20, 600)),    // per-difficulty thinking; less as s rises
		distanceMult: 1,                                                // strength-neutral; varied only in the pool
		maxDifficulty: clamp(lerp(1.2, 8, s), 1, 9),                    // skill ceiling; trivial-only at the floor
		mistakeRate: clamp(lerp(0.06, 0.002, s), 0, 0.4),              // blunder chance; lower as s rises
		chordRate: clamp(lerp(0.05, 0.85, s), 0, 1)
	};
}

// Build the solve-time↔Elo calibration: for each density, benchmark configForElo
// across the Elo grid. configForElo randomizes a strength-neutral "style" per
// call, so we average `samples` configs per grid point. Returns a curve per
// density: sorted-by-Elo [elo, meanMs] pairs (meanMs decreasing as Elo rises).
function calibrate(templatesByDensity, opts) {
	opts = opts || {};
	var samples = opts.samples || 8;
	var curves = {};
	DENSITIES.forEach(function(d) {
		var key = densityKey(d);
		var templates = templatesByDensity[key];
		var pairs = [];
		for (var g = 0; g < ELO_GRID.length; g++) {
			var elo = ELO_GRID[g];
			var sum = 0;
			for (var s = 0; s < samples; s++) {
				sum += avgSolveTime(configForElo(elo), templates, opts);
			}
			pairs.push([elo, sum / samples]);
		}
		curves[key] = pairs;
	});
	return curves;
}

// Invert a single density's calibration curve: map a measured mean solve time to
// an Elo by linear interpolation. The curve is [elo, meanMs] ascending in Elo /
// descending in meanMs; clamp outside the grid to the endpoint Elos.
function timeToElo(ms, curve) {
	var n = curve.length;
	// Faster than the strongest grid bot -> top of the scale; slower than the
	// weakest -> bottom. (curve[0] = lowest Elo / largest ms.)
	if (ms >= curve[0][1]) return curve[0][0];
	if (ms <= curve[n - 1][1]) return curve[n - 1][0];
	for (var i = 0; i < n - 1; i++) {
		var hiMs = curve[i][1], loMs = curve[i + 1][1]; // hiMs > loMs
		if (ms <= hiMs && ms >= loMs) {
			var t = (hiMs === loMs) ? 0 : (hiMs - ms) / (hiMs - loMs);
			return Math.round(curve[i][0] + t * (curve[i + 1][0] - curve[i][0]));
		}
	}
	return curve[n - 1][0];
}

// Benchmark one config across all densities and assign it an overall rating.
// Returns { times: {density: meanMs}, ratings: {density: elo}, rating }.
// Overall rating = mean of the per-density Elos (each ranked mode weighted equally).
function ratingForConfig(config, templatesByDensity, curves, opts) {
	var times = {}, ratings = {};
	var sum = 0, n = 0;
	DENSITIES.forEach(function(d) {
		var key = densityKey(d);
		var ms = avgSolveTime(config, templatesByDensity[key], opts);
		var elo = timeToElo(ms, curves[key]);
		times[key] = Math.round(ms);
		ratings[key] = elo;
		sum += elo; n++;
	});
	return { times: times, ratings: ratings, rating: Math.round(sum / n) };
}

exports.ROWS = ROWS;
exports.COLS = COLS;
exports.DENSITIES = DENSITIES;
exports.ELO_GRID = ELO_GRID;
exports.ROUND_MS = ROUND_MS;
exports.densityKey = densityKey;
exports.minesFor = minesFor;
exports.makeTemplates = makeTemplates;
exports.simulateSolveTime = simulateSolveTime;
exports.avgSolveTime = avgSolveTime;
exports.calibrate = calibrate;
exports.timeToElo = timeToElo;
exports.configForElo = configForElo;
exports.ratingForConfig = ratingForConfig;
