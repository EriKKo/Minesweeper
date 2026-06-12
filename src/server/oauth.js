// OAuth provider login (Google / Discord, plus GitHub server-side and the DEV_AUTH
// dev shortcut) — extracted from minesweeperServer. Self-contained: reads its config
// from the environment, manages CSRF `state` nonces, exchanges codes with each
// provider, resolves/upserts the user via db, and finishes by redirecting to
// /#token=<session>. The main server delegates /auth/* to handleAuthRoute and reads
// DEV_AUTH / OAUTH_BASE / providerFlags() for the connected payload and admin checks.

var crypto = require("node:crypto");
var db = require("./db");

// Return the first set value among several candidate env var names, so both the
// conventional UPPER_CASE names and the fly.io secret names work.
function envAny() {
	for (var i = 0; i < arguments.length; i++) {
		if (process.env[arguments[i]]) return process.env[arguments[i]];
	}
	return "";
}

var PORT = process.env.PORT || 1337;
var OAUTH_BASE = process.env.OAUTH_REDIRECT_BASE || ("http://localhost:" + PORT);
var GITHUB_CLIENT_ID = envAny("GITHUB_CLIENT_ID", "GITHUB_AUTH_CLIENT_ID", "github_auth_client_id");
var GITHUB_CLIENT_SECRET = envAny("GITHUB_CLIENT_SECRET", "GITHUB_AUTH_CLIENT_SECRET", "github_auth_client_secret");
var GOOGLE_CLIENT_ID = envAny("GOOGLE_CLIENT_ID", "GOOGLE_AUTH_CLIENT_ID", "google_auth_client_id");
var GOOGLE_CLIENT_SECRET = envAny("GOOGLE_CLIENT_SECRET", "GOOGLE_AUTH_CLIENT_SECRET", "google_auth_client_secret");
var DISCORD_CLIENT_ID = envAny("DISCORD_CLIENT_ID", "DISCORD_AUTH_CLIENT_ID", "discord_auth_client_id");
var DISCORD_CLIENT_SECRET = envAny("DISCORD_CLIENT_SECRET", "DISCORD_AUTH_CLIENT_SECRET", "discord_auth_client_secret");
var DEV_AUTH = process.env.DEV_AUTH === "1";
var oauthStates = {}; // state -> { exp, upgrade }

// OAuth `state` carries the CSRF nonce + (optionally) a guest session token to upgrade on callback.
function makeOAuthState(url) {
	var state = crypto.randomBytes(16).toString("hex");
	oauthStates[state] = { exp: Date.now() + 10 * 60 * 1000, upgrade: (url && url.searchParams.get("upgrade")) || null };
	return state;
}
// Validate + consume a state, returning its stored data (or null). One-shot.
function takeOAuthState(state) {
	var s = state && oauthStates[state];
	if (!s || s.exp < Date.now()) return null;
	delete oauthStates[state];
	return s;
}
// Resolve the provider login to a user: if a valid guest upgrade token came along, upgrade that guest in
// place (or fall back to a pre-existing account); otherwise a normal upsert.
function resolveOAuthUser(provider, providerId, name, avatarUrl, email, upgradeToken) {
	if (upgradeToken) {
		var guest = db.getUserByToken(upgradeToken);
		if (guest && guest.is_guest) return db.upgradeGuest(guest.id, provider, providerId, name, avatarUrl, email).user;
	}
	return db.upsertUser(provider, providerId, name, avatarUrl, email);
}

function authGithubLogin(req, res, url) {
	if (!GITHUB_CLIENT_ID) { res.writeHead(500); res.end("GitHub OAuth is not configured (set GITHUB_CLIENT_ID/SECRET)."); return; }
	var state = makeOAuthState(url);
	var params = new URLSearchParams({
		client_id: GITHUB_CLIENT_ID,
		redirect_uri: OAUTH_BASE + "/auth/github/callback",
		scope: "read:user user:email",
		state: state
	});
	res.writeHead(302, { Location: "https://github.com/login/oauth/authorize?" + params.toString() });
	res.end();
}

