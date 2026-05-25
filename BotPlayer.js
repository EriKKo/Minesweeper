var gameCreator = require("./GameCreator");

var MINE = gameCreator.MINE;
var FLAGGED = gameCreator.FLAGGED;
var UNKNOWN = gameCreator.UNKNOWN;
var KNOWN = gameCreator.KNOWN;
var rows = gameCreator.rows;
var cols = gameCreator.cols;

var SPEED_OPTIONS = [200, 400, 800];
var DEFAULT_SPEED = 400;

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

function decideMove(game) {
	var board = game.board;
	var state = game.state;

	var hasKnown = false;
	for (var r = 0; r < rows && !hasKnown; r++) {
		for (var c = 0; c < cols && !hasKnown; c++) {
			if (state[r][c] === KNOWN) hasKnown = true;
		}
	}
	if (!hasKnown) {
		return { type: "left", r: Math.floor(rows / 2), c: Math.floor(cols / 2), certain: true, opening: true };
	}

	// Pass 1: find a certain safe square (a numbered cell whose flagged neighbors equal its number).
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN) continue;
			var n = board[r][c];
			if (n <= 0) continue;
			var nbrs = neighbors(r, c);
			var flagged = 0;
			var unknownList = [];
			for (var i = 0; i < nbrs.length; i++) {
				var nr = nbrs[i][0], nc = nbrs[i][1];
				if (state[nr][nc] === FLAGGED) flagged++;
				else if (state[nr][nc] === UNKNOWN) unknownList.push(nbrs[i]);
			}
			if (unknownList.length === 0) continue;
			if (flagged === n) {
				return { type: "left", r: unknownList[0][0], c: unknownList[0][1], certain: true };
			}
		}
	}

	// Pass 2: flag a certain mine (a numbered cell whose unknown+flagged count equals its number).
	for (var r2 = 0; r2 < rows; r2++) {
		for (var c2 = 0; c2 < cols; c2++) {
			if (state[r2][c2] !== KNOWN) continue;
			var n2 = board[r2][c2];
			if (n2 <= 0) continue;
			var nbrs2 = neighbors(r2, c2);
			var flagged2 = 0;
			var unknownList2 = [];
			for (var j = 0; j < nbrs2.length; j++) {
				var nr2 = nbrs2[j][0], nc2 = nbrs2[j][1];
				if (state[nr2][nc2] === FLAGGED) flagged2++;
				else if (state[nr2][nc2] === UNKNOWN) unknownList2.push(nbrs2[j]);
			}
			if (unknownList2.length === 0) continue;
			if (flagged2 + unknownList2.length === n2) {
				return { type: "right", r: unknownList2[0][0], c: unknownList2[0][1], certain: true };
			}
		}
	}

	// Fallback: pick a random unknown square.
	var candidates = [];
	for (var r3 = 0; r3 < rows; r3++) {
		for (var c3 = 0; c3 < cols; c3++) {
			if (state[r3][c3] === UNKNOWN) candidates.push([r3, c3]);
		}
	}
	if (candidates.length === 0) return null;
	var pick = candidates[Math.floor(Math.random() * candidates.length)];
	return { type: "left", r: pick[0], c: pick[1], certain: false };
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
exports.SPEED_OPTIONS = SPEED_OPTIONS;
exports.DEFAULT_SPEED = DEFAULT_SPEED;
