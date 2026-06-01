// Shared puzzle-deduction primitives operating on the standard state grid
// (KNOWN / UNKNOWN / FLAGGED values from BoardLogic). PuzzleGenerator's
// analyzer keeps its own arrays-based form for now; this module exists so
// the in-game *hint* analyzer in minesweeperServer.js can use the same
// trivial / subset / enum logic the generator uses to classify puzzles —
// including enum, which the hint previously couldn't reach.
//
// Output of every pass is a list of {clueCells, safeCells, mineCells}
// step records, so the caller can render the deduction visually or apply
// it to the state and look for the next step.

var BoardLogic = require("../common/BoardLogic");
var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN, FLAGGED = BoardLogic.FLAGGED;

var ENUM_CAP = 18;

function constraintAt(board, state, r, c) {
	var rows = board.length, cols = board[0].length;
	var flagged = 0, covered = [];
	BoardLogic.forEachNeighbour(r, c, rows, cols, function(nr, nc) {
		if (state[nr][nc] === FLAGGED) flagged++;
		else if (state[nr][nc] === UNKNOWN) covered.push([nr, nc]);
	});
	return { clue: board[r][c], flagged: flagged, covered: covered, need: board[r][c] - flagged };
}

// Walk every revealed clue once, return ALL "fully-determined" deductions:
// clue == flagged → covered are safe, or clue - flagged == covered.length →
// covered are mines. Each step pinpoints the single clue that drove it.
function findTrivialSteps(board, state) {
	var rows = board.length, cols = board[0].length;
	var steps = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			var ctx = constraintAt(board, state, r, c);
			if (!ctx.covered.length) continue;
			if (ctx.clue === ctx.flagged) {
				steps.push({ clueCells: [[r, c]], safeCells: ctx.covered, mineCells: [] });
			} else if (ctx.need === ctx.covered.length) {
				steps.push({ clueCells: [[r, c]], safeCells: [], mineCells: ctx.covered });
			}
		}
	}
	return steps;
}

function gatherSubsetConstraints(board, state) {
	var rows = board.length, cols = board[0].length;
	var out = [];
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			var ctx = constraintAt(board, state, r, c);
			if (!ctx.covered.length) continue;
			out.push({ r: r, c: c, cells: ctx.covered, need: ctx.need });
		}
	}
	return out;
}

// Pairs of clue constraints whose covered cells nest. Returns steps where
// the extras are all safe (need diff = 0) or all mines (need diff = extras.length).
function findSubsetSteps(board, state) {
	var cs = gatherSubsetConstraints(board, state);
	var steps = [];
	for (var i = 0; i < cs.length; i++) {
		for (var j = 0; j < cs.length; j++) {
			if (i === j) continue;
			var a = cs[i], b = cs[j];
			if (a.cells.length >= b.cells.length) continue;
			var bSet = {};
			for (var k = 0; k < b.cells.length; k++) bSet[b.cells[k][0] + "," + b.cells[k][1]] = true;
			var isSubset = true;
			for (var k = 0; k < a.cells.length; k++) {
				if (!bSet[a.cells[k][0] + "," + a.cells[k][1]]) { isSubset = false; break; }
			}
			if (!isSubset) continue;
			var aSet = {};
			for (var k = 0; k < a.cells.length; k++) aSet[a.cells[k][0] + "," + a.cells[k][1]] = true;
			var extras = [];
			for (var k = 0; k < b.cells.length; k++) {
				if (!aSet[b.cells[k][0] + "," + b.cells[k][1]]) extras.push(b.cells[k]);
			}
			if (!extras.length) continue;
			var diff = b.need - a.need;
			if (diff === 0) {
				steps.push({ clueCells: [[a.r, a.c], [b.r, b.c]], safeCells: extras, mineCells: [] });
			} else if (diff === extras.length) {
				steps.push({ clueCells: [[a.r, a.c], [b.r, b.c]], safeCells: [], mineCells: extras });
			}
		}
	}
	return steps;
}

function popcount(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }

