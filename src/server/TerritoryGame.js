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

// Energy infrastructure. A claimed mine (structure) is an energy EXTRACTOR: it spends EXTRACTOR_BUILD_MS
// under construction, then runs and produces EXTRACTOR_RATE energy/sec for its owner. Operational
// extractors auto-wire energy LINES to nearby same-owner extractors (up to LINE_MAX_LINKS each, within
// LINE_RADIUS); a line spends LINE_BUILD_MS building, then adds LINE_RATE energy/sec. Energy banks per
// player — later spent on area "energy explosions" against opponents.
var EXTRACTOR_BUILD_MS = 15000;  // captured mine → running extractor
var EXTRACTOR_RATE = 1.0;        // energy/sec per running extractor
var LINE_RADIUS = 6;             // Chebyshev cells two extractors can wire across
var LINE_MAX_LINKS = 3;          // max wires per extractor (to its nearest same-owner extractors)
var LINE_BUILD_MS = 10000;       // energy line construction time once both ends are running
var LINE_RATE = 0.6;             // bonus energy/sec per completed line

// Energy bombs: spend banked energy to launch a missile from one of your generators at a target area.
// On impact it re-covers a circular blast (neutral, up for grabs), wiping flags + infrastructure there,
// and the mines under it are re-rolled at board density to a no-guess-solvable layout.
var BOMB_COST = 1000;            // energy spent per launch
var BOMB_RADIUS = 2.6;          // Euclidean blast radius (cells)
var BOMB_REGEN_TRIES = 90;       // solvable-layout attempts before falling back to the existing layout
var BOMB_CLAIM_LOCK_MS = 5000;   // after impact, only the launcher may claim the crater for this long

