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

// Generalized constraint subtraction: for every pair of clue constraints
// that *overlap* (share at least one covered cell) but neither is a subset
// of the other, derive bounds on the unique-to-A, unique-to-B, and
// intersection regions. The classic 1-2 pattern (a 1 and a 2 with two
// shared covered neighbours plus one unique neighbour each) is the
// simplest case: the 1's unique neighbour is forced safe, the 2's unique
// neighbour is forced mine. Subset deductions are a special case of this
// (one of the unique regions is empty); we still surface those via the
// subset pass so the tiering stays meaningful.
function findOverlapSteps(board, state) {
	var cs = gatherSubsetConstraints(board, state);
	var steps = [];
	for (var i = 0; i < cs.length; i++) {
		for (var j = i + 1; j < cs.length; j++) {
			var a = cs[i], b = cs[j];
			var aSet = {}, bSet = {};
			for (var k = 0; k < a.cells.length; k++) aSet[a.cells[k][0] + "," + a.cells[k][1]] = a.cells[k];
			for (var k = 0; k < b.cells.length; k++) bSet[b.cells[k][0] + "," + b.cells[k][1]] = b.cells[k];
			var S = [], UA = [], UB = [];
			for (var ka in aSet) {
				if (bSet[ka]) S.push(aSet[ka]);
				else UA.push(aSet[ka]);
			}
			for (var kb in bSet) {
				if (!aSet[kb]) UB.push(bSet[kb]);
			}
			if (S.length === 0) continue;            // disjoint — no overlap to exploit
			if (UA.length === 0 || UB.length === 0) continue; // strict subset; let subset pass handle it
			var sN = S.length, uaN = UA.length, ubN = UB.length;
			// mines(S) bounded by both clues plus the size of S itself.
			var sLo = Math.max(0, a.need - uaN, b.need - ubN);
			var sHi = Math.min(sN, a.need, b.need);
			if (sLo > sHi) continue; // infeasible — shouldn't happen on a valid board
			// Propagate the S bounds back to mines(UA), mines(UB).
			var uaLo = Math.max(0, a.need - sHi), uaHi = Math.min(uaN, a.need - sLo);
			var ubLo = Math.max(0, b.need - sHi), ubHi = Math.min(ubN, b.need - sLo);
			var safeCells = [], mineCells = [];
			function pushRegion(cells, lo, hi, size) {
				if (lo === hi) {
					if (lo === 0) for (var x = 0; x < cells.length; x++) safeCells.push(cells[x]);
					else if (lo === size) for (var y = 0; y < cells.length; y++) mineCells.push(cells[y]);
				}
			}
			pushRegion(S, sLo, sHi, sN);
			pushRegion(UA, uaLo, uaHi, uaN);
			pushRegion(UB, ubLo, ubHi, ubN);
			if (safeCells.length || mineCells.length) {
				steps.push({ clueCells: [[a.r, a.c], [b.r, b.c]], safeCells: safeCells, mineCells: mineCells });
			}
		}
	}
	return steps;
}

var popcount = BoardLogic.popcount;

