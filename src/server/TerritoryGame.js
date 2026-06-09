// Shared-board state for the 2-player Territory (versus) mode.
//
// Unlike the racing modes (where each player has a private state matrix over a shared layout),
// here there is ONE board and ONE state matrix that both players mutate, plus an `owner` matrix
// recording who claimed each cell. A player may only reveal a covered cell adjacent to their own
// territory (contiguous growth from their corner); the reveal cascades and every newly-opened cell
// becomes theirs. Hitting a mine triggers an EXPLOSION: a patch of the hitter's own territory around
// the mine is re-covered (a reverse cascade on the client), its mines re-generated so the surrounding
// clues stay correct AND the patch is no-guess solvable from its border, and the player is frozen for
// FREEZE_MS. If that re-cover splits your territory, you keep only your largest connected group and
// lose the smaller cut-off sections — so "home" is never a fixed corner, just the biggest area you
// currently hold (it can shift, or shrink to a last stand). The game ends when every safe cell is
// claimed (or the room timer expires); most cells wins.

var BoardLogic = require("../common/BoardLogic");
var cspSolver = require("./CSPSolver");
var KNOWN = BoardLogic.KNOWN, UNKNOWN = BoardLogic.UNKNOWN, MINE = BoardLogic.MINE;

var FREEZE_MS = 3000;