function authGithubCallback(req, res, url) {
	var code = url.searchParams.get("code");
	var stateData = takeOAuthState(url.searchParams.get("state"));
	if (!stateData) { res.writeHead(400); res.end("Invalid OAuth state"); return; }
	if (!code) { res.writeHead(400); res.end("Missing code"); return; }
	(async function() {
		try {
			var tokenResp = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: { "Accept": "application/json", "Content-Type": "application/json" },
				body: JSON.stringify({
					client_id: GITHUB_CLIENT_ID,
					client_secret: GITHUB_CLIENT_SECRET,
					code: code,
					redirect_uri: OAUTH_BASE + "/auth/github/callback"
				})
			});
			var tokenJson = await tokenResp.json();
			var accessToken = tokenJson.access_token;
			if (!accessToken) { res.writeHead(401); res.end("OAuth token exchange failed"); return; }
			var ghResp = await fetch("https://api.github.com/user", {
				headers: { "Authorization": "Bearer " + accessToken, "User-Agent": "minesweeper", "Accept": "application/vnd.github+json" }
			});
			var gh = await ghResp.json();
			// /user doesn't return private emails — fetch /user/emails separately
			// (requires `user:email` scope, which we ask for in the OAuth login).
			var ghEmail = gh.email || null;
			if (!ghEmail) {
				try {
					var emailsResp = await fetch("https://api.github.com/user/emails", {
						headers: { "Authorization": "Bearer " + accessToken, "User-Agent": "minesweeper", "Accept": "application/vnd.github+json" }
					});
					var emails = await emailsResp.json();
					if (Array.isArray(emails)) {
						var primary = emails.find(function(e) { return e.primary && e.verified; });
						if (primary) ghEmail = primary.email;
					}
				} catch (e) { /* email fetch optional */ }
			}
			var user = resolveOAuthUser("github", gh.id, gh.name || gh.login || ("user" + gh.id), gh.avatar_url, ghEmail, stateData.upgrade);
			finishLogin(res, user.id);
		} catch (e) {
			console.error("github oauth error", e);
			res.writeHead(500); res.end("OAuth error");
		}
	})();
}

function authGoogleLogin(req, res, url) {
	if (!GOOGLE_CLIENT_ID) { res.writeHead(500); res.end("Google OAuth is not configured (set GOOGLE_CLIENT_ID/SECRET)."); return; }
	var state = makeOAuthState(url);
	var params = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		redirect_uri: OAUTH_BASE + "/auth/google/callback",
		response_type: "code",
		scope: "openid email profile",
		state: state
	});
	res.writeHead(302, { Location: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString() });
	res.end();
}

function authGoogleCallback(req, res, url) {
	var code = url.searchParams.get("code");
	var stateData = takeOAuthState(url.searchParams.get("state"));
	if (!stateData) { res.writeHead(400); res.end("Invalid OAuth state"); return; }
	if (!code) { res.writeHead(400); res.end("Missing code"); return; }
	(async function() {
		try {
			var tokenResp = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
				body: new URLSearchParams({
					code: code,
					client_id: GOOGLE_CLIENT_ID,
					client_secret: GOOGLE_CLIENT_SECRET,
					redirect_uri: OAUTH_BASE + "/auth/google/callback",
					grant_type: "authorization_code"
				}).toString()
			});
			var tokenJson = await tokenResp.json();
			var accessToken = tokenJson.access_token;
			if (!accessToken) { res.writeHead(401); res.end("OAuth token exchange failed"); return; }
			var uResp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
				headers: { "Authorization": "Bearer " + accessToken }
			});
			var g = await uResp.json();
			var user = resolveOAuthUser("google", g.sub, g.name || g.email || ("user" + g.sub), g.picture, g.email, stateData.upgrade);
			finishLogin(res, user.id);
		} catch (e) {
			console.error("google oauth error", e);
			res.writeHead(500); res.end("OAuth error");
		}
	})();
}

