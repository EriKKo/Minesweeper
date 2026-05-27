var gameCreator = require("./GameCreator");

var MINE = gameCreator.MINE;
var FLAGGED = gameCreator.FLAGGED;
var UNKNOWN = gameCreator.UNKNOWN;
var KNOWN = gameCreator.KNOWN;
var rows = gameCreator.rows;
var cols = gameCreator.cols;

// Per-bot skill bundles both pace and accuracy:
//  - speed is the baseline "thinking" pace (ms between actions); lower = faster.
//  - mistake rate is the chance that, on a turn where the bot *could* play a
//    guaranteed-safe move, it instead misreads the board and guesses at a frontier
//    cell (which may be a mine).
// Tuned so easy bots are slow and blunder into a few mines per game, while hard
// bots are fast and almost never err.
var DIFFICULTIES = ["easy", "medium", "hard"];
var DEFAULT_DIFFICULTY = "medium";
var MISTAKE_RATES = { easy: 0.09, medium: 0.03, hard: 0.008 };
var DIFFICULTY_SPEEDS = { easy: 800, medium: 400, hard: 200 };

function mistakeRateFor(difficulty) {
	return MISTAKE_RATES.hasOwnProperty(difficulty) ? MISTAKE_RATES[difficulty] : MISTAKE_RATES[DEFAULT_DIFFICULTY];
}

function speedFor(difficulty) {
	return DIFFICULTY_SPEEDS.hasOwnProperty(difficulty) ? DIFFICULTY_SPEEDS[difficulty] : DIFFICULTY_SPEEDS[DEFAULT_DIFFICULTY];
}

// Elo range we map bot strength across.
var ELO_MIN = 600, ELO_MAX = 1800;

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function lerp(a, b, t) { return a + (b - a) * t; }

// Build a bot tuned to play at roughly `elo`. Strength rises with elo via two
// knobs — faster pace and fewer blunders. A random "style" then trades those off
// (slow & safe ⇄ fast & reckless). To keep style roughly strength-neutral, the
// per-move speed bonus a reckless bot gets is derived from the expected penalty
// cost of its extra blunders, so the time saved ≈ the time lost to mines.
var STYLE_MISTAKE = 1.0;   // reckless doubles blunders; safe drops them to ~0
var MINE_PROB = 0.3;       // ~chance a blunder actually uncovers a mine
var PENALTY_MS = 5000;     // ranked death-penalty freeze

function configForElo(elo) {
	var s = clamp((elo - ELO_MIN) / (ELO_MAX - ELO_MIN), 0, 1);
	var baseSpeed = lerp(950, 130, s);       // ms between actions; faster as s rises
	var baseMistake = lerp(0.06, 0.002, s);  // blunder chance; lower as s rises
	var style = Math.random() * 2 - 1;        // -1 = slow & safe, +1 = fast & reckless

	// Extra blunders from +style cost ~ (baseMistake*STYLE_MISTAKE)*MINE_PROB*PENALTY_MS
	// per move; give that same amount back as a per-move speed bonus so the styles
	// stay about equally strong.
	var speedSwing = baseMistake * STYLE_MISTAKE * MINE_PROB * PENALTY_MS;
	var speedMs = Math.round(clamp(baseSpeed - style * speedSwing, 70, 1400));
	var mistakeRate = clamp(baseMistake * (1 + STYLE_MISTAKE * style), 0, 0.4);
	return {
		rating: Math.round(elo),
		speedMs: speedMs,
		mistakeRate: mistakeRate,
		style: style,
		reckless: style > 0
	};
}

var BOT_NAMES = [
	"Botty", "Sweeper", "Minnie", "Clicker", "Flagger",
	"Defuser", "Tickr", "Boomer", "Sniffer", "Probe"
];

function pickBotName(taken) {
	for (var i = 0; i < BOT_NAMES.length; i++) {
		if (taken.indexOf(BOT_NAMES[i]) === -1) return BOT_NAMES[i];
	}
	return "Bot " + (Math.floor(Math.random() * 1000));
}