// Brute-force enumeration over each independent frontier component (cells
// linked by sharing a constraint clue). Catches 1-2-1 patterns, multi-clue
// chains, and other case-analysis puzzles. Capped at ENUM_CAP=18 cells
// per component (2^18 = 262K configurations). For each component that
// produces a deduction, returns a single step listing every clue cell
// touching the component plus the cells determined as safe or mine.
function findEnumSteps(board, state, opts) {
	opts = opts || {};
	var cap = opts.cap || ENUM_CAP;
	var rows = board.length, cols = board[0].length;
	var varId = {}, varList = [], raw = [];
	// Track which clues feed each constraint so we can name them in the step.
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			var ctx = constraintAt(board, state, r, c);
			if (!ctx.covered.length) continue;
			var ids = [];
			for (var k = 0; k < ctx.covered.length; k++) {
				var key = ctx.covered[k][0] + "," + ctx.covered[k][1];
				if (varId[key] === undefined) { varId[key] = varList.length; varList.push(ctx.covered[k]); }
				ids.push(varId[key]);
			}
			raw.push({ clueR: r, clueC: c, ids: ids, need: ctx.need });
		}
	}
	if (varList.length === 0) return [];

	// Union-find: link variables that share a constraint.
	var parent = [];
	for (var v = 0; v < varList.length; v++) parent.push(v);
	function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
	for (var ci = 0; ci < raw.length; ci++) {
		var idsC = raw[ci].ids;
		for (var t = 1; t < idsC.length; t++) parent[find(idsC[t])] = find(idsC[0]);
	}
	var comps = {};
	for (var w = 0; w < varList.length; w++) {
		var root = find(w);
		(comps[root] || (comps[root] = [])).push(w);
	}

	var steps = [];
	for (var rootKey in comps) {
		var vars = comps[rootKey];
		var k2 = vars.length;
		if (k2 > cap) continue;
		var rootKeyInt = parseInt(rootKey, 10);
		var local = {};
		for (var li = 0; li < k2; li++) local[vars[li]] = li;
		var cons = [];
		var clueCellSet = {};
		var clueCells = [];
		for (var rc2 = 0; rc2 < raw.length; rc2++) {
			if (find(raw[rc2].ids[0]) !== rootKeyInt) continue;
			var mask = 0;
			for (var m = 0; m < raw[rc2].ids.length; m++) mask |= (1 << local[raw[rc2].ids[m]]);
			cons.push({ mask: mask, need: raw[rc2].need });
			var ck = raw[rc2].clueR + "," + raw[rc2].clueC;
			if (!clueCellSet[ck]) { clueCellSet[ck] = true; clueCells.push([raw[rc2].clueR, raw[rc2].clueC]); }
		}
		var orCount = new Array(k2).fill(0), solCount = 0;
		var total = 1 << k2;
		for (var a = 0; a < total; a++) {
			var ok = true;
			for (var cc = 0; cc < cons.length; cc++) {
				if (popcount(a & cons[cc].mask) !== cons[cc].need) { ok = false; break; }
			}
			if (!ok) continue;
			solCount++;
			for (var b = 0; b < k2; b++) if (a & (1 << b)) orCount[b]++;
		}
		if (solCount === 0) continue;
		var safeCells = [], mineCells = [];
		for (var f = 0; f < k2; f++) {
			var cell = varList[vars[f]];
			if (orCount[f] === 0) safeCells.push(cell);
			else if (orCount[f] === solCount) mineCells.push(cell);
		}
		if (safeCells.length || mineCells.length) {
			steps.push({ clueCells: clueCells, safeCells: safeCells, mineCells: mineCells, componentSize: k2 });
		}
	}
	return steps;
}

