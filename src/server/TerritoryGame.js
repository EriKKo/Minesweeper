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
// Structures: a covered mine fully surrounded by one player becomes their structure (a flagged fort).
// Left-clicking it fires a directional beam at the nearest enemy, re-covering a channel of their land
// (which you can then re-claim) and destroying any enemy structure it hits. Fixed blast on a cooldown
// that recharges faster the more territory you hold.
var BEAM_LEN = 6;            // enemy cells deep the beam re-covers before it fizzles
var BEAM_COOLDOWN_BASE = 8000, BEAM_COOLDOWN_REF = 60, BEAM_COOLDOWN_MIN = 2500, BEAM_COOLDOWN_MAX = 12000;

// gen = TerritoryGenerator.generate(...); players = [idA, idB] mapped to starts[0], starts[1].
function create(gen, players) {
	var R = gen.rows, C = gen.cols;
	var state = [], owner = [];
	for (var r = 0; r < R; r++) { state.push(new Array(C).fill(UNKNOWN)); owner.push(new Array(C).fill(null)); }

	var g = {
		rows: R, cols: C, board: gen.board, state: state, owner: owner,
		players: players.slice(), starts: gen.starts,
		frozenUntil: {}, mineHits: {},
		totalSafe: R * C - gen.mineCount, playing: true,
		density: (gen.mineCount || 0) / (R * C) // board mine density — explosion regen matches it so re-fills aren't denser than usual
	};
	g.mineKnown = {}; // pid -> { "r,c": true } cells this player has detonated (so the bot won't re-pick)
	g.structReadyAt = {}; // "r,c" -> server timestamp a structure becomes ready to fire again
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
		g.updateStructures(now); // a mine you've now fully surrounded becomes a structure
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

	// Hitting a mine triggers an EXPLOSION: a patch of the hitter's own territory around the mine is
	// re-covered (a reverse cascade on the client) and the player is frozen for FREEZE_MS.
	// NOTE: mine RE-GENERATION is disabled for now — the underlying board values are left exactly as
	// they were, so the patch is simply un-revealed and the player re-clears the same layout. The
	// re-roll machinery (computeExplosion / solvableFromBorder / changedClues) is kept below, dormant,
	// for when we switch it back on.
	g.explode = function(pid, mr, mc, now) {
		g.frozenUntil[pid] = now + FREEZE_MS;
		g.mineHits[pid]++;
		var ep = explosionPatch(pid, mr, mc, 3);
		// `touched` collects every cell this explosion re-covers (the patch + any cut-off section) for
		// the client's reverse-cascade animation. Board values are NOT changed.
		var touched = {};
		function recover(p) { state[p[0]][p[1]] = UNKNOWN; owner[p[0]][p[1]] = null; touched[p[0] + "," + p[1]] = p; }
		ep.patch.forEach(recover);
		// Cut in two: if the re-cover split your territory into disconnected groups, you keep only your
		// largest 8-connected group and the smaller cut-off sections are re-covered too — orphaned ground
		// always reverts to covered. Home is just the biggest area you currently hold (down to a last stand).
		loseSmallerSections(pid).forEach(recover);
		g.mineKnown[pid][mr + "," + mc] = true; // the hit cell is still a mine (no regen) — the bot won't re-pick it
		fillUncascaded();
		g.updateStructures(now);
		var recovered = [];
		for (var tk in touched) { var tp = touched[tk]; if (state[tp[0]][tp[1]] === UNKNOWN) recovered.push(tp); }
		g._explosion = { origin: [mr, mc], recovered: recovered, pid: pid }; // pid = who hit it (no `clues` — layout unchanged)
		return { type: "explode", origin: [mr, mc], recovered: recovered, until: g.frozenUntil[pid] };
	};

	// A re-cover (explosion or offensive beam) can leave a covered cell next to a revealed 0 ("uncascaded
	// 0"): reveal each such cell (flooding through connected 0s), claimed by the OWNER OF THAT 0-cell — so
	// a blast only ever feeds the player whose own open ground forced the reveal, never reaching across.
	function fillUncascaded() {
		var changed = true;
		while (changed) {
			changed = false;
			for (var fr = 0; fr < R; fr++) for (var fc = 0; fc < C; fc++) {
				if (state[fr][fc] !== KNOWN || g.board[fr][fc] !== 0) continue;
				var into = owner[fr][fc];
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
	}

	// The cells an explosion at (mr,mc) re-covers: the hit cell plus the hitter's owned cells within
	// Chebyshev `rad`. If that would re-cover the player's ENTIRE territory, the owned cells farthest
	// from the blast are spared (a home), so a mine can never eliminate you outright. Returns
	// { patch: [[r,c]...], inPatch: {"r,c": true} }.
	function explosionPatch(pid, mr, mc, rad) {
		var patch = [], inPatch = {};
		function add(r, c) { var k = r + "," + c; if (!inPatch[k]) { inPatch[k] = true; patch.push([r, c]); } }
		add(mr, mc);
		var inRange = [], totalOwned = 0;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (owner[r][c] !== pid) continue;
			totalOwned++;
			if (r >= mr - rad && r <= mr + rad && c >= mc - rad && c <= mc + rad) inRange.push([r, c]);
		}
		if (totalOwned - inRange.length === 0 && inRange.length > 0) {
			var keep = Math.max(1, Math.ceil(totalOwned / 3));
			inRange.sort(function(a, b) {
				return Math.max(Math.abs(b[0] - mr), Math.abs(b[1] - mc)) - Math.max(Math.abs(a[0] - mr), Math.abs(a[1] - mc));
			});
			inRange = inRange.slice(keep); // the farthest `keep` cells stay revealed (your protected home)
		}
		inRange.forEach(function(p) { add(p[0], p[1]); });
		return { patch: patch, inPatch: inPatch };
	}

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

	// DORMANT: regenerates the mines under an exploded patch so the surrounding clues stay correct and
	// the patch is no-guess solvable from its border. Not currently called (g.explode keeps the layout
	// as-is); retained for when mine re-generation is switched back on.
	function computeExplosion(pid, mr, mc, rad) {
		var ep = explosionPatch(pid, mr, mc, rad);
		var patch = ep.patch, inPatch = ep.inPatch;
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
			// Try non-mine vs mine weighted by the board density (not 50/50): a patch cell with no border
			// constraint keeps whichever value is tried first, so a 50/50 bias filled the patch interior
			// with ~half mines — far denser than the board. Density-weighting keeps re-fills normal.
			var vi = order[oi], vals = Math.random() < g.density ? [true, false] : [false, true];
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
		// Cells a player can reach, spreading from their own territory through covered cells. The flood is
		// 8-connected to MATCH expansion (canReveal lets you claim any covered cell 8-adjacent to your
		// territory) — using 4-connectivity here under-counted reach, so the enclosure capture stole cells
		// the opponent could actually grab diagonally (and ended games early). Own land is passable (it's
		// where you start); any OTHER revealed cell — the opponent's, or neutral dead ground — is a wall.
		function reach(own) {
			var seen = [], stack = [];
			for (var r = 0; r < R; r++) seen.push(new Array(C).fill(false));
			function push(r, c) { if (r < 0 || c < 0 || r >= R || c >= C || seen[r][c]) return; if (state[r][c] !== UNKNOWN && !own(r, c)) return; seen[r][c] = true; stack.push([r, c]); }
			for (var sr = 0; sr < R; sr++) for (var sc = 0; sc < C; sc++) if (own(sr, sc)) push(sr, sc);
			while (stack.length) {
				var p = stack.pop();
				for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) { if (dr || dc) push(p[0] + dr, p[1] + dc); }
			}
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

	// Safe cells claimed (excludes structures — they're owned MINES, not safe cells, so they must not
	// count toward the totalSafe end-condition).
	g.claimedSafe = function() {
		var n = 0;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) if (owner[r][c] !== null && g.board[r][c] !== MINE) n++;
		return n;
	};

	// Score = all cells you control, INCLUDING your structures (surrounded mines count as territory).
	g.scores = function() {
		var s = {};
		players.forEach(function(p) { s[p] = 0; });
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) { var o = owner[r][c]; if (o !== null) s[o]++; }
		return s;
	};

	g.stuck = function() {
		// No safe frontier move for anyone...
		for (var pi = 0; pi < players.length; pi++) {
			var pid = players[pi];
			for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
				if (state[r][c] === UNKNOWN && g.board[r][c] !== MINE && g.canReveal(pid, r, c)) return false;
			}
		}
		// ...but the war can still resume: if a structure exists and 2+ players hold ground, a charged
		// beam can re-open cells, so the game isn't over.
		var withLand = 0, sc = g.scores();
		players.forEach(function(p) { if (sc[p] > 0) withLand++; });
		if (withLand >= 2) for (var sr = 0; sr < R; sr++) for (var scc = 0; scc < C; scc++) if (g.isStructure(sr, scc)) return false;
		return true;
	};

	// A structure is a covered mine that a player has claimed (by fully surrounding it).
	g.isStructure = function(r, c) { return state[r][c] === UNKNOWN && g.board[r][c] === MINE && owner[r][c] !== null; };

	function cooldownFor(pid) {
		var cells = g.scores()[pid] || 1;
		return Math.max(BEAM_COOLDOWN_MIN, Math.min(BEAM_COOLDOWN_MAX, Math.round(BEAM_COOLDOWN_BASE * BEAM_COOLDOWN_REF / cells)));
	}

	// Re-evaluate which covered mines are structures. A whole CONNECTED GROUP of covered mines becomes one
	// player's structures when the group's entire outer boundary is owned by that single player — so a
	// surrounded cluster of mines counts, not just a lone mine (adjacent mines used to block each other).
	// A group no longer fully enclosed by one player reverts to neutral covered mines.
	g.updateStructures = function(now) {
		var seen = [];
		for (var r = 0; r < R; r++) seen.push(new Array(C).fill(false));
		for (var r0 = 0; r0 < R; r0++) for (var c0 = 0; c0 < C; c0++) {
			if (seen[r0][c0] || state[r0][c0] !== UNKNOWN || g.board[r0][c0] !== MINE) continue;
			// Flood the 8-connected blob of covered mines.
			var comp = [], inComp = {}, stack = [[r0, c0]];
			seen[r0][c0] = true;
			while (stack.length) {
				var p = stack.pop(); comp.push(p); inComp[p[0] + "," + p[1]] = true;
				nbrs(p[0], p[1]).forEach(function(b) {
					if (!seen[b[0]][b[1]] && state[b[0]][b[1]] === UNKNOWN && g.board[b[0]][b[1]] === MINE) { seen[b[0]][b[1]] = true; stack.push(b); }
				});
			}
			// The blob is a structure group iff every boundary cell (a neighbour not in the blob) is owned
			// by one and the same player — a null (covered/neutral) or mixed-owner boundary is an escape.
			var holder = undefined, ok = true;
			for (var i = 0; i < comp.length && ok; i++) {
				var ns = nbrs(comp[i][0], comp[i][1]);
				for (var j = 0; j < ns.length; j++) {
					if (inComp[ns[j][0] + "," + ns[j][1]]) continue;
					var o = owner[ns[j][0]][ns[j][1]];
					if (o === null) { ok = false; break; }
					if (holder === undefined) holder = o; else if (o !== holder) { ok = false; break; }
				}
			}
			comp.forEach(function(p) {
				var k = p[0] + "," + p[1];
				if (ok && holder != null) {
					if (owner[p[0]][p[1]] !== holder) { owner[p[0]][p[1]] = holder; g.structReadyAt[k] = now; } // newly built → ready
				} else if (owner[p[0]][p[1]] !== null) {
					owner[p[0]][p[1]] = null; delete g.structReadyAt[k]; // boundary broke → revert to neutral mine
				}
			});
		}
	};

	// Left-click your structure: fire a directional beam at the nearest enemy. Travels from the structure
	// toward the closest enemy cell, re-covering a 3-wide channel of their land (BEAM_LEN deep) which then
	// becomes claimable. An enemy structure in the path ABSORBS the beam — it's destroyed and the beam
	// stops there. Spends the structure (goes on cooldown).
	g.fireStructure = function(pid, sr, sc, now) {
		if (!g.isStructure(sr, sc) || owner[sr][sc] !== pid) return { type: "invalid" };
		if (now < (g.structReadyAt[sr + "," + sc] || 0)) return { type: "charging" };
		var E = null, bestD = Infinity;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (owner[r][c] === null || owner[r][c] === pid) continue; // an enemy-held cell
			var d = Math.max(Math.abs(r - sr), Math.abs(c - sc));
			if (d < bestD) { bestD = d; E = [r, c]; }
		}
		g.structReadyAt[sr + "," + sc] = now + cooldownFor(pid); // spent regardless
		if (!E) { g.updateStructures(now); g._fire = { pid: pid, from: [sr, sc], to: [sr, sc], recovered: [], destroyed: [] }; return { type: "fizzle" }; }
		var ddr = Math.sign(E[0] - sr), ddc = Math.sign(E[1] - sc);
		var pr = -ddc, pc = ddr; // one perpendicular (the other is its negation) → 3-wide channel
		var recovered = [], destroyed = [], budget = BEAM_LEN;
		function rerecover(rr, cc) {
			if (rr < 0 || cc < 0 || rr >= R || cc >= C) return;
			if (state[rr][cc] !== KNOWN || owner[rr][cc] === null || owner[rr][cc] === pid) return; // only enemy revealed land
			state[rr][cc] = UNKNOWN; owner[rr][cc] = null; recovered.push([rr, cc]);
		}
		var cr = sr, cc = sc, steps = 0, maxSteps = R + C, endR = sr, endC = sc;
		while (steps < maxSteps && budget > 0) {
			cr += ddr; cc += ddc; steps++;
			if (cr < 0 || cc < 0 || cr >= R || cc >= C) break;
			endR = cr; endC = cc;
			var o = owner[cr][cc];
			if (o === pid || o === null) continue;            // travels over your land / neutral ground
			if (g.isStructure(cr, cc)) { owner[cr][cc] = null; delete g.structReadyAt[cr + "," + cc]; destroyed.push([cr, cc]); break; } // absorbed
			rerecover(cr, cc); rerecover(cr + pr, cc + pc); rerecover(cr - pr, cc - pc); // 3-wide
			budget--;
		}
		fillUncascaded();
		g.updateStructures(now);
		g._fire = { pid: pid, from: [sr, sc], to: [endR, endC], recovered: recovered, destroyed: destroyed };
		return { type: "fire", recovered: recovered, destroyed: destroyed };
	};

	// Structures (for the client): position, owner and recharge state (ms-to-ready so the client can
	// interpolate the gauge without clock sync).
	g.structureList = function(now) {
		var out = [];
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (!g.isStructure(r, c)) continue;
			var ready = g.structReadyAt[r + "," + c] || 0, cd = cooldownFor(owner[r][c]);
			out.push({ r: r, c: c, owner: owner[r][c], readyInMs: Math.max(0, ready - now), cooldownMs: cd });
		}
		return out;
	};

	return g;
}

module.exports = { create: create, FREEZE_MS: FREEZE_MS };
