var fs = require("fs");
var gameCreator = require("./GameCreator");
var BoardLogic = require("../common/BoardLogic");
var cspSolver = require("./CSPSolver");
// Bots reason with the CSP analyzer but never at/above the case-split threshold (CASE_BASE = 8): a
// human-skill bot shouldn't crack case-analysis boards. Their actual skill ceiling is the per-cell
// difficulty gate (maxDifficulty) applied to whatever safe move this surfaces.
var BOT_COMPLEXITY_CAP = 7.999;

var MINE = BoardLogic.MINE;
var FLAGGED = BoardLogic.FLAGGED;
var UNKNOWN = BoardLogic.UNKNOWN;
var KNOWN = BoardLogic.KNOWN;
// Board dimensions are derived per game from game.board (boards can vary in size).

// Every bot is parameterised by six variables, set on the game object by the server
// (per round) and the headless benchmark, and consumed by decideMove/computeMoveDelay:
//  - speedMs:      flat per-move pace (ms); lower = faster.
//  - difficultyMs: ms of "thinking" added per unit of a move's numeric difficulty
//                  (the CSP complexity of the deduction). Harder move → longer pause.
//  - distanceMult: per-bot multiplier on the mouse-travel term (refocus speed).
//  - maxDifficulty: hardest move (same difficulty scale) the bot can deduce; beyond
//                   it, it can't see the move and has to guess.
//  - mistakeRate:  chance of misclicking a guaranteed-safe move into a frontier guess.
//  - chordRate:    chance of chording when the board geometry allows it.
// The difficulty scale is the CSP solver's complexity, capped at GEN_MAX_COMPLEXITY (7)
// at board generation; trivial counting moves sit at ~1.
var DIFFICULTIES = ["easy", "medium", "hard"];
var DEFAULT_DIFFICULTY = "medium";
// Casual-room difficulty presets on the new variable set: easy bots are slow, think
// hard, can only do near-trivial moves, and blunder; hard bots are fast, think little,
// solve anything, and rarely err.
var DIFFICULTY_PRESETS = {
	easy:   { speedMs: 800, difficultyMs: 350, distanceMult: 1.3, maxDifficulty: 1.5, mistakeRate: 0.09,  chordRate: 0.05 },
	medium: { speedMs: 400, difficultyMs: 180, distanceMult: 1.0, maxDifficulty: 4,   mistakeRate: 0.03,  chordRate: 0.35 },
	hard:   { speedMs: 200, difficultyMs: 80,  distanceMult: 0.8, maxDifficulty: 8,   mistakeRate: 0.008, chordRate: 0.75 }
};

function configForDifficulty(difficulty) {
	var p = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS[DEFAULT_DIFFICULTY];
	return {
		speedMs: p.speedMs, difficultyMs: p.difficultyMs, distanceMult: p.distanceMult,
		maxDifficulty: p.maxDifficulty, mistakeRate: p.mistakeRate, chordRate: p.chordRate
	};
}

// Trivial counting moves (direct neighbour deductions + chords) — the bot finds these
// by itself without the solver, so they're the easiest possible move.
var TRIVIAL_DIFFICULTY = 1;

function lerp(a, b, t) { return a + (b - a) * t; }

var PENALTY_MS = 5000;     // ranked death-penalty freeze (used by the benchmark clock)

// The per-Elo reference-bot curve (configForElo) used to live here as the bot-strength
// calibration anchor, but nothing at runtime needs it — ranked filler bots come from the
// pre-benchmarked pool (pickBotFromPool / bots-pool.json). It now lives in BotBench, the
// offline calibration module that's its only consumer.

// Knob ranges for randomly-generated pool bots. Spans (and slightly overshoots) the
// playable range so the pool covers 0–1800 after benchmarking. maxDifficulty runs from
// trivial-only up past GEN_MAX_COMPLEXITY (7) so the strongest bots solve everything.
var RAND = {
	speedMs:       [70, 1400],
	difficultyMs:  [40, 400],
	distanceMult:  [0.4, 2.0],
	maxDifficulty: [1, 8.5],
	mistakeRate:   [0, 0.12],
	chordRate:     [0, 1]
};