function lineKey(a, b) {
	var ka = a[0] + "," + a[1], kb = b[0] + "," + b[1];
	return ka < kb ? ka + "|" + kb : kb + "|" + ka;
}

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
	g.extractorStartedAt = {}; // "r,c" -> server time the extractor began construction (built EXTRACTOR_BUILD_MS later)
	g.energyLines = {}; // "r,c|r,c" (endpoints sorted) -> { owner, startedAt }
	g.energy = {}; // pid -> banked energy
	g.energyAt = 0; // server time energy was last accrued
	g.bombClaim = {}; // "r,c" -> { pid, until } : crater cells only the launcher may claim until `until`
	players.forEach(function(p) { g.frozenUntil[p] = 0; g.mineHits[p] = 0; g.mineKnown[p] = {}; g.energy[p] = 0; });

	// Seed each player's starting cascade as their territory.
	players.forEach(function(pid, i) {
		(gen.startReveals[i] || []).forEach(function(rc) {
			state[rc[0]][rc[1]] = KNOWN; owner[rc[0]][rc[1]] = pid;
		});
	});

	g.frozen = function(pid, now) { return now < (g.frozenUntil[pid] || 0); };

	// Contiguity: a covered, non-claimed cell with an 8-neighbour this player already owns.
	// A freshly bombed cell can only be claimed by the launcher for BOMB_CLAIM_LOCK_MS (then it opens up).
	g.claimLocked = function(pid, r, c) {
		var lk = g.bombClaim[r + "," + c];
		return !!(lk && lk.pid !== pid && Date.now() < lk.until);
	};

	g.canReveal = function(pid, r, c) {
		if (r < 0 || c < 0 || r >= R || c >= C) return false;
		if (state[r][c] !== UNKNOWN) return false;
		if (g.claimLocked(pid, r, c)) return false; // bombed ground reserved for the launcher
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
		if (g.board[r][c] === MINE) return g.hitMine(pid, r, c, now);
		var claimed = [];
		BoardLogic.cascadeReveal(r, c, R, C,
			function(a, b) { return state[a][b] === UNKNOWN && g.board[a][b] !== MINE && !g.claimLocked(pid, a, b); },
			function(a, b) { state[a][b] = KNOWN; owner[a][b] = pid; claimed.push([a, b]); return false; },
			function(a, b) { return g.board[a][b]; });
		// Newly walling something off captures it (enclosed covered ground becomes yours).
		var captured = g.captureEnclosed(pid);
		g.updateStructures(now); // a mine you've now fully surrounded becomes a structure
		// NB: clearing every safe cell no longer ends the game — that's when the invasion war begins.
		// The game ends only on elimination (g.alive() <= 1) or a genuine deadlock (g.deadlocked()).
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

	// Hitting a mine now simply FREEZES you for FREEZE_MS — the old self-explosion (re-covering a patch of
	// your own territory) was removed. The cell stays a covered mine; the only thing that re-covers
	// territory now is an opponent's energy bomb.
	g.hitMine = function(pid, mr, mc, now) {
		g.frozenUntil[pid] = now + FREEZE_MS;
		g.mineHits[pid] = (g.mineHits[pid] || 0) + 1;
		g.mineKnown[pid][mr + "," + mc] = true; // the bot won't re-pick a cell it's learned is a mine
		return { type: "mine", origin: [mr, mc], until: g.frozenUntil[pid] };
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
					if (g.claimLocked(into, b[0], b[1])) return; // don't auto-feed bombed ground to a non-launcher
					BoardLogic.cascadeReveal(b[0], b[1], R, C,
						function(a, d) { return state[a][d] === UNKNOWN && g.board[a][d] !== MINE && !g.claimLocked(into, a, d); },
						function(a, d) { state[a][d] = KNOWN; owner[a][d] = into; return false; },
						function(a, d) { return g.board[a][d]; });
					changed = true;
				});
			}
		}
	}

	// The cells inside a bomb blast: every in-bounds cell within Euclidean `rad` of the target.
	function bombPatch(tr, tc, rad) {
		var patch = [], inPatch = {}, rr = rad * rad;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if ((r - tr) * (r - tr) + (c - tc) * (c - tc) <= rr) { patch.push([r, c]); inPatch[r + "," + c] = true; }
		}
		return { patch: patch, inPatch: inPatch };
	}

	// Re-roll the mines under `patch` (density-weighted) so every revealed cell bordering the patch keeps
	// its adjacent-mine count AND the patch is no-guess solvable from that border. Mutates nothing; returns
	// { clues } (new values for patch + neighbours) or null if no solvable layout turned up in `maxTests`.
	function regenPatch(patch, inPatch, maxTests) {
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
			if (found || tested >= maxTests) return;
			if (oi === order.length) {
				tested++;
				var ov = {}; patch.forEach(function(p, i) { ov[p[0] + "," + p[1]] = assign[i]; });
				if (solvableFromBorder(patch, inPatch, ov)) found = { clues: changedClues(patch, inPatch, ov) };
				return;
			}
			// Try non-mine vs mine weighted by board density (not 50/50) so an unconstrained interior cell
			// doesn't default to ~half mines — keeps the re-roll at normal board density.
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

	// Launch request: spend BOMB_COST energy, pick a random generator (structure) you own as the silo, and
	// stage the missile for broadcast. Returns { type:"launch", from, target, flightMs } or an error type.
	g.requestBomb = function(pid, tr, tc, now) {
		if (!g.playing) return { type: "invalid" };
		if (tr < 0 || tc < 0 || tr >= R || tc >= C) return { type: "invalid" };
		if ((g.energy[pid] || 0) < BOMB_COST) return { type: "poor" };
		var silos = [];
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) if (g.isStructure(r, c) && owner[r][c] === pid) silos.push([r, c]);
		if (!silos.length) return { type: "nosilo" };
		g.accrueEnergy(now);
		g.energy[pid] -= BOMB_COST;
		var from = silos[Math.floor(Math.random() * silos.length)];
		var flightMs = Math.round(Math.min(1700, 400 + Math.hypot(tr - from[0], tc - from[1]) * 45));
		g._missile = { pid: pid, from: from, to: [tr, tc], flightMs: flightMs };
		return { type: "launch", from: from, target: [tr, tc], flightMs: flightMs };
	};

	// Bomb impact: re-roll the blasted mines to a solvable layout (fall back to the existing layout if none
	// found), then re-cover the whole blast as NEUTRAL ground (up for grabs), wiping any infrastructure
	// there. Flags are client-side, cleared by the client from the broadcast. Sets g._explosion (bomb:true).
	g.detonateBomb = function(tr, tc, pid, now) {
		var bp = bombPatch(tr, tc, BOMB_RADIUS), patch = bp.patch, inPatch = bp.inPatch;
		var regen = regenPatch(patch, inPatch, BOMB_REGEN_TRIES);
		if (regen) for (var k in regen.clues) { var kp = k.split(","); g.board[+kp[0]][+kp[1]] = regen.clues[k]; }
		var until = now + BOMB_CLAIM_LOCK_MS;
		patch.forEach(function(p) {
			state[p[0]][p[1]] = UNKNOWN; owner[p[0]][p[1]] = null; // neutral, up for grabs
			delete g.structReadyAt[p[0] + "," + p[1]]; delete g.extractorStartedAt[p[0] + "," + p[1]]; // wipe infra
			if (pid != null) g.bombClaim[p[0] + "," + p[1]] = { pid: pid, until: until }; // launcher-only window
		});
		fillUncascaded();
		g.updateStructures(now);
		g.recomputeLines(now);
		g._explosion = { origin: [tr, tc], recovered: patch.slice(), clues: regen ? regen.clues : null, bomb: true };
		return { recovered: patch };
	};

	// Active claim locks for the client (crater cells still reserved for their launcher). Prunes expired.
	g.claimList = function(now) {
		var out = [];
		for (var k in g.bombClaim) {
			var lk = g.bombClaim[k];
			if (now >= lk.until) { delete g.bombClaim[k]; continue; }
			var p = k.split(",");
			out.push({ r: +p[0], c: +p[1], owner: lk.pid, msLeft: lk.until - now });
		}
		return out;
	};

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
			if (g.claimLocked(pid, r2, c2)) continue;                                            // bombed ground reserved for its launcher
			if (state[r2][c2] === UNKNOWN && g.board[r2][c2] !== MINE) {                          // sealed-off covered safe cell → yours
				state[r2][c2] = KNOWN; owner[r2][c2] = pid; captured.push([r2, c2]);
			}
		}
		// Surround an opponent and their cut-off ground flips to you. "Freedom" = reaching the board border
		// through any NON-your cell (your cells are the only walls); a player starts on the border, so they
		// stay free until you fully wall their territory off from every edge. Anything you've sealed into the
		// interior — enemy cells AND the neutral/covered ground trapped with them (e.g. bomb craters) — can't
		// reach the border and becomes yours. This is connectivity-based, so a covered/neutral boundary no
		// longer saves an island: only an actual escape route to the open edge does.
		var free = [];
		for (var r = 0; r < R; r++) free.push(new Array(C).fill(false));
		var fstack = [];
		function freePush(fr, fc) {
			if (fr < 0 || fc < 0 || fr >= R || fc >= C || free[fr][fc] || owner[fr][fc] === pid) return;
			free[fr][fc] = true; fstack.push([fr, fc]);
		}
		for (var bc = 0; bc < C; bc++) { freePush(0, bc); freePush(R - 1, bc); }
		for (var br = 0; br < R; br++) { freePush(br, 0); freePush(br, C - 1); }
		while (fstack.length) {
			var fp = fstack.pop();
			for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) if (dr || dc) freePush(fp[0] + dr, fp[1] + dc);
		}
		for (var r3 = 0; r3 < R; r3++) for (var c3 = 0; c3 < C; c3++) {
			if (owner[r3][c3] === pid || free[r3][c3]) continue;                      // yours, or still connected to the edge
			if (g.claimLocked(pid, r3, c3)) continue;                                 // bombed ground reserved for its launcher
			if (state[r3][c3] === UNKNOWN && g.board[r3][c3] === MINE) { owner[r3][c3] = pid; }   // sealed mine → your covered structure
			else { state[r3][c3] = KNOWN; owner[r3][c3] = pid; }                                  // sealed enemy land / covered safe → revealed + yours
			captured.push([r3, c3]);
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

	// How many players still hold any ground. The game is won when only one is left standing.
	g.alive = function() {
		var sc = g.scores(), n = 0;
		players.forEach(function(p) { if (sc[p] > 0) n++; });
		return n;
	};

	// A genuine dead end: nobody can expand (no safe frontier move for anyone) AND there are no
	// structures anywhere (so no charged beam can ever re-open the board). Only then is the war
	// truly unresolvable and we fall back to ranking by territory. As long as a single fort stands,
	// the war can continue, so the game keeps running until someone is eliminated.
	g.deadlocked = function() {
		for (var pi = 0; pi < players.length; pi++) {
			var pid = players[pi];
			for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
				if (state[r][c] === UNKNOWN && g.board[r][c] !== MINE && g.canReveal(pid, r, c)) return false;
			}
		}
		for (var sr = 0; sr < R; sr++) for (var scc = 0; scc < C; scc++) if (g.isStructure(sr, scc)) return false;
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
					if (owner[p[0]][p[1]] !== holder) {
						owner[p[0]][p[1]] = holder; g.structReadyAt[k] = now; // newly claimed → beam ready
						g.extractorStartedAt[k] = now; // ...and the extractor begins construction
					}
				} else if (owner[p[0]][p[1]] !== null) {
					owner[p[0]][p[1]] = null; delete g.structReadyAt[k]; delete g.extractorStartedAt[k]; // boundary broke → neutral mine
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
			var k = r + "," + c;
			var ready = g.structReadyAt[k] || 0, cd = cooldownFor(owner[r][c]);
			var st = g.extractorStartedAt[k];
			var buildInMs = st == null ? EXTRACTOR_BUILD_MS : Math.max(0, EXTRACTOR_BUILD_MS - (now - st));
			out.push({ r: r, c: c, owner: owner[r][c], readyInMs: Math.max(0, ready - now), cooldownMs: cd,
				buildInMs: buildInMs, buildMs: EXTRACTOR_BUILD_MS });
		}
		return out;
	};

	// ---- Energy infrastructure -------------------------------------------------------------------
	g.extractorBuilt = function(k, now) { var s = g.extractorStartedAt[k]; return s != null && (now - s) >= EXTRACTOR_BUILD_MS; };
	g.lineBuilt = function(key, now) { var l = g.energyLines[key]; return !!l && (now - l.startedAt) >= LINE_BUILD_MS; };

	// Auto-wire the energy network: each owner's RUNNING extractors link to their nearest same-owner
	// running extractors (≤ LINE_MAX_LINKS each, within LINE_RADIUS). New pairs start building now;
	// existing lines keep their startedAt (progress persists); links that no longer qualify are dropped.
	g.recomputeLines = function(now) {
		var byOwner = {};
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (!g.isStructure(r, c) || !g.extractorBuilt(r + "," + c, now)) continue;
			var o = owner[r][c]; (byOwner[o] = byOwner[o] || []).push([r, c]);
		}
		var want = {};
		Object.keys(byOwner).forEach(function(o) {
			var ex = byOwner[o];
			for (var i = 0; i < ex.length; i++) {
				var cand = [];
				for (var j = 0; j < ex.length; j++) {
					if (i === j) continue;
					var d = Math.max(Math.abs(ex[i][0] - ex[j][0]), Math.abs(ex[i][1] - ex[j][1]));
					if (d <= LINE_RADIUS) cand.push({ j: j, d: d });
				}
				cand.sort(function(a, b) { return a.d - b.d; });
				for (var n = 0; n < Math.min(LINE_MAX_LINKS, cand.length); n++) want[lineKey(ex[i], ex[cand[n].j])] = o;
			}
		});
		Object.keys(g.energyLines).forEach(function(key) { if (!want[key]) delete g.energyLines[key]; });
		Object.keys(want).forEach(function(key) {
			if (!g.energyLines[key]) g.energyLines[key] = { owner: want[key], startedAt: now };
			else g.energyLines[key].owner = want[key];
		});
	};

	// Current energy production for a player: running extractors + completed lines.
	g.energyRate = function(pid, now) {
		var rate = 0;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (g.isStructure(r, c) && owner[r][c] === pid && g.extractorBuilt(r + "," + c, now)) rate += EXTRACTOR_RATE;
		}
		Object.keys(g.energyLines).forEach(function(key) { if (g.energyLines[key].owner === pid && g.lineBuilt(key, now)) rate += LINE_RATE; });
		return rate;
	};

	// Bank elapsed production into each player's energy total (lazy; called on tick + before broadcasts).
	g.accrueEnergy = function(now) {
		if (!g.energyAt) { g.energyAt = now; return; }
		var dt = (now - g.energyAt) / 1000;
		g.energyAt = now;
		if (dt <= 0) return;
		players.forEach(function(p) { g.energy[p] = (g.energy[p] || 0) + g.energyRate(p, now) * dt; });
	};

	// Steady world step (server runs this ~1/s): bank energy with the current network, then re-wire it.
	g.tickWorld = function(now) { g.accrueEnergy(now); g.recomputeLines(now); };

	// Energy lines for the client (endpoints + build state so it can animate construction).
	g.energyLineList = function(now) {
		var out = [];
		Object.keys(g.energyLines).forEach(function(key) {
			var l = g.energyLines[key], pts = key.split("|").map(function(s) { return s.split(",").map(Number); });
			out.push({ a: pts[0], b: pts[1], owner: l.owner,
				buildInMs: Math.max(0, LINE_BUILD_MS - (now - l.startedAt)), buildMs: LINE_BUILD_MS });
		});
		return out;
	};

	// Per-player energy snapshot (banked total + current rate so the client can count up smoothly).
	g.energySnapshot = function(now) {
		var e = {}, rate = {};
		players.forEach(function(p) { e[p] = g.energy[p] || 0; rate[p] = g.energyRate(p, now); });
		return { energy: e, rate: rate };
	};

	return g;
}

module.exports = { create: create, FREEZE_MS: FREEZE_MS };