// Chain deduction: combine two or more clues whose covered sets are
// disjoint subsets of a single "super-clue", then compare their summed
// need to the super-clue's need. The leftover cells in the super-clue
// inherit the residual count, which often collapses to all-safe or
// all-mine. The canonical example is the 1-2-1 corner — two 1-clues whose
// covered sets sit inside a 2-clue's covered set; if the 1-needs add to
// 2, every other cell the 2-clue can see is safe.
//
// Each super-clue is checked against up to CHAIN_SUB_CAP candidate sub-
// clues to bound the 2^k subset enumeration; in practice 8–10 is plenty.
var CHAIN_SUB_CAP = 10;
function findChainSteps(board, state) {
	var cs = gatherSubsetConstraints(board, state);
	var steps = [];
	for (var i = 0; i < cs.length; i++) {
		var C = cs[i];
		if (C.cells.length < 3) continue; // chains only help when the super has ≥3 covered cells
		// Index each of C's covered cells so we can describe subsets as bitmasks.
		var cIdx = {};
		for (var k = 0; k < C.cells.length; k++) cIdx[C.cells[k][0] + "," + C.cells[k][1]] = k;
		var subs = [];
		for (var j = 0; j < cs.length; j++) {
			if (j === i) continue;
			var T = cs[j];
			if (T.cells.length === 0 || T.cells.length >= C.cells.length) continue;
			var mask = 0;
			var allIn = true;
			for (var m = 0; m < T.cells.length; m++) {
				var idx = cIdx[T.cells[m][0] + "," + T.cells[m][1]];
				if (idx === undefined) { allIn = false; break; }
				mask |= (1 << idx);
			}
			if (!allIn) continue;
			subs.push({ mask: mask, need: T.need, r: T.r, c: T.c });
		}
		if (subs.length < 2) continue; // single-sub case is plain subset — handled elsewhere
		if (subs.length > CHAIN_SUB_CAP) subs.length = CHAIN_SUB_CAP;
		var fullMask = (1 << C.cells.length) - 1;
		var nSubs = subs.length;
		var totalCombos = 1 << nSubs;
		var found = null;
		for (var bits = 1; bits < totalCombos && !found; bits++) {
			// Require ≥2 sub-clues — singletons collapse to the subset pass.
			var bc = 0; for (var x = bits; x; x &= x - 1) bc++;
			if (bc < 2) continue;
			var combined = 0;
			var needSum = 0;
			var ok = true;
			var chainClues = [[C.r, C.c]];
			for (var b = 0; b < nSubs; b++) {
				if (!(bits & (1 << b))) continue;
				if (combined & subs[b].mask) { ok = false; break; } // sub-clues must be pairwise disjoint
				combined |= subs[b].mask;
				needSum += subs[b].need;
				chainClues.push([subs[b].r, subs[b].c]);
			}
			if (!ok) continue;
			if (combined === fullMask) continue; // sub-clues cover all of C — nothing to deduce in the remainder
			var remMask = fullMask & ~combined;
			var remCount = 0; for (var y = remMask; y; y &= y - 1) remCount++;
			var remNeed = C.need - needSum;
			if (remNeed < 0 || remNeed > remCount) continue; // infeasible combination, skip
			if (remNeed !== 0 && remNeed !== remCount) continue;
			var remCells = [];
			for (var rb = 0; rb < C.cells.length; rb++) {
				if (remMask & (1 << rb)) remCells.push(C.cells[rb]);
			}
			if (remNeed === 0) found = { clueCells: chainClues, safeCells: remCells, mineCells: [] };
			else found = { clueCells: chainClues, safeCells: [], mineCells: remCells };
		}
		if (found) steps.push(found);
	}
	return steps;
}

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

	return walkSolverTiers(board, state, "enum", tryLevel, function() { return firstFlagStep; });
}

// Tier-capped variant: the bot uses this so a 600-Elo player can't see
// overlap deductions a 1700-Elo player would.  Same chain logic as
// findFirstSafeStep, but stops escalating beyond `maxTier`.
//
// `allow(r, c)` (optional) restricts which SAFE cells count as a usable result — territory bots may
// only reveal their own frontier (canTarget), so a safe deduction whose cells are all off-frontier is
// no use to them: we skip it and keep searching deeper instead of returning a move the bot can't make
// (which would otherwise fall through to a needless guess). Omitted → any safe cell counts (racing).
function findFirstSafeStepCapped(board, originalState, maxTier, allow) {
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
	// First step with a usable safe cell. With `allow`, only allowed safe cells count and the returned
	// step carries just those (so the caller always gets a move it can make); without it, any safe step.
	function firstSafe(steps) {
		for (var i = 0; i < steps.length; i++) {
			var sc = steps[i].safeCells;
			if (!sc || !sc.length) continue;
			if (!allow) return steps[i];
			var ok = [];
			for (var j = 0; j < sc.length; j++) if (allow(sc[j][0], sc[j][1])) ok.push(sc[j]);
			if (ok.length) return { safeCells: ok, clueCells: steps[i].clueCells, componentSize: steps[i].componentSize };
		}
		return null;
	}
	function firstMine(steps) { for (var i = 0; i < steps.length; i++) if (steps[i].mineCells.length) return steps[i]; return null; }
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
				firstFlagStep = { kind: kind + "-flag", clueCells: mine.clueCells.slice(), mineCells: mine.mineCells };
			}
			chainClues = mergeCells(chainClues, mine.clueCells);
			applyStep(state, mine);
			return { resolved: false, advanced: true };
		}
		return { resolved: false, advanced: false };
	}
	return walkSolverTiers(board, state, maxTier, tryLevel, function() { return firstFlagStep; });
}