// gen = TerritoryGenerator.generate(...); players = [idA, idB] mapped to starts[0], starts[1].
function create(gen, players) {
	var R = gen.rows, C = gen.cols;
	var state = [], owner = [];
	for (var r = 0; r < R; r++) { state.push(new Array(C).fill(UNKNOWN)); owner.push(new Array(C).fill(null)); }

	var g = {
		rows: R, cols: C, board: gen.board, state: state, owner: owner,
		players: players.slice(), starts: gen.starts,
		frozenUntil: {}, mineHits: {},
		totalSafe: R * C - gen.mineCount, playing: true
	};
	g.mineKnown = {}; // pid -> { "r,c": true } cells this player has detonated (so the bot won't re-pick)
	players.forEach(function(p) { g.frozenUntil[p] = 0; g.mineHits[p] = 0; g.mineKnown[p] = {}; });

	// Seed each player's starting cascade as their territory.
	players.forEach(function(pid, i) {
		(gen.startReveals[i] || []).forEach(function(rc) {
			state[rc[0]][rc[1]] = KNOWN; owner[rc[0]][rc[1]] = pid;
		});
	});

	g.frozen = function(pid, now) { return now < (g.frozenUntil[pid] || 0); };

	// Contiguity: a covered, non-claimed cell with an 8-neighbour this player already owns.
	g.canReveal = function(pid, r, c) {
		if (r < 0 || c < 0 || r >= R || c >= C) return false;
		if (state[r][c] !== UNKNOWN) return false;
		for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
			if (!dr && !dc) continue;
			var nr = r + dr, nc = c + dc;
			if (nr >= 0 && nc >= 0 && nr < R && nc < C && owner[nr][nc] === pid) return true;
		}
		return false;
	};

	// Attempt a reveal. Returns { type } where type is "invalid" | "mine" | "reveal".
	g.reveal = function(pid, r, c, now) {
		if (!g.playing || g.frozen(pid, now)) return { type: "invalid" };
		if (!g.canReveal(pid, r, c)) return { type: "invalid" };
		if (g.board[r][c] === MINE) return g.explode(pid, r, c, now);
		var claimed = [];
		BoardLogic.cascadeReveal(r, c, R, C,
			function(a, b) { return state[a][b] === UNKNOWN && g.board[a][b] !== MINE; },
			function(a, b) { state[a][b] = KNOWN; owner[a][b] = pid; claimed.push([a, b]); return false; },
			function(a, b) { return g.board[a][b]; });
		// Newly walling something off captures it (enclosed covered ground becomes yours).
		var captured = g.captureEnclosed(pid);
		if (g.claimedSafe() >= g.totalSafe) g.playing = false;
		return { type: "reveal", cells: claimed.concat(captured) };
	};

	function nbrs(r, c) {
		var out = [];
		for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
			if (!dr && !dc) continue;
			var nr = r + dr, nc = c + dc;
			if (nr >= 0 && nc >= 0 && nr < R && nc < C) out.push([nr, nc]);
		}
		return out;
	}
	function isMineWith(ov, r, c) { var k = r + "," + c; return (k in ov) ? ov[k] : (g.board[r][c] === MINE); }

	// Hitting a mine triggers an explosion: re-cover a patch of the hitter's own territory around
	// the mine and re-generate the mines under it so (a) every still-revealed clue around the patch
	// stays correct (we preserve, per border cell, the mine-count among its patch neighbours) and
	// (b) the patch is no-guess solvable from that border — the player re-clears it in place without
	// "going around". If no such layout is found within a small search, fall back to a plain freeze.
	g.explode = function(pid, mr, mc, now) {
		var regen = null;
		for (var rad = 2; rad <= 4 && !regen; rad++) regen = computeExplosion(pid, mr, mc, rad);
		g.frozenUntil[pid] = now + FREEZE_MS;
		g.mineHits[pid]++;
		if (!regen) { g.mineKnown[pid][mr + "," + mc] = true; return { type: "mine", cell: [mr, mc], until: g.frozenUntil[pid] }; }
		// Re-cover the patch and write the new layout. `touched` collects every cell this explosion
		// re-covers (the patch + any cut-off section below) for the client's reverse-cascade animation.
		var touched = {};
		function recover(p) {
			state[p[0]][p[1]] = UNKNOWN; owner[p[0]][p[1]] = null;
			delete g.mineKnown[pid][p[0] + "," + p[1]];
			touched[p[0] + "," + p[1]] = p;
		}
		regen.patch.forEach(recover);
		for (var k in regen.clues) { var pr = k.indexOf(","); g.board[+k.slice(0, pr)][+k.slice(pr + 1)] = regen.clues[k]; }
		var n = 0; for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) if (g.board[r][c] === MINE) n++;
		g.totalSafe = R * C - n;
		// Cut in two: if the re-cover split your territory into disconnected groups, you keep only your
		// largest 8-connected group and the smaller cut-off sections are re-covered too — orphaned ground
		// always reverts to covered, never left as dead revealed cells. Home is just the biggest area you
		// currently hold; it can shift across the board or shrink to a last stand.
		loseSmallerSections(pid).forEach(recover);
		// The regen (or a re-cover) can leave a covered cell next to a revealed 0 — unambiguously safe,
		// never allowed to stay covered ("uncascaded 0"). Reveal each such cell (flooding through connected
		// 0s) and give it to the OWNER OF THAT 0-cell. Crucially that means a blast only ever feeds the
		// player whose own open ground forced the reveal — it can never reach across and alter the other
		// player's territory. Fixes both the patch and the cut-off re-cover.
		var changed = true;
		while (changed) {
			changed = false;
			for (var fr = 0; fr < R; fr++) for (var fc = 0; fc < C; fc++) {
				if (state[fr][fc] !== KNOWN || g.board[fr][fc] !== 0) continue;
				var into = owner[fr][fc];                               // re-revealed cells join this 0-cell's owner (or neutral)
				nbrs(fr, fc).forEach(function(b) {
					if (state[b[0]][b[1]] !== UNKNOWN || g.board[b[0]][b[1]] === MINE) return;
					BoardLogic.cascadeReveal(b[0], b[1], R, C,
						function(a, d) { return state[a][d] === UNKNOWN && g.board[a][d] !== MINE; },
						function(a, d) { state[a][d] = KNOWN; owner[a][d] = into; return false; },
						function(a, d) { return g.board[a][d]; });
					changed = true;
				});
			}
		}
		var recovered = [];
		for (var tk in touched) { var tp = touched[tk]; if (state[tp[0]][tp[1]] === UNKNOWN) recovered.push(tp); }
		g._explosion = { origin: [mr, mc], recovered: recovered, clues: regen.clues };
		return { type: "explode", origin: [mr, mc], recovered: recovered, until: g.frozenUntil[pid] };
	};

	// The player's owned cells minus their largest 8-connected group — i.e. the cut-off sections after
	// a re-cover. Returns them (the caller re-covers them); does not mutate. Empty if still one piece.
	function loseSmallerSections(pid) {
		var seen = [];
		for (var r = 0; r < R; r++) seen.push(new Array(C).fill(false));
		var comps = [];
		for (var r0 = 0; r0 < R; r0++) for (var c0 = 0; c0 < C; c0++) {
			if (owner[r0][c0] !== pid || seen[r0][c0]) continue;
			var comp = [], stack = [[r0, c0]]; seen[r0][c0] = true;
			while (stack.length) {
				var p = stack.pop(); comp.push(p);
				nbrs(p[0], p[1]).forEach(function(b) { if (owner[b[0]][b[1]] === pid && !seen[b[0]][b[1]]) { seen[b[0]][b[1]] = true; stack.push(b); } });
			}
			comps.push(comp);
		}
		if (comps.length <= 1) return [];                              // still one piece — nothing lost
		var best = 0;
		for (var i = 1; i < comps.length; i++) if (comps[i].length > comps[best].length) best = i;
		var lost = [];
		for (var j = 0; j < comps.length; j++) if (j !== best) lost = lost.concat(comps[j]);
		return lost;
	}

	function computeExplosion(pid, mr, mc, rad) {
		var patch = [], inPatch = {};
		function add(r, c) { var k = r + "," + c; if (!inPatch[k]) { inPatch[k] = true; patch.push([r, c]); } }
		add(mr, mc);
		// Your own territory around the blast is re-covered (your "home" isn't a protected corner — it's
		// just wherever you currently hold ground, so a blast can eat into any of it).
		for (var r = Math.max(0, mr - rad); r <= Math.min(R - 1, mr + rad); r++)
			for (var c = Math.max(0, mc - rad); c <= Math.min(C - 1, mc + rad); c++)
				if (owner[r][c] === pid) add(r, c);
		var idxOf = {}; patch.forEach(function(p, i) { idxOf[p[0] + "," + p[1]] = i; });
		// Border constraints: each revealed cell touching the patch must keep its mine-among-patch count.
		var seen = {}, cons = [];
		patch.forEach(function(p) {
			nbrs(p[0], p[1]).forEach(function(b) {
				var bk = b[0] + "," + b[1];
				if (inPatch[bk] || state[b[0]][b[1]] !== KNOWN || seen[bk]) return;
				seen[bk] = true;
				var idxs = [], need = 0;
				nbrs(b[0], b[1]).forEach(function(nb) { var nk = nb[0] + "," + nb[1]; if (inPatch[nk]) { idxs.push(idxOf[nk]); if (g.board[nb[0]][nb[1]] === MINE) need++; } });
				cons.push({ idxs: idxs, need: need, assigned: 0, remaining: idxs.length });
			});
		});
		var byVar = patch.map(function() { return []; });
		cons.forEach(function(con, ci) { con.idxs.forEach(function(vi) { byVar[vi].push(ci); }); });
		var order = patch.map(function(_, i) { return i; });
		for (var s = order.length - 1; s > 0; s--) { var j = Math.floor(Math.random() * (s + 1)); var tmp = order[s]; order[s] = order[j]; order[j] = tmp; }
		var assign = new Array(patch.length).fill(false), found = null, tested = 0;
		function feasible(ci) { var con = cons[ci]; return con.assigned <= con.need && con.assigned + con.remaining >= con.need; }
		function bt(oi) {
			if (found || tested >= 40) return;
			if (oi === order.length) {
				tested++;
				var ov = {}; patch.forEach(function(p, i) { ov[p[0] + "," + p[1]] = assign[i]; });
				if (solvableFromBorder(patch, inPatch, ov)) found = { patch: patch, clues: changedClues(patch, inPatch, ov) };
				return;
			}
			var vi = order[oi], vals = Math.random() < 0.5 ? [false, true] : [true, false];
			for (var ti = 0; ti < 2; ti++) {
				var val = vals[ti];
				assign[vi] = val; var ok = true;
				for (var a = 0; a < byVar[vi].length; a++) { var con = cons[byVar[vi][a]]; con.assigned += (val ? 1 : 0); con.remaining--; if (!feasible(byVar[vi][a])) ok = false; }
				if (ok) bt(oi + 1);
				for (var b2 = 0; b2 < byVar[vi].length; b2++) { var con2 = cons[byVar[vi][b2]]; con2.assigned -= (val ? 1 : 0); con2.remaining++; }
				if (found) return;
			}
		}
		bt(0);
		return found;
	}

	// New clue values for the patch + its neighbours under the candidate mine layout `ov`.
	function changedClues(patch, inPatch, ov) {
		var cells = {}, out = {};
		patch.forEach(function(p) { cells[p[0] + "," + p[1]] = p; nbrs(p[0], p[1]).forEach(function(nb) { cells[nb[0] + "," + nb[1]] = nb; }); });
		for (var k in cells) {
			var p = cells[k];
			if (isMineWith(ov, p[0], p[1])) out[k] = MINE;
			else { var n = 0; nbrs(p[0], p[1]).forEach(function(nb) { if (isMineWith(ov, nb[0], nb[1])) n++; }); out[k] = n; }
		}
		return out;
	}

	// Is the re-covered patch deducible from the surrounding revealed cells alone (no going around)?
	function solvableFromBorder(patch, inPatch, ov) {
		var tb = [];
		for (var r = 0; r < R; r++) { tb.push(new Array(C)); for (var c = 0; c < C; c++) { if (isMineWith(ov, r, c)) tb[r][c] = MINE; else { var n = 0; nbrs(r, c).forEach(function(nb) { if (isMineWith(ov, nb[0], nb[1])) n++; }); tb[r][c] = n; } } }
		var st = [];
		for (var r2 = 0; r2 < R; r2++) { st.push(new Array(C)); for (var c2 = 0; c2 < C; c2++) st[r2][c2] = (state[r2][c2] === KNOWN && !inPatch[r2 + "," + c2]) ? KNOWN : UNKNOWN; }
		function cascade(rr, cc) { BoardLogic.cascadeReveal(rr, cc, R, C, function(a, b) { return st[a][b] === UNKNOWN; }, function(a, b) { st[a][b] = KNOWN; return false; }, function(a, b) { return tb[a][b]; }); }
		cspSolver.analyzeBoard(tb, st, { revealCell: cascade, maxComplexity: 7 });
		for (var i = 0; i < patch.length; i++) { var p = patch[i]; if (!isMineWith(ov, p[0], p[1]) && st[p[0]][p[1]] !== KNOWN) return false; }
		return true;
	}

	// Enclosure capture: claim any region you've sealed off so only YOU can reach it. A covered cell
	// is captured when your territory can reach it (spreading through covered cells) but the opponent's
	// cannot — whether it sits deep inside your land or is pinned against a board edge (edges are not
	// an escape, unlike a naive "can it reach the border" test). Covered non-mine cells are revealed
	// and claimed; mines stay covered (a dead pocket); the opponent's own cells are never stolen.
	// Returns the newly-claimed cells.
	g.captureEnclosed = function(pid) {
		// Cells a player can reach (4-connected), spreading from their own territory through covered
		// cells only. Their own land is passable too (it's where they start); any OTHER revealed cell —
		// the opponent's, or neutral dead ground — is a wall they can't expand through.
		function reach(own) {
			var seen = [], stack = [];
			for (var r = 0; r < R; r++) seen.push(new Array(C).fill(false));
			function push(r, c) { if (r < 0 || c < 0 || r >= R || c >= C || seen[r][c]) return; if (state[r][c] !== UNKNOWN && !own(r, c)) return; seen[r][c] = true; stack.push([r, c]); }
			for (var sr = 0; sr < R; sr++) for (var sc = 0; sc < C; sc++) if (own(sr, sc)) push(sr, sc);
			while (stack.length) { var p = stack.pop(); push(p[0] - 1, p[1]); push(p[0] + 1, p[1]); push(p[0], p[1] - 1); push(p[0], p[1] + 1); }
			return seen;
		}
		function isOpp(r, c) { return owner[r][c] !== null && owner[r][c] !== pid; }
		var oppReach = reach(isOpp);                                                            // opponent's reach (your land + neutral ground wall them out)
		var youReach = reach(function(r, c) { return owner[r][c] === pid; });                   // your reach (their land + neutral ground wall you out)
		var captured = [];
		for (var r2 = 0; r2 < R; r2++) for (var c2 = 0; c2 < C; c2++) {
			if (owner[r2][c2] === pid || oppReach[r2][c2] || !youReach[r2][c2]) continue;        // theirs, reachable by them, or unreachable by you
			if (state[r2][c2] === UNKNOWN && g.board[r2][c2] !== MINE) {                          // sealed-off covered safe cell → yours
				state[r2][c2] = KNOWN; owner[r2][c2] = pid; captured.push([r2, c2]);
			}
		}
		return captured;
	};

	g.claimedSafe = function() {
		var n = 0;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) if (owner[r][c] !== null) n++;
		return n;
	};

	g.scores = function() {
		var s = {};
		players.forEach(function(p) { s[p] = 0; });
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) { var o = owner[r][c]; if (o !== null) s[o]++; }
		return s;
	};

	// True once no player has any safe frontier move left (every reachable safe cell is claimed).
	g.stuck = function() {
		for (var pi = 0; pi < players.length; pi++) {
			var pid = players[pi];
			for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
				if (state[r][c] === UNKNOWN && g.board[r][c] !== MINE && g.canReveal(pid, r, c)) return false;
			}
		}
		return true;
	};

	return g;
}

module.exports = { create: create, FREEZE_MS: FREEZE_MS };
