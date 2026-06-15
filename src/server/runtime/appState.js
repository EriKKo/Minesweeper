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

module.exports = {
	// Wired in at boot, once socket.io is attached to the HTTP server.
	io: null,

	// --- rooms, games, per-socket ---
	games: {},          // playerID -> game
	rooms: {},          // roomId -> room
	roomMapping: {},     // playerID -> room
	sockets: {},        // playerID -> socket
	names: {},          // playerID -> display name
	skins: {},          // playerID -> board skin id (renders each player's board in their own skin)
	accounts: {},       // playerID -> { userId, token, ratings… } for signed-in players

	// --- round/series timers ---
	nextGameTimers: {},  // roomId -> between-games timeout
	roundTimers: {},     // roomId -> round-clock timeout
	roundDeadlines: {},  // roomId -> ms timestamp the round ends
	roundStarts: {},     // roomId -> ms timestamp the round's play began

	// --- bots ---
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

	// --- ranked matchmaking ---
	rankedQueues: { sprint_duo: [], sprint_six: [], standard_duo: [], standard_six: [], tournament: [], territory_duo: [], territory_quad: [] },
	pendingBotsLists: { sprint_duo: [], sprint_six: [], standard_duo: [], standard_six: [], tournament: [], territory_duo: [], territory_quad: [] },
	rankedFillTimers: { sprint_duo: null, sprint_six: null, standard_duo: null, standard_six: null, tournament: null, territory_duo: null, territory_quad: null },
	rankedQueueMode: {}, // playerID -> mode key

	// --- territory ---
	territoryBotTimers: {},  // roomId -> { botId: timeoutHandle }
	territoryBotFocus: {},   // botId -> { r, c } locality focus persisted across ticks
	territoryWorldTimers: {},// roomId -> intervalHandle

	// --- puzzle play + bot demos ---
	puzzlePlay: {},      // playerID -> active puzzle play
	puzzleRun: {},       // playerID -> { mode, targetRating, solves, … }
	botDemos: {}         // socketId -> { game, lastClick, timer, moves }
};
