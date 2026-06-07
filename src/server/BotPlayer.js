var gameCreator = require("./GameCreator");
var BoardLogic = require("../common/BoardLogic");
var puzzleSolver = require("./PuzzleSolver");

var MINE = BoardLogic.MINE;
var FLAGGED = BoardLogic.FLAGGED;
var UNKNOWN = BoardLogic.UNKNOWN;
var KNOWN = BoardLogic.KNOWN;
// Board dimensions are derived per game from game.board (boards can vary in size).

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
// Chord rates: probability that a bot, given a chord opportunity, will take
// it instead of revealing one cell at a time.  Higher-skill bots chord more
// — the time saved (1 click vs N) is what makes them feel sharper, and it
// roughly matches what a real player at that level does.
var CHORD_RATES = { easy: 0.05, medium: 0.35, hard: 0.75 };

function mistakeRateFor(difficulty) {
	return MISTAKE_RATES.hasOwnProperty(difficulty) ? MISTAKE_RATES[difficulty] : MISTAKE_RATES[DEFAULT_DIFFICULTY];
}

function speedFor(difficulty) {
	return DIFFICULTY_SPEEDS.hasOwnProperty(difficulty) ? DIFFICULTY_SPEEDS[difficulty] : DIFFICULTY_SPEEDS[DEFAULT_DIFFICULTY];
}

function chordRateFor(difficulty) {
	return CHORD_RATES.hasOwnProperty(difficulty) ? CHORD_RATES[difficulty] : CHORD_RATES[DEFAULT_DIFFICULTY];
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
	// Chording is a learned speed technique: most beginners click cells one
	// by one; experienced players chord almost every time the geometry
	// allows.  Curve from ~5% at the floor to ~85% at the ceiling; the
	// resulting time savings naturally flow back into apparent skill.
	var chordRate = clamp(lerp(0.05, 0.85, s), 0, 1);
	return {
		rating: Math.round(elo),
		speedMs: speedMs,
		mistakeRate: mistakeRate,
		chordRate: chordRate,
		style: style,
		reckless: style > 0
	};
}

// Pools for generating player-looking handles (so ranked bots blend in).
var NAME_FIRST = [
	"Liam", "Emma", "Noah", "Olivia", "Kai", "Mia", "Leo", "Zoe", "Max", "Aria",
	"Ivan", "Sara", "Tom", "Ana", "Nils", "Oskar", "Freya", "Elin", "Henke", "Sven",
	"Bea", "Patrik", "Sanna", "Milo", "Iris", "Jonas", "Tova", "Felix", "Nora", "Erik"
];
var NAME_WORDS = [
	"shadow", "frost", "nova", "echo", "blaze", "pixel", "rogue", "zen", "drift", "lunar",
	"comet", "raven", "ghost", "turbo", "mango", "viper", "zephyr", "grim", "noodle", "cosmo",
	"jet", "salt", "mint", "fox", "wolf", "ember", "storm", "quartz", "neon", "pine"
];

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function randOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function maybeNum() { return Math.random() < 0.55 ? String(Math.floor(Math.random() * 89) + 10) : ""; }

function generateName() {
	var r = Math.random();
	if (r < 0.3) {
		return randOf(NAME_FIRST) + maybeNum();
	} else if (r < 0.62) {
		var w = randOf(NAME_WORDS);
		w = Math.random() < 0.5 ? cap(w) : w;
		var num = maybeNum();
		var sep = (num && Math.random() < 0.35) ? "_" : "";
		return w + sep + num;
	} else if (r < 0.85) {
		return randOf(NAME_WORDS) + cap(randOf(NAME_WORDS));
	}
	return randOf(NAME_FIRST) + "_" + randOf(NAME_WORDS);
}

function pickBotName(taken) {
	for (var attempt = 0; attempt < 60; attempt++) {
		var name = generateName();
		if (taken.indexOf(name) === -1) return name;
	}
	return "player" + Math.floor(Math.random() * 10000);
}

