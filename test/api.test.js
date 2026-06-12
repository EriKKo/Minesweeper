// Integration test for the read-only /api/* surface (the admin/puzzle HTTP API).
// Boots the real server and checks each endpoint routes and returns JSON of the
// expected shape — the safety net for moving these handlers into their own module.

var test = require("node:test");
var assert = require("node:assert");
var helpers = require("./helpers");

var server;

test.before(async function() { server = await helpers.startServer(); });
test.after(function() { if (server) server.stop(); });

function get(p) { return helpers.getJson(server.base, p); }

test("/api/puzzle-sources -> { sources: [] }", async function() {
	var j = await get("/api/puzzle-sources");
	assert.ok(Array.isArray(j.sources), "sources is an array");
});

test("/api/bots -> { bots: [] }", async function() {
	var j = await get("/api/bots");
	assert.ok(Array.isArray(j.bots), "bots is an array");
});

test("/api/puzzles -> { puzzles: [] }", async function() {
	var j = await get("/api/puzzles?limit=5");
	assert.ok(Array.isArray(j.puzzles), "puzzles is an array");
});

test("/api/puzzles/stats -> object", async function() {
	var j = await get("/api/puzzles/stats");
	assert.strictEqual(typeof j, "object");
	assert.ok(j !== null);
});

test("/api/starting-positions -> object", async function() {
	var j = await get("/api/starting-positions");
	assert.strictEqual(typeof j, "object");
	assert.ok(j !== null);
});

test("/api/patterns -> object", async function() {
	var j = await get("/api/patterns");
	assert.strictEqual(typeof j, "object");
	assert.ok(j !== null);
});

test("/api/start-patterns -> object", async function() {
	var j = await get("/api/start-patterns");
	assert.strictEqual(typeof j, "object");
	assert.ok(j !== null);
});

test("/api/combined-puzzles -> object", async function() {
	var j = await get("/api/combined-puzzles");
	assert.strictEqual(typeof j, "object");
	assert.ok(j !== null);
});

test("SPA fallback: unknown extensionless path serves index.html", async function() {
	var r = await fetch(server.base + "/admin/puzzles");
	assert.strictEqual(r.status, 200);
	var body = await r.text();
	assert.ok(/<!DOCTYPE html>|<html/i.test(body), "serves the app shell");
});

test("missing asset with extension 404s", async function() {
	var r = await fetch(server.base + "/nope.js");
	assert.strictEqual(r.status, 404);
});
