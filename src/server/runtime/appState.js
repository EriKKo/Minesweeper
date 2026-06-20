// The server's shared mutable state, in one place.
//
// These are the live collections the socket handlers all operate on — rooms and
// their games, per-socket bookkeeping, the bot registries, the ranked queues, and
// the territory/puzzle timers. They used to be scattered as module-level vars in
// minesweeperServer; gathering them here gives a single owner so the handler modules
// we split out can share the same objects (by requiring this singleton), and so
// tests have one seam to inspect/reset.
//
// This is a singleton: `require("./appState")` returns the same object everywhere.
// minesweeperServer aliases each collection locally (`var rooms = appState.rooms`),
// which works because these are mutated in place (rooms[id] = …), never reassigned.
// Primitive id counters (nextRoomId / nextBotId) stay with the server — entity
// creation lives in the core — and config constants (RANKED_MODES, …) aren't state.
//
// PHASE 0 P0-6 — each group below is tagged for the future main/game-server split
// (ARCHITECTURE_PLAN.md §3). This is documentation only; nothing physically moves yet.
//   [control] — control-plane state that stays on the single `main` (and becomes Redis-backed once
//               main is multi-replica): player identity + matchmaking. Identity is read once into a
//               MatchConfig (P0-2) and handed to the game server, which never reaches back for it.
//   [game]    — game-plane state owned by the game server hosting a given match: the live games/rooms,
//               their tick timers, and the bots playing them. Moves out of `main` in Phase 1.
//   [main-sp] — single-player / admin surfaces that stay on main because they're DB-coupled (puzzles)
//               or admin-only (bot demos), not part of the multiplayer match runtime.
//   [infra]   — wiring, not state.

module.exports = {
	// [infra] Wired in at boot, once socket.io is attached to the HTTP server.
	io: null,

	// --- [game] rooms, games, per-match runtime --- (a match lives entirely on one game server)
	games: {},          // playerID -> game
	rooms: {},          // roomId -> room
	roomMapping: {},     // playerID -> room
	// sockets is connection-level: in the split, lobby sockets live on main and match sockets on the
	// game server hosting the player's match. Today it's one process, so it holds both.
	sockets: {},        // playerID -> socket

	// --- [control] player identity --- (owned by main; copied into a MatchConfig and passed to the game server)
	names: {},          // playerID -> display name
	skins: {},          // playerID -> board skin id (renders each player's board in their own skin)
	avatars: {},        // playerID -> avatar cloth colour (#rrggbb; null → default red flag)
	countries: {},      // playerID -> ISO-3166 alpha-2 country code (null → none)
	accounts: {},       // playerID -> { userId, token, ratings… } for signed-in players

	// --- [game] round/series timers --- (the match loop on the game server)
	nextGameTimers: {},  // roomId -> between-games timeout
	roundTimers: {},     // roomId -> round-clock timeout
	roundDeadlines: {},  // roomId -> ms timestamp the round ends
	roundStarts: {},     // roomId -> ms timestamp the round's play began

	// --- [game] bots --- (filler bots run inside the match, on the game server)
	bots: {},            // botId -> true
	botDifficulty: {},   // botId -> "easy" | "medium" | "hard" (casual)
	botSpeedMs: {},      // botId -> flat per-move pace (ms)
	botDifficultyMs: {}, // botId -> ms of thinking per unit of move difficulty
	botDistanceMult: {}, // botId -> multiplier on the mouse-travel term
	botMaxDifficulty: {},// botId -> hardest move (CSP difficulty) the bot can deduce
	botRating: {},       // botId -> Elo used for ranked rating math
	botMistake: {},      // botId -> blunder rate
	botChord: {},        // botId -> chord rate
	botTickHandles: {},  // botId -> setTimeout handle
	botLastClick: {},    // botId -> {r, c} of the bot's most recent click this round

	// --- [control] ranked matchmaking --- (the matchmaker on main; → Redis when main is multi-replica)
	rankedQueues: { sprint_duo: [], sprint_six: [], standard_duo: [], standard_six: [], tournament: [], territory_duo: [], territory_quad: [] },
	pendingBotsLists: { sprint_duo: [], sprint_six: [], standard_duo: [], standard_six: [], tournament: [], territory_duo: [], territory_quad: [] },
	rankedFillTimers: { sprint_duo: null, sprint_six: null, standard_duo: null, standard_six: null, tournament: null, territory_duo: null, territory_quad: null },
	rankedQueueMode: {}, // playerID -> mode key

	// --- [game] territory --- (the territory match runtime + its world-tick, on the game server)
	territoryBotTimers: {},  // roomId -> { botId: timeoutHandle }
	territoryBotFocus: {},   // botId -> { r, c } locality focus persisted across ticks
	territoryWorldTimers: {},// roomId -> intervalHandle

	// --- [main-sp] single-player puzzle play + [main-sp] admin bot demos --- (DB-coupled / admin; stay on main)
	puzzlePlay: {},      // playerID -> active puzzle play
	puzzleRun: {},       // playerID -> { mode, targetRating, solves, … }
	botDemos: {}         // socketId -> { game, lastClick, timer, moves }
};