function neighbors(r, c, rows, cols) {
	return BoardLogic.neighbours(r, c, rows, cols);
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
	var rows = board.length, cols = board[0].length;
	var frontier = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== UNKNOWN) continue;
			var nbrs = neighbors(r, c, rows, cols);
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
	var rows = board.length, cols = board[0].length;

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
	// Also collect chord candidates: revealed number cells whose mine count is fully
	// satisfied by flags AND that still have covered neighbours.  A left-click on
	// any of these triggers the server's chord, revealing every uncovered neighbour
	// in one go — much faster than revealing them one cell at a time.
	var safeSet = {}, mineSet = {}, chordList = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN) continue;
			var n = board[r][c];
			if (n <= 0) continue;
			var nbrs = neighbors(r, c, rows, cols);
			var unknownList = [];
			for (var i = 0; i < nbrs.length; i++) {
				if (state[nbrs[i][0]][nbrs[i][1]] === UNKNOWN) unknownList.push(nbrs[i]);
			}
			if (unknownList.length === 0) continue;
			var km = knownMineCount(nbrs);
			if (km === n) {
				for (var a = 0; a < unknownList.length; a++) safeSet[unknownList[a][0] + "," + unknownList[a][1]] = unknownList[a];
				// Two-or-more covered neighbours is the break-even point: at 2
				// covered cells, chord = 1 click vs 2 individual reveals.  At
				// 1 covered cell, individual reveal is identical in cost so we
				// don't bother — it'd only add noise to the action picker.
				if (unknownList.length >= 2) chordList.push({ r: r, c: c, gain: unknownList.length });
			} else if (km + unknownList.length === n) {
				for (var b = 0; b < unknownList.length; b++) mineSet[unknownList[b][0] + "," + unknownList[b][1]] = unknownList[b];
			}
		}
	}

	// With probability chordRate, prefer a chord when one is available.  Locality
	// still applies — pick the chord candidate nearest the current focus so the
	// bot's path through the board feels continuous.
	if (chordList.length > 0) {
		var chordRate = typeof game.botChordRate === "number" ? game.botChordRate : 0;
		if (chordRate > 0 && Math.random() < chordRate) {
			var chordActions = chordList.map(function(x) {
				return { type: "left", r: x.r, c: x.c, certain: true, chord: true, tier: "trivial" };
			});
			var chordPick = pickByFocus(game, chordActions);
			game.botFocus = { r: chordPick.r, c: chordPick.c };
			return chordPick;
		}
	}

	var actions = [];
	for (var ks in safeSet) actions.push({ type: "left", r: safeSet[ks][0], c: safeSet[ks][1], certain: true, tier: "trivial" });
	for (var ms in mineSet) actions.push({ type: "right", r: mineSet[ms][0], c: mineSet[ms][1], certain: true, tier: "trivial" });

	if (actions.length) {
		var pick = pickByFocus(game, actions);
		game.botFocus = { r: pick.r, c: pick.c };
		return pick;
	}

	// No trivial deduction available — escalate to the solver, which walks
	// subset → overlap → chain → enum and returns the cheapest first.  This
	// lets the bot keep playing accurately on dense boards instead of
	// guessing, and tags the move with its difficulty tier so the per-move
	// delay can budget thinking time appropriately (harder = slower).
	var hint = puzzleSolver.findFirstSafeStep(board, state);
	if (hint) {
		var tier = hint.kind ? hint.kind.replace("-flag", "") : "subset";
		if (hint.safeCells && hint.safeCells.length) {
			var s = hint.safeCells[Math.floor(Math.random() * hint.safeCells.length)];
			game.botFocus = { r: s[0], c: s[1] };
			return { type: "left", r: s[0], c: s[1], certain: true, tier: tier };
		}
		if (hint.mineCells && hint.mineCells.length) {
			var m = hint.mineCells[Math.floor(Math.random() * hint.mineCells.length)];
			game.botFocus = { r: m[0], c: m[1] };
			return { type: "right", r: m[0], c: m[1], certain: true, tier: tier };
		}
	}

	// Truly stuck — guess at a random frontier cell (or any unknown) and jump focus there.
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
//   - thinking pause when the deduction was hard (subset → enum), so the bot
//     visibly hesitates on tough boards instead of click-spamming through
//     deductions a human would pause on
//   - extra pause on the very first move of a round (planning the opening)
//   - small Gaussian-ish jitter so two consecutive ticks never look identical
//
// The tier-based pause is what keeps high-density boards from feeling unfair.
// On a 25%-mine board the bot still needs to chain subset/overlap/enum like a
// real player; without this, it'd power through them at trivial pace.
var TIER_THINKING_MS = {
	trivial: 0,
	subset: 450,
	overlap: 800,
	chain: 1200,
	enum: 1800
};

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
	// Tier-based thinking pause: harder deductions take longer to spot.
	// Max() against the existing thinkingTerm so we don't double-count for
	// uncertain guesses (which already have their own pause).
	var tierMs = (move.tier && TIER_THINKING_MS[move.tier]) || 0;
	if (tierMs > thinkingTerm) thinkingTerm = tierMs;
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
exports.chordRateFor = chordRateFor;
exports.configForElo = configForElo;