// A pool bot is a random point in this six-axis knob-space. The axes vary independently
// — pace, per-difficulty thinking, refocus speed, skill ceiling, blunders, and chording
// aren't tied to one strength dial — so the pool holds genuinely different play styles
// that happen to benchmark to similar Elos. `rating` is filled in by the benchmark.
function randomBotConfig() {
	function u(range) { return lerp(range[0], range[1], Math.random()); }
	return {
		speedMs: Math.round(u(RAND.speedMs)),
		difficultyMs: Math.round(u(RAND.difficultyMs)),
		distanceMult: Math.round(u(RAND.distanceMult) * 100) / 100,
		maxDifficulty: Math.round(u(RAND.maxDifficulty) * 100) / 100,
		mistakeRate: Math.round(u(RAND.mistakeRate) * 10000) / 10000,
		chordRate: Math.round(u(RAND.chordRate) * 1000) / 1000
	};
}

// The benchmarked bot pool, loaded once from bots-pool.json. Each entry carries the
// six per-move variables addBotToRoom consumes plus measured `rating`/`ratings`/`times`.
var botPool = null;
var botPoolMeta = null; // { densities, board, generatedAt, roundMs } — for the admin browser

function loadPool(poolPath) {
	try {
		var raw = fs.readFileSync(poolPath, "utf8");
		var parsed = JSON.parse(raw);
		botPool = (parsed && Array.isArray(parsed.bots)) ? parsed.bots : null;
		botPoolMeta = parsed ? { densities: parsed.densities, board: parsed.board, generatedAt: parsed.generatedAt, roundMs: parsed.roundMs } : null;
	} catch (e) {
		botPool = null;
		botPoolMeta = null;
		console.error("BotPlayer.loadPool failed for " + poolPath + ":", e.message);
	}
	return botPool ? botPool.length : 0;
}

// Read access for the admin bot browser.
function getPool() { return botPool || []; }
function getPoolMeta() { return botPoolMeta || {}; }