// Mutate state by applying a step: KNOWN for safe cells (no cascade — the
// caller can run cascade if it wants), FLAGGED for mine cells.
function applyStep(state, step) {
	for (var i = 0; i < step.safeCells.length; i++) {
		var c = step.safeCells[i];
		if (state[c[0]][c[1]] !== KNOWN) state[c[0]][c[1]] = KNOWN;
	}
	for (var j = 0; j < step.mineCells.length; j++) {
		var c2 = step.mineCells[j];
		if (state[c2[0]][c2[1]] !== FLAGGED) state[c2[0]][c2[1]] = FLAGGED;
	}
}

// Find the next deduction that opens a safe reveal. Chains through forced-
// mine deductions in a scratch state copy so the hint always lands on a
// cell to *reveal*. Returns { kind, clueCells, safeCells } or null.
//
// The returned clueCells include every clue that participated along the
// chain — i.e. the 1 in a 1-2-1 pattern stays highlighted even after the
// chain auto-flags the corner and walks downstream to the safe cell.
function findFirstSafeStep(board, originalState) {
	var rows = board.length;
	var state = new Array(rows);
	for (var r = 0; r < rows; r++) state[r] = originalState[r].slice();

	function mergeCells(a, b) {
		var seen = {}, out = [];
		for (var i = 0; i < a.length; i++) {
			var k = a[i][0] + "," + a[i][1];
			if (!seen[k]) { seen[k] = true; out.push(a[i]); }
		}
		for (var i = 0; i < b.length; i++) {
			var k = b[i][0] + "," + b[i][1];
			if (!seen[k]) { seen[k] = true; out.push(b[i]); }
		}
		return out;
	}

	var chainClues = [];
	var firstFlagStep = null;

	function firstSafe(steps) {
		for (var i = 0; i < steps.length; i++) if (steps[i].safeCells.length) return steps[i];
		return null;
	}
	function firstMine(steps) {
		for (var i = 0; i < steps.length; i++) if (steps[i].mineCells.length) return steps[i];
		return null;
	}
	function tryLevel(steps, kind) {
		var safe = firstSafe(steps);
		if (safe) return { resolved: true, hint: {
			kind: kind,
			clueCells: mergeCells(safe.clueCells, chainClues),
			safeCells: safe.safeCells,
			componentSize: safe.componentSize
		} };
		var mine = firstMine(steps);
		if (mine) {
			if (!firstFlagStep) {
				firstFlagStep = {
					kind: kind + "-flag",
					clueCells: mine.clueCells.slice(),
					mineCells: mine.mineCells
				};
			}
			chainClues = mergeCells(chainClues, mine.clueCells);
			applyStep(state, mine);
			return { resolved: false, advanced: true };
		}
		return { resolved: false, advanced: false };
	}

	// Prefer the simplest deduction at every chain step: exhaust trivial
	// (safe or forced-mine) before considering subset; exhaust subset before
	// considering enum. This way a trivial-flag-then-trivial-safe chain
	// resolves at the trivial tier rather than escalating to enum just
	// because enum happens to also see a safe cell.
	while (true) {
		var r1 = tryLevel(findTrivialSteps(board, state), "trivial");
		if (r1.resolved) return r1.hint;
		if (r1.advanced) continue;
		var r2 = tryLevel(findSubsetSteps(board, state), "subset");
		if (r2.resolved) return r2.hint;
		if (r2.advanced) continue;
		var r3 = tryLevel(findEnumSteps(board, state), "enum");
		if (r3.resolved) return r3.hint;
		if (r3.advanced) continue;
		break;
	}
	if (firstFlagStep) return firstFlagStep;
	return null;
}

// --- Pass-runner helpers used by the puzzle generator's analyzer -----------
// These mirror the per-sweep "find a deduction and apply it inline" shape
// that analyzeWithTracking originally used: one row-major sweep through the
// board, mutating state as deductions are found so subsequent cells in
// the same sweep benefit from prior reveals. Each returns whether the
// sweep made any progress.
//
// `revealCell(r, c)` is supplied by the caller — it cascades through the
// state (zeros open their neighbours, etc.). Flagging never cascades, so
// it's done inline.

