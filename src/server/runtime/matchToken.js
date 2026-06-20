// Match-join token (PHASE0_TICKETS.md P0-8, ARCHITECTURE_PLAN.md §8).
//
// The auth primitive for the future game/main boundary: when main allocates a player to a match it
// issues a short-lived signed token; the game server verifies it (shared secret, no DB lookup) when
// the client connects directly. Building + testing the primitive now means Phase 1 just has to attach
// it to the new client→game-server connection — the boundary doesn't exist yet in the monolith (players
// are seated server-side over their existing socket), so this is intentionally NOT wired into a join
// path yet. HMAC-SHA256 over a base64url JSON payload; secret from MATCH_TOKEN_SECRET (dev fallback).

var crypto = require("crypto");

var SECRET = process.env.MATCH_TOKEN_SECRET || "dev-insecure-match-secret";
var DEFAULT_TTL_MS = 60 * 1000; // a join token is short-lived — it's spent immediately on connect

function sign(body) {
	return crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
}

// Issue a signed join token for { matchId, userId, gameServerAddr? }, valid for ttlMs (default 60s).
function issueMatchToken(claims, ttlMs) {
	claims = claims || {};
	var payload = {
		matchId: claims.matchId != null ? claims.matchId : null,
		playerKey: claims.playerKey != null ? claims.playerKey : null, // the seat this socket binds to (P1-2/P1-6)
		userId: claims.userId != null ? claims.userId : null,
		addr: claims.gameServerAddr || null,
		exp: Date.now() + (ttlMs || DEFAULT_TTL_MS)
	};
	var body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return body + "." + sign(body);
}

// Verify a token: returns the payload if the signature is valid and it hasn't expired, else null.
// `now` is injectable for testing. Constant-time signature compare.
function verifyMatchToken(token, now) {
	if (typeof token !== "string") return null;
	var dot = token.indexOf(".");
	if (dot < 1 || dot !== token.lastIndexOf(".")) return null;
	var body = token.slice(0, dot), sig = token.slice(dot + 1);
	var expected = sign(body);
	var a = Buffer.from(sig), b = Buffer.from(expected);
	if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
	var payload;
	try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
	if (!payload || typeof payload.exp !== "number") return null;
	if ((now != null ? now : Date.now()) >= payload.exp) return null;
	return payload;
}

module.exports = {
	issueMatchToken: issueMatchToken,
	verifyMatchToken: verifyMatchToken
};