function authDiscordLogin(req, res, url) {
	if (!DISCORD_CLIENT_ID) { res.writeHead(500); res.end("Discord OAuth is not configured (set DISCORD_CLIENT_ID/SECRET)."); return; }
	var state = makeOAuthState(url);
	var params = new URLSearchParams({
		client_id: DISCORD_CLIENT_ID,
		redirect_uri: OAUTH_BASE + "/auth/discord/callback",
		response_type: "code",
		scope: "identify email",
		state: state
	});
	res.writeHead(302, { Location: "https://discord.com/oauth2/authorize?" + params.toString() });
	res.end();
}

function authDiscordCallback(req, res, url) {
	var code = url.searchParams.get("code");
	var stateData = takeOAuthState(url.searchParams.get("state"));
	if (!stateData) { res.writeHead(400); res.end("Invalid OAuth state"); return; }
	if (!code) { res.writeHead(400); res.end("Missing code"); return; }
	(async function() {
		try {
			var tokenResp = await fetch("https://discord.com/api/oauth2/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
				body: new URLSearchParams({
					client_id: DISCORD_CLIENT_ID,
					client_secret: DISCORD_CLIENT_SECRET,
					grant_type: "authorization_code",
					code: code,
					redirect_uri: OAUTH_BASE + "/auth/discord/callback"
				}).toString()
			});
			var tokenJson = await tokenResp.json();
			var accessToken = tokenJson.access_token;
			if (!accessToken) { res.writeHead(401); res.end("OAuth token exchange failed"); return; }
			var uResp = await fetch("https://discord.com/api/users/@me", {
				headers: { "Authorization": "Bearer " + accessToken }
			});
			var d = await uResp.json();
			var name = d.global_name || d.username || ("user" + d.id);
			var avatar = d.avatar ? ("https://cdn.discordapp.com/avatars/" + d.id + "/" + d.avatar + ".png") : null;
			var email = d.verified ? d.email : null; // only trust a verified Discord email
			var user = resolveOAuthUser("discord", d.id, name, avatar, email, stateData.upgrade);
			finishLogin(res, user.id);
		} catch (e) {
			console.error("discord oauth error", e);
			res.writeHead(500); res.end("OAuth error");
		}
	})();
}

function authDev(req, res, url) {
	var name = (url.searchParams.get("name") || "Dev").slice(0, 24);
	var user = resolveOAuthUser("dev", name.toLowerCase(), name, null, null, url.searchParams.get("upgrade"));
	finishLogin(res, user.id);
}

function finishLogin(res, userId) {
	var token = db.createSession(userId);
	res.writeHead(302, { Location: OAUTH_BASE + "/#token=" + token });
	res.end();
}

// Dispatch an /auth/* request to the right provider flow. Returns true if it
// handled the request (so the main HTTP handler can early-return).
function handleAuthRoute(req, res, url) {
	var pathname = url.pathname;
	if (pathname === "/auth/github/login") { authGithubLogin(req, res, url); return true; }
	if (pathname === "/auth/github/callback") { authGithubCallback(req, res, url); return true; }
	if (pathname === "/auth/google/login") { authGoogleLogin(req, res, url); return true; }
	if (pathname === "/auth/google/callback") { authGoogleCallback(req, res, url); return true; }
	if (pathname === "/auth/discord/login") { authDiscordLogin(req, res, url); return true; }
	if (pathname === "/auth/discord/callback") { authDiscordCallback(req, res, url); return true; }
	if (DEV_AUTH && pathname === "/auth/dev") { authDev(req, res, url); return true; }
	return false;
}

module.exports = {
	OAUTH_BASE: OAUTH_BASE,
	DEV_AUTH: DEV_AUTH,
	handleAuthRoute: handleAuthRoute,
	// Which providers the client should offer buttons for. GitHub is wired above but
	// intentionally omitted — it's server-side only, not shown in the UI.
	providerFlags: function() { return { google: !!GOOGLE_CLIENT_ID, discord: !!DISCORD_CLIENT_ID, dev: DEV_AUTH }; }
};