function applyTrivialPass(board, state, revealCell) {
	var rows = board.length, cols = board[0].length;
	var prog = false;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== KNOWN || board[r][c] <= 0) continue;
			var ctx = constraintAt(board, state, r, c);
			if (!ctx.covered.length) continue;
			if (ctx.clue === ctx.flagged) {
				for (var i = 0; i < ctx.covered.length; i++) {
					revealCell(ctx.covered[i][0], ctx.covered[i][1]);
				}
				prog = true;
			} else if (ctx.need === ctx.covered.length) {
				for (var j = 0; j < ctx.covered.length; j++) {
					var rc = ctx.covered[j];
					if (state[rc[0]][rc[1]] !== FLAGGED) state[rc[0]][rc[1]] = FLAGGED;
				}
				prog = true;
			}
		}
	}
	return prog;
}

function applySubsetPass(board, state, revealCell) {
	var cs = gatherSubsetConstraints(board, state);
	var prog = false;
	for (var i = 0; i < cs.length; i++) {
		for (var j = 0; j < cs.length; j++) {
			if (i === j) continue;
			var a = cs[i], b = cs[j];
			if (a.cells.length >= b.cells.length) continue;
			var bSet = {};
			for (var k = 0; k < b.cells.length; k++) bSet[b.cells[k][0] + "," + b.cells[k][1]] = true;
			var isSubset = true;
			for (var k = 0; k < a.cells.length; k++) {
				if (!bSet[a.cells[k][0] + "," + a.cells[k][1]]) { isSubset = false; break; }
			}
			if (!isSubset) continue;
			var aSet = {};
			for (var k = 0; k < a.cells.length; k++) aSet[a.cells[k][0] + "," + a.cells[k][1]] = true;
			var extras = [];
			for (var k = 0; k < b.cells.length; k++) {
				if (!aSet[b.cells[k][0] + "," + b.cells[k][1]]) extras.push(b.cells[k]);
			}
			if (!extras.length) continue;
			var diff = b.need - a.need;
			if (diff === 0) {
				for (var k = 0; k < extras.length; k++) {
					var er = extras[k][0], ec = extras[k][1];
					if (state[er][ec] === UNKNOWN) { revealCell(er, ec); prog = true; }
				}
			} else if (diff === extras.length) {
				for (var k = 0; k < extras.length; k++) {
					var er2 = extras[k][0], ec2 = extras[k][1];
					if (state[er2][ec2] !== FLAGGED) { state[er2][ec2] = FLAGGED; prog = true; }
				}
			}
		}
	}
	return prog;
}

// Returns { progress, maxComponentSize } so the analyzer can track which
// frontier component drove the deduction (used for diff-4/5/6 split).
function applyEnumPass(board, state, revealCell, opts) {
	opts = opts || {};
	var cap = opts.cap || ENUM_CAP;
	var steps = findEnumSteps(board, state, { cap: cap });
	var prog = false, maxComp = 0;
	for (var s = 0; s < steps.length; s++) {
		var step = steps[s];
		if (step.componentSize && step.componentSize > maxComp) maxComp = step.componentSize;
		for (var i = 0; i < step.safeCells.length; i++) {
			var sc = step.safeCells[i];
			if (state[sc[0]][sc[1]] === UNKNOWN) { revealCell(sc[0], sc[1]); prog = true; }
		}
		for (var j = 0; j < step.mineCells.length; j++) {
			var mc = step.mineCells[j];
			if (state[mc[0]][mc[1]] !== FLAGGED) { state[mc[0]][mc[1]] = FLAGGED; prog = true; }
		}
	}
	return { progress: prog, maxComponentSize: maxComp };
}

module.exports = {
	ENUM_CAP: ENUM_CAP,
	constraintAt: constraintAt,
	findTrivialSteps: findTrivialSteps,
	findSubsetSteps: findSubsetSteps,
	findEnumSteps: findEnumSteps,
	findFirstSafeStep: findFirstSafeStep,
	applyTrivialPass: applyTrivialPass,
	applySubsetPass: applySubsetPass,
	applyEnumPass: applyEnumPass
};