function neighbors(r, c) {
	var ret = [];
	for (var dr = -1; dr <= 1; dr++) {
		for (var dc = -1; dc <= 1; dc++) {
			if (dr === 0 && dc === 0) continue;
			var nr = r + dr;
			var nc = c + dc;
			if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
			ret.push([nr, nc]);
		}
	}
	return ret;
}

var LOCAL_RADIUS = 4; // bots work cells within this distance of their focus before jumping

function decideMove(game) {
	var best = computeBestMove(game);
	// A blunder is only possible when the bot was about to make a guaranteed move
	// (not the forced opening click and not an already-uncertain guess).
	if (best && best.certain && !best.opening) {
		var rate = game.botMistakeRate || 0;
		if (rate > 0 && Math.random() < rate) {
			var blunder = pickFrontierGuess(game);
			if (blunder) { game.botFocus = { r: blunder.r, c: blunder.c }; return blunder; }
		}
	}
	return best;
}

// Choose among equally-certain actions by locality: stay within LOCAL_RADIUS of the
// bot's current focus (picking randomly within it, so order varies), and when that
// neighbourhood is exhausted, jump to a random action elsewhere. Gives each bot a
// random starting area and organic, varied jumps between sections.
function pickByFocus(game, actions) {
	if (!game.botFocus) {
		var seed = actions[Math.floor(Math.random() * actions.length)];
		game.botFocus = { r: seed.r, c: seed.c };
	}
	var f = game.botFocus;
	var local = actions.filter(function(a) {
		var dr = a.r - f.r, dc = a.c - f.c;
		return Math.sqrt(dr * dr + dc * dc) <= LOCAL_RADIUS;
	});
	var pool = local.length ? local : actions;
	return pool[Math.floor(Math.random() * pool.length)];
}

// Pick a random unknown cell that borders a revealed number — where a hasty human
// would plausibly misclick. Returns an uncertain reveal (may hit a mine).
function pickFrontierGuess(game) {
	var board = game.board, state = game.state;
	var frontier = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== UNKNOWN) continue;
			var nbrs = neighbors(r, c);
			for (var k = 0; k < nbrs.length; k++) {
				var rr = nbrs[k][0], cc = nbrs[k][1];
				if (state[rr][cc] === KNOWN && board[rr][cc] > 0) { frontier.push([r, c]); break; }
			}
		}
	}
	if (!frontier.length) return null;
	var pick = frontier[Math.floor(Math.random() * frontier.length)];
	return { type: "left", r: pick[0], c: pick[1], certain: false, mistake: true };
}

