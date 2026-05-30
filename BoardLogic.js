// Pure minesweeper algorithms shared by the client (live game + Learn page) and
// the server (GameCreator). All callbacks take (r, c) — the caller owns the
// actual cell-state shape, so the same code works against different schemas.
(function() {
	var BoardLogic = {
		// Cell-state sentinels used by the live game server + client.
		// MINE is the value of a mined cell in the underlying board array;
		// FLAGGED/UNKNOWN/KNOWN are the per-player state values.
		MINE: -1,
		FLAGGED: -2,
		UNKNOWN: -3,
		KNOWN: -4,
		forEachNeighbour: function(r, c, R, C, fn) {
			for (var dr = -1; dr <= 1; dr++) {
				for (var dc = -1; dc <= 1; dc++) {
					if (dr === 0 && dc === 0) continue;
					var nr = r + dr, nc = c + dc;
					if (nr >= 0 && nr < R && nc >= 0 && nc < C) fn(nr, nc);
				}
			}
		},
		neighbours: function(r, c, R, C) {
			var out = [];
			BoardLogic.forEachNeighbour(r, c, R, C, function(nr, nc) { out.push([nr, nc]); });
			return out;
		},
		// Build the full clue-value grid given an isMine(r, c) predicate.
		buildClueGrid: function(R, C, isMine) {
			var grid = [];
			for (var r = 0; r < R; r++) {
				grid[r] = [];
				for (var c = 0; c < C; c++) {
					var cnt = 0;
					BoardLogic.forEachNeighbour(r, c, R, C, function(nr, nc) {
						if (isMine(nr, nc)) cnt++;
					});
					grid[r][c] = cnt;
				}
			}
			return grid;
		},
		// DFS reveal cascade. Caller-owned callbacks:
		//   isCovered(r,c) → still hidden and eligible to flip
		//   reveal(r,c)    → mutate the surface's state; return true if it was a mine
		//   clueAt(r,c)    → clue value (used to decide whether to keep cascading)
		// Returns whether the cascade hit any mine.
		cascadeReveal: function(r, c, R, C, isCovered, reveal, clueAt) {
			if (r < 0 || r >= R || c < 0 || c >= C) return false;
			if (!isCovered(r, c)) return false;
			if (reveal(r, c)) return true;
			if (clueAt(r, c) !== 0) return false;
			var anyHit = false;
			BoardLogic.forEachNeighbour(r, c, R, C, function(nr, nc) {
				if (BoardLogic.cascadeReveal(nr, nc, R, C, isCovered, reveal, clueAt)) anyHit = true;
			});
			return anyHit;
		},
		// Chord analysis around a revealed clue cell.
		//   isFlagged(r,c)   → counts toward the chord trigger
		//   isKnownMine(r,c) → also counts (live game has revealed mines; pass null otherwise)
		//   isCovered(r,c)   → eligible to be chord-revealed
		chordContext: function(r, c, R, C, isFlagged, isKnownMine, isCovered) {
			var flagCount = 0;
			var covered = [];
			BoardLogic.forEachNeighbour(r, c, R, C, function(nr, nc) {
				if (isFlagged(nr, nc) || (isKnownMine && isKnownMine(nr, nc))) flagCount++;
				else if (isCovered(nr, nc)) covered.push([nr, nc]);
			});
			return { flagCount: flagCount, covered: covered };
		}
	};

	if (typeof module !== "undefined" && module.exports) {
		module.exports = BoardLogic;
	} else if (typeof window !== "undefined") {
		window.BoardLogic = BoardLogic;
	}
})();
