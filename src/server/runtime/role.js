// Deployment role (PHASE1_TICKETS.md P1-5). The same binary runs as the control plane ("main"), a
// game server ("game"), or — the DEFAULT — "both" in one process, which is exactly today's monolith
// with zero behaviour change. The split is entirely opt-in via the ROLE env var, so nothing that
// follows touches the default deployment until ROLE is set.
//
//   ROLE=both  → monolith (default): matchmaking + match-running + persistence in one process.
//   ROLE=main  → control plane: lobby/auth/matchmaking/persistence; allocates matches to game servers.
//   ROLE=game  → game server: runs live matches handed to it over the internal API; reports results back.

var ROLE = (process.env.ROLE || "both").toLowerCase();
if (ROLE !== "both" && ROLE !== "main" && ROLE !== "game") ROLE = "both";

// Shared secret guarding the main↔game internal API (so /internal/* isn't publicly callable).
var INTERNAL_SECRET = process.env.INTERNAL_SECRET || "dev-internal-secret";

// Comma-separated base URLs of the game servers main can allocate to (split only).
var GAME_SERVERS = (process.env.GAME_SERVERS || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);

module.exports = {
	ROLE: ROLE,
	isMain: function() { return ROLE === "main" || ROLE === "both"; },
	isGame: function() { return ROLE === "game" || ROLE === "both"; },
	isSplit: function() { return ROLE === "main" || ROLE === "game"; },
	INTERNAL_SECRET: INTERNAL_SECRET,
	GAME_SERVERS: GAME_SERVERS
};
