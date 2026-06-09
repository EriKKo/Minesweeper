// Shared-board state for the 2-player Territory (versus) mode.
//
// Unlike the racing modes (where each player has a private state matrix over a shared layout),
// here there is ONE board and ONE state matrix that both players mutate, plus an `owner` matrix
// recording who claimed each cell. A player may only reveal a covered cell adjacent to their own
// territory (contiguous growth from their corner); the reveal cascades and every newly-opened cell
// becomes theirs. Hitting a mine leaves it covered and freezes the player for FREEZE_MS (v1 — no
// reroll yet). The game ends when every safe cell is claimed (or the room timer expires); most
// cells wins.

var BoardLogic = require("../common/BoardLogic");
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
		if (g.board[r][c] === MINE) {
			g.frozenUntil[pid] = now + FREEZE_MS;
			g.mineHits[pid]++;
			g.mineKnown[pid][r + "," + c] = true;
			return { type: "mine", cell: [r, c], until: g.frozenUntil[pid] };
		}
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

	// Enclosure capture: any region the player has walled off — cells not owned by them that can't
	// reach the board edge except by crossing their territory — is captured. Covered non-mine cells
	// in it are revealed and claimed; mines stay covered (a dead pocket inside your land); the
	// opponent's own cells are left alone (no stealing). Returns the newly-claimed cells.
	g.captureEnclosed = function(pid) {
		var free = [];
		for (var r = 0; r < R; r++) free.push(new Array(C).fill(false));
		var stack = [];
		function seed(r, c) { if (r >= 0 && c >= 0 && r < R && c < C && owner[r][c] !== pid && !free[r][c]) { free[r][c] = true; stack.push([r, c]); } }
		for (var c0 = 0; c0 < C; c0++) { seed(0, c0); seed(R - 1, c0); }
		for (var r0 = 0; r0 < R; r0++) { seed(r0, 0); seed(r0, C - 1); }
		while (stack.length) {
			var p = stack.pop();
			seed(p[0] - 1, p[1]); seed(p[0] + 1, p[1]); seed(p[0], p[1] - 1); seed(p[0], p[1] + 1);
		}
		var captured = [];
		for (var r2 = 0; r2 < R; r2++) for (var c2 = 0; c2 < C; c2++) {
			if (owner[r2][c2] === pid || free[r2][c2]) continue;          // owned by pid, or escapes to edge
			if (state[r2][c2] === UNKNOWN && g.board[r2][c2] !== MINE) {  // enclosed covered safe cell
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