// Pick a ranked filler bot whose measured rating sits near `targetElo`. Selecting
// at random within a ±window gives the natural rating spread that jitterBotElo used
// to add by hand. If the window is empty (sparse pool edge) it widens; if the pool
// is missing entirely (bots-pool.json absent) it returns null, and addBotToRoom
// degrades to a casual-preset bot so matchmaking can never fail to fill a seat.
// `ratingKey` selects which measured rating to match on: undefined → the overall racing `rating`;
// otherwise a per-mode rating in `b.ratings` (e.g. "territory"), falling back to `b.rating` for any
// bot that predates that calibration. The returned bot's `rating` is set to the matched value so the
// rest of matchmaking (display, Elo seeding) uses the right ladder; the pool entry isn't mutated.
function pickBotFromPool(targetElo, window, ratingKey) {
	if (!botPool || !botPool.length) return null;
	function ratingOf(b) { return ratingKey && b.ratings && b.ratings[ratingKey] != null ? b.ratings[ratingKey] : b.rating; }
	function chosen(b) { return ratingKey ? Object.assign({}, b, { rating: ratingOf(b) }) : b; }
	var w = window > 0 ? window : 60;
	for (var widen = 0; widen < 24; widen++) {
		var lo = targetElo - w, hi = targetElo + w;
		var inRange = botPool.filter(function(b) { return ratingOf(b) >= lo && ratingOf(b) <= hi; });
		if (inRange.length) return chosen(inRange[Math.floor(Math.random() * inRange.length)]);
		w += 60;
	}
	// Whole pool somehow outside the widened window — return the nearest bot.
	var nearest = botPool[0];
	for (var i = 1; i < botPool.length; i++) {
		if (Math.abs(ratingOf(botPool[i]) - targetElo) < Math.abs(ratingOf(nearest) - targetElo)) nearest = botPool[i];
	}
	return chosen(nearest);
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

// How many board-cells of extra travel a unit of move difficulty is "worth" when the
// bot chooses its next move. Small, so distance dominates: the bot strongly prefers the
// nearest available move and only takes a harder one when it's meaningfully closer.
var DIFFICULTY_DISTANCE_WEIGHT = 0.5;
var FOCUS_JITTER = 0.3; // tiny random tiebreak so equally-close moves vary a little

function decideMove(game) {
	var best = computeBestMove(game);
	// A blunder is only possible when the bot was about to make a guaranteed move
	// (not the forced opening click and not an already-uncertain guess).
	if (best && best.certain && !best.opening) {
		var rate = game.botMistakeRate || 0;
		if (rate > 0 && Math.random() < rate) {
			var blunder = pickFrontierGuess(game);
			// A hasty misclick is quick — treat it as a trivial-effort move, not a
			// deliberated guess, so it doesn't earn a long thinking pause.
			if (blunder) { blunder.difficulty = TRIVIAL_DIFFICULTY; game.botFocus = { r: blunder.r, c: blunder.c }; return blunder; }
		}
	}
	return best;
}

// Choose the next action by a distance-dominated cost from the bot's current focus:
//   cost = distance + DIFFICULTY_DISTANCE_WEIGHT * difficulty + small jitter
// so the bot works its local area tightly — picking the nearest move, and preferring a
// closer-but-harder move over a farther easier one — rather than jumping around. Each
// move's `difficulty` is its CSP complexity (harder-to-count cells cost a little more).
function pickByFocus(game, actions) {
	if (!game.botFocus) {
		var seed = actions[Math.floor(Math.random() * actions.length)];
		game.botFocus = { r: seed.r, c: seed.c };
	}
	var f = game.botFocus;
	var best = null, bestCost = Infinity;
	for (var i = 0; i < actions.length; i++) {
		var a = actions[i];
		var dr = a.r - f.r, dc = a.c - f.c;
		var dist = Math.sqrt(dr * dr + dc * dc);
		var diff = (typeof a.difficulty === "number") ? a.difficulty : TRIVIAL_DIFFICULTY;
		var cost = dist + DIFFICULTY_DISTANCE_WEIGHT * diff + Math.random() * FOCUS_JITTER;
		if (cost < bestCost) { bestCost = cost; best = a; }
	}
	return best;
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
			if (game.canTarget && !game.canTarget(r, c)) continue; // territory: only its own frontier
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
				// A chord's difficulty is the hardest of the cells it reveals.
				if (unknownList.length >= 2) {
					var chordDiff = 0;
					for (var cd = 0; cd < unknownList.length; cd++) chordDiff = Math.max(chordDiff, cellDifficulty(game, unknownList[cd][0], unknownList[cd][1]));
					chordList.push({ r: r, c: c, gain: unknownList.length, difficulty: chordDiff });
				}
			} else if (km + unknownList.length === n) {
				for (var b = 0; b < unknownList.length; b++) mineSet[unknownList[b][0] + "," + unknownList[b][1]] = unknownList[b];
			}
		}
	}

	// With probability chordRate, prefer a chord when one is available.  Locality
	// still applies — pick the chord candidate nearest the current focus so the
	// bot's path through the board feels continuous.
	if (!game.revealsOnly && chordList.length > 0) {
		var chordRate = typeof game.botChordRate === "number" ? game.botChordRate : 0;
		if (chordRate > 0 && Math.random() < chordRate) {
			var chordActions = chordList.map(function(x) {
				return { type: "left", r: x.r, c: x.c, certain: true, chord: true, difficulty: x.difficulty };
			});
			var chordPick = pickByFocus(game, chordActions);
			game.botFocus = { r: chordPick.r, c: chordPick.c };
			return chordPick;
		}
	}

	// Even trivial counting moves carry their real CSP difficulty: counting against more
	// covered cells / mines is genuinely harder, so those cells cost a little more and the
	// locality picker treats them as slightly less attractive.
	// Territory restricts reveals to the bot's own frontier (game.canTarget) and never flags
	// (game.revealsOnly); both are absent for the racing modes, leaving their behaviour unchanged.
	var actions = [];
	for (var ks in safeSet) { if (!game.canTarget || game.canTarget(safeSet[ks][0], safeSet[ks][1])) actions.push({ type: "left", r: safeSet[ks][0], c: safeSet[ks][1], certain: true, difficulty: cellDifficulty(game, safeSet[ks][0], safeSet[ks][1]) }); }
	if (!game.revealsOnly) for (var ms in mineSet) actions.push({ type: "right", r: mineSet[ms][0], c: mineSet[ms][1], certain: true, difficulty: cellDifficulty(game, mineSet[ms][0], mineSet[ms][1]) });

	if (actions.length) {
		var pick = pickByFocus(game, actions);
		game.botFocus = { r: pick.r, c: pick.c };
		return pick;
	}

	// No trivial move. Find the easiest deducible move (uncapped probe — fast), then
	// gate on the bot's max difficulty using the board's precomputed difficulty map.
	// A bot that can't reason that hard never sees the move and falls through to a guess.
	// `game.canTarget` is passed straight into the solver (territory only) so it searches for a safe
	// move the bot can actually make — a safe deduction off the bot's frontier won't be returned and
	// then discarded into a guess; the solver keeps looking for a frontier-safe move instead.
	var maxDifficulty = (typeof game.botMaxDifficulty === "number") ? game.botMaxDifficulty : TRIVIAL_DIFFICULTY;
	var hint = cspSolver.findNextSafeStep(board, state, { allow: game.canTarget, maxComplexity: BOT_COMPLEXITY_CAP });
	if (hint) {
		var hintCells = (hint.safeCells && hint.safeCells.length) ? hint.safeCells : (hint.mineCells || []);
		var hintType = (hint.safeCells && hint.safeCells.length) ? "left" : "right";
		if (game.revealsOnly && hintType === "right") hintCells = []; // territory never flags
		if (hintCells.length) {
			// The move's difficulty is the easiest (min) of its cells on the CSP map;
			// fall back to a per-kind estimate if a cell wasn't keyed (e.g. cascade-only).
			var diff = Infinity;
			for (var hc = 0; hc < hintCells.length; hc++) {
				diff = Math.min(diff, cellDifficulty(game, hintCells[hc][0], hintCells[hc][1]));
			}
			if (!isFinite(diff)) diff = kindDifficulty(hint.kind);
			if (diff <= maxDifficulty) {
				var pick = hintCells[Math.floor(Math.random() * hintCells.length)];
				game.botFocus = { r: pick[0], c: pick[1] };
				return { type: hintType, r: pick[0], c: pick[1], certain: true, difficulty: diff };
			}
		}
	}

	// The easiest available deduction is beyond the bot's reach (or none exists): guess.
	// Tag with maxDifficulty + `stuck` so computeMoveDelay budgets a "thought to my
	// limit, then committed" pause proportional to how hard the bot tries.
	var guess = pickFrontierGuess(game);
	if (!guess) {
		var candidates = [];
		for (var r3 = 0; r3 < rows; r3++) {
			for (var c3 = 0; c3 < cols; c3++) {
				if (state[r3][c3] === UNKNOWN && (!game.canTarget || game.canTarget(r3, c3))) candidates.push([r3, c3]);
			}
		}
		if (candidates.length === 0) return null;
		var p = candidates[Math.floor(Math.random() * candidates.length)];
		guess = { type: "left", r: p[0], c: p[1], certain: false };
	}
	guess.difficulty = maxDifficulty;
	guess.stuck = true;
	game.botFocus = { r: guess.r, c: guess.c };
	return guess;
}

