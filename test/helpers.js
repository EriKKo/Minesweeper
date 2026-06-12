// Test helpers: spin up the real server on an isolated port + a throwaway DB,
// wait until it answers, and hand back a base URL + a stop(). Used by the
// integration tests (node --test). No framework, no deps.

var spawn = require("node:child_process").spawn;
var path = require("node:path");
var os = require("node:os");
var fs = require("node:fs");

var ROOT = path.join(__dirname, "..");

// Start a server child on `port` with a fresh temp ranked.db and DEV_AUTH on.
// Resolves once it responds (or rejects after ~12s).
async function startServer(opts) {
	opts = opts || {};
	var port = opts.port || 13799;
	var dbPath = path.join(os.tmpdir(), "ms-test-" + process.pid + "-" + port + ".db");
	try { fs.unlinkSync(dbPath); } catch (e) {}
	var child = spawn("node", ["src/server/minesweeperServer.js"], {
		cwd: ROOT,
		env: Object.assign({}, process.env, { PORT: String(port), RANKED_DB: dbPath, DEV_AUTH: "1" }),
		stdio: "ignore"
	});
	var base = "http://localhost:" + port;
	for (var i = 0; i < 120; i++) {
		try {
			var r = await fetch(base + "/api/puzzle-sources");
			if (r.ok) {
				return {
					base: base,
					stop: function() { try { child.kill("SIGKILL"); } catch (e) {} try { fs.unlinkSync(dbPath); } catch (e2) {} }
				};
			}
		} catch (e) { /* not up yet */ }
		await new Promise(function(f) { setTimeout(f, 100); });
	}
	try { child.kill("SIGKILL"); } catch (e) {}
	throw new Error("server did not start on " + base);
}

// GET a path and assert 200; return parsed JSON.
async function getJson(base, pathname) {
	var assert = require("node:assert");
	var r = await fetch(base + pathname);
	assert.strictEqual(r.status, 200, pathname + " should return 200 (got " + r.status + ")");
	return r.json();
}

module.exports = { startServer: startServer, getJson: getJson, ROOT: ROOT };
