// A cheap, deterministic hash chain over a game's move history, shared by the client (optimistic
// local prediction) and the server (authoritative) so both can independently arrive at the exact
// same (seq, hash) pair after applying the exact same sequence of moves — and immediately tell
// when they haven't, without either side ever describing its whole board to the other.
//
// Not a security boundary — a client can already only affect its OWN board, and the server stays
// authoritative for win/loss regardless of what a client reports here. This exists purely so a
// move dropped in transit (packet loss) can be detected and precisely replayed instead of quietly
// leaving one side's board permanently behind the other's — see move_sync / move_resync_needed /
// resync_moves in minesweeperServer.js and their client-side counterparts in Main.js.
//
// A "move" is exactly one accepted left_click or right_click (r, c) — reveal, chord, flag, and
// unflag all fold into just those two wire events; a chord's cascade or its cleared-incorrect-
// flags are a DETERMINISTIC CONSEQUENCE of that one move (both sides compute them identically from
// the same board state), not separate moves of their own, so they're not separately hashed.
(function() {
	var MoveHash = {
		// The hash before any moves have been applied this round (seq 0). A round's own opening
		// cascade (the shared no-guess template's pre-revealed cells) isn't a move either — both
		// sides compute it identically from the round's mine layout, so seq/hash only start
		// counting from the first real player action after that.
		SEED: 0,
		// Chains `prev` (the hash after every move up to but not including this one) with a single
		// move into the next hash. Pure 32-bit integer math — Math.imul/>>> 0 behave identically in
		// every JS engine this runs in (the browser and Node), which is the one property that
		// actually matters here: client and server MUST derive the same hash from the same inputs.
		next: function(prev, r, c, isFlag) {
			// r/c/isFlag packed into one integer (13 bits for r, 12 for c, 1 for the flag bit —
			// generously more headroom than any real board size needs) so the mix below has a
			// single, order-sensitive value to fold in per move.
			var moveCode = (((r & 0x1fff) << 13) | ((c & 0xfff) << 1) | (isFlag ? 1 : 0)) >>> 0;
			var h = (prev ^ moveCode) >>> 0;
			h = Math.imul(h, 0x01000193) >>> 0; // FNV-1a's 32-bit prime
			h = (h ^ (h >>> 15)) >>> 0;         // final mix so single-bit move differences spread out
			return h >>> 0;
		}
	};

	if (typeof module !== "undefined" && module.exports) {
		module.exports = MoveHash;
	} else if (typeof window !== "undefined") {
		window.MoveHash = MoveHash;
	}
})();