// A cell's numeric difficulty from the board's precomputed CSP difficulty map (set on
// the game at round start / in the benchmark). Cells opened only by cascade aren't
// keyed — they were free, so treat them as trivial.
function cellDifficulty(game, r, c) {
	var map = game.botDifficultyByCell;
	if (map) {
		var d = map[r + "," + c];
		if (typeof d === "number") return d;
	}
	return TRIVIAL_DIFFICULTY;
}

// Fallback difficulty when the pass solver finds a move whose cell wasn't in the CSP
// map (rare). Rough per-method complexity so the skill gate still behaves sanely.
function kindDifficulty(kind) {
	var k = kind ? kind.replace("-flag", "") : "subset";
	if (k === "trivial") return 1;
	if (k === "subset") return 2.5;
	if (k === "overlap") return 4;
	if (k === "chain") return 6;
	return 7; // enum / unknown
}

// Returns ms to wait before performing `move`, reading the bot's per-move variables
// off `game` (botSpeedMs / botDifficultyMs / botDistanceMult). The model:
//   - flat per-move pace (speedMs)
//   - distance term (a saccade/refocus tax — farther = slower), scaled per-bot
//   - thinking pause proportional to the move's numeric difficulty × the bot's
//     difficultyMs, so harder deductions visibly take longer (the human feel)
//   - an opening planning beat on the first move of a round
//   - small Gaussian-ish jitter so two consecutive ticks never look identical
//
// The difficulty term is what keeps dense boards fair: a hard chain costs the same
// extra thinking time for everyone (it's absolute, not scaled by pace), so a fast
// bot's edge shrinks exactly where reading hard patterns is what matters.
function computeMoveDelay(game, lastClick, move) {
	var speedMs = (typeof game.botSpeedMs === "number") ? game.botSpeedMs : 400;
	var difficultyMs = (typeof game.botDifficultyMs === "number") ? game.botDifficultyMs : 0;
	var distanceMult = (typeof game.botDistanceMult === "number") ? game.botDistanceMult : 1;

	var distance = 0;
	if (lastClick) {
		distance = Math.max(Math.abs(lastClick.r - move.r), Math.abs(lastClick.c - move.c));
	}
	// log scaling, with a bigger per-hop tax than before so moving across the board
	// genuinely costs time and the bot is rewarded for staying local.
	var distanceTerm = distance === 0 ? 0 : 70 + 110 * Math.log2(distance + 1);

	// Difficulty-scaled thinking. The opening has no difficulty value, so give it a
	// flat planning beat instead. Guesses (stuck/blunder) carry a difficulty too —
	// maxDifficulty for a deliberated stuck guess, trivial for a hasty misclick.
	var difficulty = (typeof move.difficulty === "number") ? move.difficulty : TRIVIAL_DIFFICULTY;
	var thinkingTerm = difficultyMs * difficulty;
	if (move.opening) thinkingTerm = Math.max(thinkingTerm, Math.max(250, speedMs * 0.6));

	// average-of-three uniforms ≈ approximately normal, mean 0, range ~[-1, 1]
	var n = (Math.random() + Math.random() + Math.random()) / 1.5 - 1;
	var jitter = n * speedMs * 0.18;
	var total = speedMs + distanceMult * distanceTerm + thinkingTerm + jitter;
	return Math.max(60, Math.round(total));
}

exports.decideMove = decideMove;
exports.computeMoveDelay = computeMoveDelay;
exports.pickBotName = pickBotName;
exports.DIFFICULTIES = DIFFICULTIES;
exports.DEFAULT_DIFFICULTY = DEFAULT_DIFFICULTY;
exports.configForDifficulty = configForDifficulty;
exports.randomBotConfig = randomBotConfig;
exports.loadPool = loadPool;
exports.pickBotFromPool = pickBotFromPool;
exports.getPool = getPool;
exports.getPoolMeta = getPoolMeta;
exports.PENALTY_MS = PENALTY_MS;
