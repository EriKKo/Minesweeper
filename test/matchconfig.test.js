// Phase 0 P0-2: buildMatchConfig captures a self-contained match descriptor at match start — rules +
// a roster with identity, bot flag, userId, and rating-before — so a game server needs no DB read.

const { test, before } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

let results, appState;
before(() => {
	process.env.RANKED_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ms-cfg-")), "test.db");
	results = require("../src/server/runtime/results");
	appState = require("../src/server/runtime/appState");
	// Seed two bots (bot rosters need no DB rows; isBot reads appState.bots).
	appState.bots.b1 = true; appState.bots.b2 = true;
	appState.names.b1 = "BotOne"; appState.names.b2 = "BotTwo";
	appState.botRating.b1 = 1234; appState.botRating.b2 = 1500;
	appState.avatars.b1 = "#ef4444";
});

const room = {
	id: 7, maxPlayers: 2, ranked: true, rankedMode: "sprint_duo", rankedStyle: "sprint", gameMode: "race",
	rows: 15, cols: 20, mineDensity: 0.1, roundSeconds: 120, deathPenalty: 0, gameCount: 5, modifier: null,
	players: ["b1", "b2"]
};

test("config is a complete reconstruction spec: identity, rules, board dims, roster", () => {
	const cfg = results.buildMatchConfig(room);
	assert.match(cfg.matchId, /:room:7$/);
	assert.strictEqual(cfg.roomId, 7);
	assert.strictEqual(cfg.size, 2);
	assert.strictEqual(cfg.ranked, true);
	assert.strictEqual(cfg.mode, "sprint_duo");
	assert.strictEqual(cfg.gameMode, "race");
	assert.strictEqual(cfg.style, "sprint");
	assert.deepStrictEqual(cfg.rules, {
		rows: 15, cols: 20, mineDensity: 0.1, roundSeconds: 120, deathPenalty: 0, gameCount: 5, modifier: null
	});
	assert.strictEqual(cfg.roster.length, 2);
	const b1 = cfg.roster[0];
	assert.strictEqual(b1.pid, "b1");
	assert.strictEqual(b1.playerKey, "bot:b1");
	assert.strictEqual(b1.name, "BotOne");
	assert.strictEqual(b1.isBot, true);
	assert.strictEqual(b1.rating, 1234);
	assert.ok(b1.botConfig && b1.botConfig.rating === 1234, "bot entry carries its AI config for rebuild");
	assert.strictEqual(cfg.roster[1].rating, 1500);
});

test("the report's matchId ties to the config captured at start", () => {
	const withConfig = { id: 9, ranked: true, rankedMode: "sprint_duo", rankedStyle: "sprint", players: [] };
	withConfig.matchConfig = results.buildMatchConfig(withConfig);
	const report = results.buildResultReport(withConfig, []);
	assert.strictEqual(report.matchId, withConfig.matchConfig.matchId);
	assert.strictEqual(report.config, withConfig.matchConfig);
});
