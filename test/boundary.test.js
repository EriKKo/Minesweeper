// Phase 0 boundary guard (PHASE0_TICKETS.md P0-1 / P0-9).
//
// Keeps the future main/game-server seam from rotting:
//   1. nothing under engine/ or common/ may import the runtime, the database, or socket.io; and
//   2. the game-plane runtime modules (the ones tagged [game] in appState.js, which move to the game
//      server) must not touch the DB directly — they get match data via the MatchConfig and report
//      outcomes through persistResult, never by reaching into db.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const GAME_CORE_DIRS = [
	path.join(ROOT, "src/server/engine"),
	path.join(ROOT, "src/common")
];

// A require/import target is forbidden in the game core if it reaches into the runtime, the db, or sockets.
const FORBIDDEN = [
	{ re: /runtime\//, why: "imports runtime/" },
	{ re: /(^|\/)db(\.js)?$/, why: "imports db" },
	{ re: /socket\.io/, why: "imports socket.io" },
	{ re: /appState/, why: "imports appState" }
];

function jsFiles(dir) {
	return fs.readdirSync(dir)
		.filter(f => f.endsWith(".js"))
		.map(f => path.join(dir, f));
}

function requireTargets(src) {
	const targets = [];
	const re = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
	let m;
	while ((m = re.exec(src)) !== null) targets.push(m[1]);
	return targets;
}

test("game core (engine/ + common/) never imports runtime, db, or socket.io", () => {
	const violations = [];
	for (const dir of GAME_CORE_DIRS) {
		for (const file of jsFiles(dir)) {
			const src = fs.readFileSync(file, "utf8");
			for (const target of requireTargets(src)) {
				for (const f of FORBIDDEN) {
					if (f.re.test(target)) {
						violations.push(`${path.relative(ROOT, file)} ${f.why} (require("${target}"))`);
					}
				}
			}
		}
	}
	assert.deepStrictEqual(violations, [], "game-core boundary violations:\n" + violations.join("\n"));
});

// The game-plane runtime modules must not import the DB. They run the live match on the (future) game
// server, which has no DB access — match data arrives via the MatchConfig and results leave via
// persistResult. If one of these starts importing db, that's a leak across the split boundary.
const GAME_PLANE_MODULES = ["territory", "bots", "roomState", "gameUtil"].map(
	n => path.join(ROOT, "src/server/runtime", n + ".js")
);

test("game-plane runtime modules never import the database", () => {
	const violations = [];
	for (const file of GAME_PLANE_MODULES) {
		const src = fs.readFileSync(file, "utf8");
		for (const target of requireTargets(src)) {
			if (/(^|\/)db(\.js)?$/.test(target)) {
				violations.push(`${path.relative(ROOT, file)} imports db (require("${target}"))`);
			}
		}
	}
	assert.deepStrictEqual(violations, [], "game-plane → db boundary violations:\n" + violations.join("\n"));
});