function computeBestMove(game) {
	var board = game.board;
	var state = game.state;

	var hasKnown = false;
	for (var r = 0; r < rows && !hasKnown; r++) {
		for (var c = 0; c < cols && !hasKnown; c++) {
			if (state[r][c] === KNOWN) hasKnown = true;
		}
	}
	if (!hasKnown) {
		// Random opening so bots don't all start from the same spot.
		var or = Math.floor(Math.random() * rows), oc = Math.floor(Math.random() * cols);
		game.botFocus = { r: or, c: oc };
		return { type: "left", r: or, c: oc, certain: true, opening: true };
	}

	// A "known mine" is either a FLAGGED cell or a revealed mine (state=KNOWN with
	// board=MINE — i.e., a mine the bot clicked and got penalised for). Both count
	// against a numbered cell's mine budget so deductions still work after a mishit.
	function knownMineCount(nbrs) {
		var n = 0;
		for (var k = 0; k < nbrs.length; k++) {
			var rr = nbrs[k][0], cc = nbrs[k][1];
			if (state[rr][cc] === FLAGGED) n++;
			else if (state[rr][cc] === KNOWN && board[rr][cc] === MINE) n++;
		}
		return n;
	}

	// Collect *all* certain deductions (deduped by cell), then choose by locality so
	// each bot roams the board in its own order rather than sweeping top-left first.
	var safeSet = {}, mineSet = {};
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN) continue;
			var n = board[r][c];
			if (n <= 0) continue;
			var nbrs = neighbors(r, c);
			var unknownList = [];
			for (var i = 0; i < nbrs.length; i++) {
				if (state[nbrs[i][0]][nbrs[i][1]] === UNKNOWN) unknownList.push(nbrs[i]);
			}
			if (unknownList.length === 0) continue;
			var km = knownMineCount(nbrs);
			if (km === n) {
				for (var a = 0; a < unknownList.length; a++) safeSet[unknownList[a][0] + "," + unknownList[a][1]] = unknownList[a];
			} else if (km + unknownList.length === n) {
				for (var b = 0; b < unknownList.length; b++) mineSet[unknownList[b][0] + "," + unknownList[b][1]] = unknownList[b];
			}
		}
	}

	var actions = [];
	for (var ks in safeSet) actions.push({ type: "left", r: safeSet[ks][0], c: safeSet[ks][1], certain: true });
	for (var ms in mineSet) actions.push({ type: "right", r: mineSet[ms][0], c: mineSet[ms][1], certain: true });

	if (actions.length) {
		var pick = pickByFocus(game, actions);
		game.botFocus = { r: pick.r, c: pick.c };
		return pick;
	}

	// Stuck — guess at a random frontier cell (or any unknown) and jump focus there.
	var guess = pickFrontierGuess(game);
	if (!guess) {
		var candidates = [];
		for (var r3 = 0; r3 < rows; r3++) {
			for (var c3 = 0; c3 < cols; c3++) {
				if (state[r3][c3] === UNKNOWN) candidates.push([r3, c3]);
			}
		}
		if (candidates.length === 0) return null;
		var p = candidates[Math.floor(Math.random() * candidates.length)];
		guess = { type: "left", r: p[0], c: p[1], certain: false };
	}
	game.botFocus = { r: guess.r, c: guess.c };
	return guess;
}

// Returns ms to wait before performing `move` from `lastClick`. `baseMs` is the
// room's bot-speed setting (a baseline "thinking" pace). The model:
//   - log-scaled distance term (a saccade/refocus tax — farther = slower)
//   - thinking pause when guessing (no certain deduction)
//   - extra pause on the very first move of a round (planning the opening)
//   - small Gaussian-ish jitter so two consecutive ticks never look identical
function computeMoveDelay(baseMs, lastClick, move) {
	var distance = 0;
	if (lastClick) {
		distance = Math.max(
			Math.abs(lastClick.r - move.r),
			Math.abs(lastClick.c - move.c)
		);
	}
	// log scaling: ~30ms per square for short hops, levelling off for long ones
	var distanceTerm = distance === 0 ? 0 : 40 + 55 * Math.log2(distance + 1);
	var thinkingTerm = 0;
	if (move.opening) thinkingTerm = Math.max(250, baseMs * 0.6);
	else if (!move.certain) thinkingTerm = Math.max(150, baseMs * 0.4);
	// average-of-three uniforms ≈ approximately normal, mean 0, range ~[-1, 1]
	var n = (Math.random() + Math.random() + Math.random()) / 1.5 - 1;
	var jitter = n * baseMs * 0.18;
	var total = baseMs + distanceTerm + thinkingTerm + jitter;
	return Math.max(60, Math.round(total));
}

exports.decideMove = decideMove;
exports.computeMoveDelay = computeMoveDelay;
exports.pickBotName = pickBotName;
exports.DIFFICULTIES = DIFFICULTIES;
exports.DEFAULT_DIFFICULTY = DEFAULT_DIFFICULTY;
exports.mistakeRateFor = mistakeRateFor;
exports.speedFor = speedFor;
exports.configForElo = configForElo;
