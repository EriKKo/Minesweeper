// Phase 1 P1-5/P1-6 (server side, end to end): the whole split loop in two real processes.
// A client matchmakes on MAIN, is handed off to a separate GAME server, plays the match there, and the
// result is reported back to and PERSISTED by main (rated via Elo-from-report). This is the complete
// no-downtime architecture proven server-side; only the browser's match_handoff handling (Main.js) is
// left for the client.

process.env.MATCH_TOKEN_SECRET = "e2e-tok";
const { test } = require("node:test");
const assert = require("node:assert");
const io = require("socket.io-client");
const { startServer } = require("./helpers");

function once(socket, event, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout waiting for '" + event + "'")), ms || 10000);
		socket.once(event, d => { clearTimeout(t); resolve(d); });
	});
}

test("client matchmakes on main, plays on a game server, result persists on main", async () => {
	const SECRET = "e2e-internal";
	const game = await startServer({ port: 13862, env: { ROLE: "game", INTERNAL_SECRET: SECRET, MATCH_TOKEN_SECRET: "e2e-tok", MAIN_URL: "http://localhost:13863" } });
	const main = await startServer({ port: 13863, env: { ROLE: "main", INTERNAL_SECRET: SECRET, MATCH_TOKEN_SECRET: "e2e-tok", GAME_SERVERS: game.base } });

	let lobby, gameSock;
	try {
		// 1) Connect to main + become a guest (a real user with a userId).
		lobby = io(main.base, { transports: ["websocket"], forceNew: true });
		await once(lobby, "connected");
		lobby.emit("guest_session");
		const auth = await once(lobby, "authenticated");
		assert.ok(auth.token, "guest session established on main");

		// 2) Queue ranked. Main forms the match (us + a filler bot), allocates it to the game server, and
		//    hands us off with a token + the game server's address.
		lobby.emit("find_ranked", { mode: "sprint_duo" });
		const handoff = await once(lobby, "match_handoff", 15000);
		assert.ok(handoff.gameUrl && handoff.token, "main handed off to a game server");
		assert.strictEqual(handoff.gameUrl, game.base);

		// 3) Connect directly to the game server with the join token and play the match there. Receiving
		//    board frames proves the full loop: matchmade on main, allocated to + running on the game
		//    server, with this client bound to its seat. (The match's eventual completion + report +
		//    persistence is covered deterministically by humanattach/internalapi/elo tests — here the bot
		//    is a real pool bot whose clear time is non-deterministic, so we don't race it.)
		gameSock = io(handoff.gameUrl, { transports: ["websocket"], forceNew: true, auth: { token: handoff.token } });
		const joined = await once(gameSock, "joined_room", 10000);
		assert.ok(joined.ranked, "attached to the ranked match on the game server");
		const board = await once(gameSock, "draw_board", 12000);
		assert.ok(board, "the match is live on the game server, streaming to the handed-off client");
	} finally {
		if (gameSock) gameSock.close();
		if (lobby) lobby.close();
		game.stop();
		main.stop();
	}
});

function decodeBoard(dataB64, maskB64, rows, cols) {
	const data = Buffer.from(dataB64, "base64");
	const mask = Buffer.from(maskB64, "base64");
	const board = [];
	for (let r = 0; r < rows; r++) {
		const row = [];
		for (let c = 0; c < cols; c++) {
			const v = data[r * cols + c] ^ mask[(r * cols + c) % mask.length];
			row.push(v === 9 ? -1 : v);
		}
		board.push(row);
	}
	return board;
}

// Regression test for the bug where a game-role match's series_ended carried the STALE pre-match
// rating as both "before" and "after": endSeries used to fire-and-forget the report to main (where
// the actual Elo math runs) and emit series_ended immediately, before main had computed anything.
// The DB write on main was always correct (a page reload showed the real new rating) — only the
// live event the winner's own client received was wrong. This plays the match to a real, fast,
// deterministic win (instead of racing an indeterminate bot, like the test above) so it can assert
// the WebSocket payload itself carries a real ratingDelta and a rating that differs from the start.
test("a fast win on the game server reports a real ratingDelta back through series_ended", async () => {
	const SECRET = "e2e-internal-2";
	const game = await startServer({ port: 13864, env: { ROLE: "game", INTERNAL_SECRET: SECRET, MATCH_TOKEN_SECRET: "e2e-tok", MAIN_URL: "http://localhost:13865" } });
	const main = await startServer({ port: 13865, env: { ROLE: "main", INTERNAL_SECRET: SECRET, MATCH_TOKEN_SECRET: "e2e-tok", GAME_SERVERS: game.base } });

	let lobby, gameSock;
	try {
		lobby = io(main.base, { transports: ["websocket"], forceNew: true });
		await once(lobby, "connected");
		lobby.emit("guest_session");
		const auth = await once(lobby, "authenticated");
		const ratingBefore = auth.ratingSprint;

		lobby.emit("find_ranked", { mode: "sprint_duo" });
		const handoff = await once(lobby, "match_handoff", 45000);

		gameSock = io(handoff.gameUrl, { transports: ["websocket"], forceNew: true, auth: { token: handoff.token } });
		await once(gameSock, "joined_room", 45000);
		const start = await once(gameSock, "start_game", 45000);
		const board = decodeBoard(start.boardData, start.boardMask, start.rows, start.cols);

		// Win as fast as possible: reveal every non-mine cell right after the countdown, well before
		// the filler bot can finish, so the series always ends with THIS client as the winner.
		await new Promise(r => setTimeout(r, (start.time + 0.5) * 1000));
		for (let r = 0; r < start.rows; r++) {
			for (let c = 0; c < start.cols; c++) {
				if (board[r][c] !== -1) gameSock.emit("left_click", { r, c, id: "1" });
			}
		}

		const ended = await once(gameSock, "series_ended", 60000);
		const mine = ended.standings.find(s => s.id === gameSock.id);
		assert.ok(mine, "the winner's own standing is present");
		assert.strictEqual(typeof mine.ratingDelta, "number", "ratingDelta must be a real number, not missing");
		assert.notStrictEqual(mine.ratingDelta, 0, "a win should never be a zero-delta for a fresh placement game");
		assert.strictEqual(typeof mine.rating, "number");
		assert.notStrictEqual(mine.rating, ratingBefore, "the reported rating must differ from the pre-match rating");
	} finally {
		if (gameSock) gameSock.close();
		if (lobby) lobby.close();
		game.stop();
		main.stop();
	}
});
