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

// Calibration grid: configForElo bots sampled across the playable range.
var ELO_GRID = [600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800];

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

// Simulate one bot solving one board on a virtual clock. Returns { ms, solved }.
function simulateSolveTime(config, template, opts) {
	opts = opts || {};
	var rows = template.rows, cols = template.cols;
	var game = gameCreator.createGame(template.numMines, rows, cols);

	game.botMistakeRate = config.mistakeRate || 0;
	game.botChordRate = (typeof config.chordRate === "number") ? config.chordRate : 0;
	game.botMaxTier = config.maxTier || "trivial";

	var virtualMs = 0;
	game.win = function() { game.finished = true; };
	// A clicked mine: no real freeze (frozenUntil stays 0 so clicks keep applying);
	// the 5s cost is just added to the virtual clock, per the benchmark model.
	game.mineHit = function() { virtualMs += PENALTY_MS; };

	game.init(template);
	game.playing = true;
	game.frozenUntil = 0;

	var baseMs = config.speedMs;
	var lastClick = null;
	var maxIters = rows * cols * 6; // safety backstop against a non-terminating loop
	for (var iter = 0; iter < maxIters && !game.finished; iter++) {
		var move = botPlayer.decideMove(game);
		if (!move) break;
		virtualMs += botPlayer.computeMoveDelay(baseMs, lastClick, move);
		if (move.type === "right") game.handleRightClick(move.r, move.c);
		else game.handleLeftClick(move.r, move.c);
		lastClick = { r: move.r, c: move.c };
	}
	return { ms: virtualMs, solved: !!game.finished };
}

// Average solve time of a config over a fixed set of templates. A board the bot
// fails to finish (DNF) counts at the round cap so weak bots get a finite,
// comparable number instead of dragging the mean to infinity.
function avgSolveTime(config, templates, opts) {
	opts = opts || {};
	var cap = opts.capMs || ROUND_MS;
	var total = 0;
	for (var i = 0; i < templates.length; i++) {
		var r = simulateSolveTime(config, templates[i], opts);
		total += r.solved ? Math.min(r.ms, cap) : cap;
	}
	return total / templates.length;
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
				sum += avgSolveTime(botPlayer.configForElo(elo), templates, opts);
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
exports.ratingForConfig = ratingForConfig;
