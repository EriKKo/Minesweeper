// Game-core package entry — the public surface of the pure game logic.
//
// BOUNDARY RULE (enforced by test/boundary.test.js): nothing under engine/ or common/ may import
// runtime/*, db.js, socket.io, or appState. This tier is pure logic — board generation, the solver,
// game/room state, bots, territory, puzzle generation — with no http/socket/db coupling. Both the
// future `main` service (offline generation) and the future `game` servers import it (see
// ARCHITECTURE_PLAN.md / PHASE0_TICKETS.md P0-1). Keep it that way: pass anything external in as an
// argument rather than reaching out to the runtime.
//
// Consumers may keep requiring individual files (e.g. require("./engine/GameCreator")); this barrel
// is the canonical entry once engine/ is extracted into a standalone package.

module.exports = {
	BoardLogic: require("../../common/BoardLogic"),
	GameCreator: require("./GameCreator"),
	RoomCreator: require("./RoomCreator"),
	NoGuessGenerator: require("./NoGuessGenerator"),
	CSPSolver: require("./CSPSolver"),
	BotPlayer: require("./BotPlayer"),
	PuzzleGenerator: require("./PuzzleGenerator"),
	InsideOutGenerator: require("./InsideOutGenerator"),
	RingSeedGenerator: require("./RingSeedGenerator"),
	Patterns: require("./Patterns"),
	StartPatterns: require("./StartPatterns"),
	TerritoryGame: require("./TerritoryGame"),
	TerritoryGenerator: require("./TerritoryGenerator"),
	BotBench: require("./BotBench"),
	TerritoryBench: require("./TerritoryBench")
};