// Shared loop body for findFirstSafeStep and findFirstSafeStepCapped.
// Walks trivial → subset → overlap → chain → enum, stopping at `maxTier`.
function walkSolverTiers(board, state, maxTier, tryLevel, getFlag) {
	var TIER_ORDER = ["trivial", "subset", "overlap", "chain", "enum"];
	var cap = TIER_ORDER.indexOf(maxTier);
	if (cap < 0) cap = TIER_ORDER.length - 1; // unknown → no cap
	while (true) {
		var r1 = tryLevel(findTrivialSteps(board, state), "trivial");
		if (r1.resolved) return r1.hint;
		if (r1.advanced) continue;
		if (cap < 1) break;
		var r2 = tryLevel(findSubsetSteps(board, state), "subset");
		if (r2.resolved) return r2.hint;
		if (r2.advanced) continue;
		if (cap < 2) break;
		var r2o = tryLevel(findOverlapSteps(board, state), "overlap");
		if (r2o.resolved) return r2o.hint;
		if (r2o.advanced) continue;
		if (cap < 3) break;
		var r2c = tryLevel(findChainSteps(board, state), "chain");
		if (r2c.resolved) return r2c.hint;
		if (r2c.advanced) continue;
		if (cap < 4) break;
		var r3 = tryLevel(findEnumSteps(board, state), "enum");
		if (r3.resolved) return r3.hint;
		if (r3.advanced) continue;
		break;
	}
	var ff = getFlag();
	if (ff) return ff;
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

function applyChainPass(board, state, revealCell) {
	var steps = findChainSteps(board, state);
	var prog = false;
	for (var s = 0; s < steps.length; s++) {
		var step = steps[s];
		for (var i = 0; i < step.safeCells.length; i++) {
			var sc = step.safeCells[i];
			if (state[sc[0]][sc[1]] === UNKNOWN) { revealCell(sc[0], sc[1]); prog = true; }
		}
		for (var j = 0; j < step.mineCells.length; j++) {
			var mc = step.mineCells[j];
			if (state[mc[0]][mc[1]] !== FLAGGED) { state[mc[0]][mc[1]] = FLAGGED; prog = true; }
		}
	}
	return prog;
}

function applyOverlapPass(board, state, revealCell) {
	var steps = findOverlapSteps(board, state);
	var prog = false;
	for (var s = 0; s < steps.length; s++) {
		var step = steps[s];
		for (var i = 0; i < step.safeCells.length; i++) {
			var sc = step.safeCells[i];
			if (state[sc[0]][sc[1]] === UNKNOWN) { revealCell(sc[0], sc[1]); prog = true; }
		}
		for (var j = 0; j < step.mineCells.length; j++) {
			var mc = step.mineCells[j];
			if (state[mc[0]][mc[1]] !== FLAGGED) { state[mc[0]][mc[1]] = FLAGGED; prog = true; }
		}
	}
	return prog;
}

// Apply enum on the **smallest** component that yields a deduction, not
// every yielding component at once. After the analyzer wakes back up,
// the simpler trivial/subset/overlap/chain passes get another shot at
// the freshly-revealed state before the next enum is considered. The
// returned `maxComponentSize` is the size of the one step we applied,
// so the analyzer's running max tracks the hardest single enum step
// it needed rather than coincidentally-yielding larger components.
function applyEnumPass(board, state, revealCell, opts) {
	opts = opts || {};
	var cap = opts.cap || ENUM_CAP;
	var steps = findEnumSteps(board, state, { cap: cap });
	if (!steps.length) return { progress: false, maxComponentSize: 0 };
	var best = steps[0];
	for (var s = 1; s < steps.length; s++) {
		if (steps[s].componentSize < best.componentSize) best = steps[s];
	}
	var prog = false;
	for (var i = 0; i < best.safeCells.length; i++) {
		var sc = best.safeCells[i];
		if (state[sc[0]][sc[1]] === UNKNOWN) { revealCell(sc[0], sc[1]); prog = true; }
	}
	for (var j = 0; j < best.mineCells.length; j++) {
		var mc = best.mineCells[j];
		if (state[mc[0]][mc[1]] !== FLAGGED) { state[mc[0]][mc[1]] = FLAGGED; prog = true; }
	}
	return { progress: prog, maxComponentSize: best.componentSize };
}

module.exports = {
	ENUM_CAP: ENUM_CAP,
	constraintAt: constraintAt,
	findTrivialSteps: findTrivialSteps,
	findSubsetSteps: findSubsetSteps,
	findOverlapSteps: findOverlapSteps,
	findChainSteps: findChainSteps,
	findEnumSteps: findEnumSteps,
	findFirstSafeStep: findFirstSafeStep,
	findFirstSafeStepCapped: findFirstSafeStepCapped,
	applyTrivialPass: applyTrivialPass,
	applySubsetPass: applySubsetPass,
	applyOverlapPass: applyOverlapPass,
	applyChainPass: applyChainPass,
	applyEnumPass: applyEnumPass
};
