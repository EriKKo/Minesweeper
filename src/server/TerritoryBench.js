// Headless calibration of bots for TERRITORY mode.
//
// Territory punishes mistakes differently from the racing modes: hitting a mine doesn't cost a flat
// time penalty, it re-covers a patch of your ground (which you must re-clear) AND freezes you. So a
// bot's territory strength is its own thing, measured here the same way BotBench measures the racing
// modes: replay the real decision loop (BotPlayer.decideMove) on a *virtual clock*, but under
// territory rules — the bot clears a no-guess territory board alone, starting from one corner, with
// every move delay and every mine-hit freeze added to a running total. The resulting clear time is
// mapped to an Elo against a configForElo calibration curve (BotBench.timeToElo), so territory bots
// land on the same ladder as everyone else.
//
// Used offline by scripts/calibrate-territory.js; pure logic, no I/O of its own.

var territoryGen = require("./TerritoryGenerator");
var territoryGame = require("./TerritoryGame");
var botPlayer = require("./BotPlayer");
var bench = require("./BotBench");
var BoardLogic = require("../common/BoardLogic");

var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN;

// Match the live territory mode (minesweeperServer: TERRITORY_ROWS/COLS/DENSITY).
var ROWS = 18, COLS = 30, DENSITY = 0.13;
// No round clock in territory; this cap only bounds a stuck bot (guessing/re-clearing forever) so the
// benchmark terminates. A bot that can't clear within it is a DNF, rated by how far it got.
var CLEAR_CAP_MS = 300 * 1000;
var MIN_CLEARED_FRACTION = 0.02;

// Same Elo grid as the racing calibration so the ladders line up.
var ELO_GRID = bench.ELO_GRID;

function makeBoards(count) {
	var boards = [];
	for (var i = 0; i < count; i++) boards.push(territoryGen.generate({ rows: ROWS, cols: COLS, density: DENSITY }));
	return boards;
}

// The game view BotPlayer.decideMove consumes, identical to the live territoryBotView: reveals are
// restricted to the bot's own frontier (canTarget), it never flags (revealsOnly), and it sees the
// whole revealed board but no per-cell difficulty map (territory boards don't carry one — so, exactly
// as in the live game, the maxDifficulty gate is inert and skill shows up as pace + mistakes).
function botView(tg, botId, config, focus) {
	var R = tg.rows, C = tg.cols, state = [];
	for (var r = 0; r < R; r++) {
		state.push(new Array(C));
		for (var c = 0; c < C; c++) state[r][c] = (tg.owner[r][c] !== null || tg.mineKnown[botId][r + "," + c]) ? KNOWN : UNKNOWN;
	}
	return {
		board: tg.board, state: state,
		botMaxDifficulty: config.maxDifficulty,
		botMistakeRate: config.mistakeRate || 0,
		botChordRate: 0,
		revealsOnly: true,
		botFocus: focus || null,
		botDifficultyByCell: null,
		canTarget: function(r, c) { return tg.canReveal(botId, r, c) && !tg.mineKnown[botId][r + "," + c]; }
	};
}

// Simulate one bot clearing one territory board against a NON-MOVING opponent (whose start sits in the
// far corner so enclosure capture doesn't trivially hand the bot the whole board, but who never
// contests — the bot is free to clear everything else). Returns { ms, solved, clearedFraction }.
function simulateClearTime(config, gen, opts) {
	opts = opts || {};
	var capMs = opts.capMs || CLEAR_CAP_MS;
	var tg = territoryGame.create(gen, ["bot", "idle"]); // "idle" is seeded its corner but never moves
	var now = 1000, start = now;
	var focus = null;
	var maxIters = tg.rows * tg.cols * 8; // backstop against a non-terminating loop
	for (var iter = 0; iter < maxIters && tg.playing && (now - start) < capMs; iter++) {
		var view = botView(tg, "bot", config, focus);
		var move = botPlayer.decideMove(view);
		focus = view.botFocus;
		if (!move || move.type !== "left") break;
		// Pace exactly like the live territory tick: flat speed + a thinking pause scaled by the
		// move's difficulty (jitter dropped for a deterministic measurement).
		now += config.speedMs + (config.difficultyMs || 0) * Math.min(move.difficulty || 0, 8);
		var res = tg.reveal("bot", move.r, move.c, now);
		if (res && res.until) now = res.until; // a mine hit: jump the clock past the freeze
	}
	var ms = now - start;
	if (!tg.playing) return { ms: ms, solved: true, clearedFraction: 1 }; // cleared the whole board
	var frac = tg.claimedSafe() / tg.totalSafe;
	if (frac < MIN_CLEARED_FRACTION) frac = MIN_CLEARED_FRACTION;
	return { ms: capMs / frac, solved: false, clearedFraction: frac }; // DNF: extrapolate from coverage
}

function avgClearTime(config, boards, opts) {
	var total = 0;
	for (var i = 0; i < boards.length; i++) total += simulateClearTime(config, boards[i], opts).ms;
	return total / boards.length;
}

// Build the territory clear-time -> Elo curve from configForElo across the Elo grid (averaging
// `samples` strength-neutral style draws per grid point). Returns [elo, meanMs] ascending in Elo.
function calibrate(boards, opts) {
	opts = opts || {};
	var samples = opts.samples || 6;
	var pairs = [];
	for (var g = 0; g < ELO_GRID.length; g++) {
		var elo = ELO_GRID[g], sum = 0;
		for (var s = 0; s < samples; s++) sum += avgClearTime(botPlayer.configForElo(elo), boards, opts);
		pairs.push([elo, sum / samples]);
	}
	return pairs;
}

// Measure one config's territory clear time and map it to an Elo via the curve.
function ratingForConfig(config, boards, curve, opts) {
	var ms = avgClearTime(config, boards, opts);
	return { time: Math.round(ms), rating: bench.timeToElo(ms, curve) };
}

exports.ROWS = ROWS;
exports.COLS = COLS;
exports.DENSITY = DENSITY;
exports.CLEAR_CAP_MS = CLEAR_CAP_MS;
exports.ELO_GRID = ELO_GRID;
exports.makeBoards = makeBoards;
exports.simulateClearTime = simulateClearTime;
exports.avgClearTime = avgClearTime;
exports.calibrate = calibrate;
exports.ratingForConfig = ratingForConfig;
