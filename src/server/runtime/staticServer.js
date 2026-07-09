// Static file serving for the client. Resolves a request path to a file under
// src/client or src/common, applies the SPA fallback (an extensionless path with no
// file on disk serves index.html, so the History-API router can render /learn,
// /admin/bots, … directly; a path with an extension 404s as a missing asset), and
// streams it with the right content type. Extracted from minesweeperServer so its
// HTTP handler is a pure router: auth → api → static.
//
// Compression + caching: text assets are gzipped/brotli'd on the fly (streamed through
// zlib, not buffered in memory — this runs on a 256MB instance, so per-request streaming
// beats holding a compressed-copy cache) based on the request's Accept-Encoding. Static
// JS/CSS/SVG/PNG get a modest Cache-Control (they have no cache-busting query string, so
// this is intentionally short); index.html itself is never cached, so a deploy is always
// picked up on the next navigation without a hard refresh.

var fs = require("fs");
var path = require("path");
var zlib = require("zlib");
var vm = require("vm");
var db = require("../db");
var session = require("./session");

// In dev (npm run dev / DEV_AUTH=1) nothing has a cache-busting URL and the whole point is fast
// iteration, so long-lived caching just serves stale JS/CSS after every edit — disable it there.
// Production keeps the real max-age.
var DEV = process.env.DEV_AUTH === "1";

// Static file roots, tried in order. Client assets (HTML, CSS, .js modules) live in
// src/client; the one shared module (BoardLogic.js) lives in src/common.
var STATIC_ROOTS = [
	path.join(__dirname, "..", "..", "client"),
	path.join(__dirname, "..", "..", "common")
];

var CONTENT_TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/manifest+json" };

// Production bundle swap: index.html loads its ~39 client scripts individually between two
// marker comments (BUNDLE:START/BUNDLE:END); `npm run build` (scripts/build-client.js)
// concatenates + minifies that exact list into bundle.js. In production, with a bundle actually
// on disk, swap the whole marked block for one <script defer src="/bundle.js"> tag. Dev always
// serves the files individually — no rebuild needed for day-to-day edits.
var BUNDLE_START = "<!-- BUNDLE:START -->";
var BUNDLE_END = "<!-- BUNDLE:END -->";
var BUNDLE_PATH = path.join(__dirname, "..", "..", "client", "bundle.js");
function applyBundleSwap(html) {
	if (DEV) return html;
	var startIdx = html.indexOf(BUNDLE_START);
	var endIdx = html.indexOf(BUNDLE_END);
	if (startIdx === -1 || endIdx === -1 || !fs.existsSync(BUNDLE_PATH)) return html;
	return html.slice(0, startIdx) + '<script defer src="/bundle.js"></script>' + html.slice(endIdx + BUNDLE_END.length);
}

// HTML injection ("SSR-lite"): give the client real data before the deferred bundle even runs, so
// the first render doesn't have to show placeholders while the socket connects/authenticates.
// This only ever inlines DATA (a plain JS object assignment) — the actual rendering still happens
// entirely client-side, in the same functions that already handle live socket updates; there's no
// server-side templating or hydration-matching to get right.
var HYDRATE_MARKER = "<!-- HYDRATE_DATA -->";

// A cookie mirrors the session token that normally only lives in localStorage (see Auth.js) — a
// plain HTTP GET has no access to localStorage, but does send cookies, so this is what lets a
// returning visitor's very first HTML response carry their own account data. Hand-rolled parse:
// no cookie library in this project, and the format is trivial (see the no-cookie-parsing-anywhere
// finding — this is the first cookie use in the app).
function parseCookies(header) {
	var out = {};
	(header || "").split(";").forEach(function(part) {
		var idx = part.indexOf("=");
		if (idx === -1) return;
		var key = part.slice(0, idx).trim();
		if (!key) return;
		try { out[key] = decodeURIComponent(part.slice(idx + 1).trim()); } catch (e) { /* malformed — ignore */ }
	});
	return out;
}

// JSON.stringify, but safe to drop inside an inline <script> — escapes "<" so a value containing
// "</script>" (or "<!--") can't break out of the tag. None of today's data (numbers, board arrays,
// short strings) could actually produce this, but the response is per-request text, not a fixed
// template, so it's worth guarding regardless of what future fields might carry.
function safeJson(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildHydrationScript(req) {
	var parts = [];

	// window.__DAILY__: today's puzzle board. Same for every visitor (no auth needed) — see
	// db.getOrPickDailyPuzzle, the same lookup the puzzle_daily_status socket handler uses.
	try {
		var date = db.todayUtc();
		var puzzle = db.getOrPickDailyPuzzle(date);
		var daily = puzzle ? { date: date, rows: puzzle.rows, cols: puzzle.cols, mines: puzzle.mines, revealed: puzzle.revealed } : null;
		parts.push("window.__DAILY__=" + safeJson(daily) + ";");
	} catch (e) { parts.push("window.__DAILY__=null;"); }

	// window.__ACCOUNT__: the requesting user's account snapshot, IF their ms_session cookie
	// resolves to a real session (see Auth.js's setSessionCookie — mirrors the same token already
	// trusted over the socket, so this isn't a new trust boundary). Absent for a first-time visitor
	// with no cookie yet — they fall back to today's behavior (skeleton until guest_session resolves).
	try {
		var token = parseCookies(req && req.headers && req.headers.cookie).ms_session;
		var user = token ? db.getUserByToken(token) : null;
		var account = user ? session.buildAccountPayload(user) : null;
		parts.push("window.__ACCOUNT__=" + safeJson(account) + ";");
	} catch (e) { parts.push("window.__ACCOUNT__=null;"); }

	parts.push(buildEarlyPaintScript());
	return "<script>" + parts.join("") + "</script>";
}

// The you-card — real per-account content (name/avatar/rating), not just a visibility toggle —
// still needs a script to RUN before the deferred bundle loads. Rather than hand-write a second
// copy of that logic here (which would silently drift from the real one the moment a page's
// rendering changes), this reads the ACTUAL client source — every block wrapped in an
// // SSR_INLINE:START / SSR_INLINE:END marker pair, across Ranking.js (tierFor / overallRating)
// and Profile.js (paintYouCardEarly, which calls the above) — straight off disk and embeds it
// verbatim. There's exactly one implementation of each piece, used two ways; editing any of it
// updates both automatically. Cached after the first read in production (the files don't change
// at runtime there); re-read on every request in dev, so editing any SSR_INLINE block and
// reloading reflects immediately, same as everything else in dev needing no rebuild.
var SSR_INLINE_START = "// SSR_INLINE:START";
var SSR_INLINE_END = "// SSR_INLINE:END";
var SSR_INLINE_SOURCES = [
	path.join(__dirname, "..", "..", "client", "views", "Ranking.js"),  // tierFor / overallRating
	path.join(__dirname, "..", "..", "client", "views", "Profile.js")   // paintYouCardEarly (calls the above)
];
function extractSsrInlineBlocks(filePath) {
	var src = fs.readFileSync(filePath, "utf8");
	var blocks = [];
	var from = 0;
	while (true) {
		var startIdx = src.indexOf(SSR_INLINE_START, from);
		if (startIdx === -1) break;
		var bodyStart = src.indexOf("\n", startIdx) + 1;
		var endIdx = src.indexOf(SSR_INLINE_END, bodyStart);
		if (endIdx === -1) break;
		blocks.push(src.slice(bodyStart, endIdx));
		from = endIdx + SSR_INLINE_END.length;
	}
	return blocks;
}
var earlyPaintScriptCache = null;
function buildEarlyPaintScript() {
	if (earlyPaintScriptCache && !DEV) return earlyPaintScriptCache;
	var code;
	try {
		code = SSR_INLINE_SOURCES.reduce(function(acc, filePath) {
			return acc.concat(extractSsrInlineBlocks(filePath));
		}, []).join("\n");
	} catch (e) { code = ""; }
	var script = code ? code + "\nif(window.__ACCOUNT__){paintYouCardEarly(window.__ACCOUNT__);}" : "";
	if (!DEV) earlyPaintScriptCache = script;
	return script;
}

function applyHydration(html, req) {
	var idx = html.indexOf(HYDRATE_MARKER);
	if (idx === -1) return html;
	return html.slice(0, idx) + buildHydrationScript(req) + html.slice(idx + HYDRATE_MARKER.length);
}

// Which view to show and which nav link to highlight is pure path -> {view,nav} data (no
// account/session dependency), so unlike the you-card above, it doesn't need a script to run in
// the browser at all — the server can just edit the response HTML directly before it's ever sent,
// so the right view is visible on the very first painted byte (even with JS disabled). ROUTE_VIEWS
// itself is read straight off Router.js (its own SSR_INLINE block — see the comment there), the
// same single source of truth the real client router uses, evaluated here as data via `vm` (this
// is our own trusted source file, not user input) rather than hand-copied.
var ROUTER_SOURCE = path.join(__dirname, "..", "..", "client", "ui", "Router.js");
var routeViewsCache = null;
function getRouteViews() {
	if (routeViewsCache && !DEV) return routeViewsCache;
	var routeViews;
	try {
		var block = extractSsrInlineBlocks(ROUTER_SOURCE)[0] || "";
		routeViews = vm.runInNewContext(block + "\nROUTE_VIEWS;", {});
	} catch (e) { routeViews = {}; }
	if (!DEV) routeViewsCache = routeViews;
	return routeViews;
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strips `style="display:none"` off the one <section id="..."> the current path maps to, and adds
// `active` to the matching nav <a>'s class list — both are targeted string edits on the specific
// tag (matched by id / data-route within that same opening tag, never crossing a `>`), not a
// template render, so they're safe against the rest of the markup changing shape elsewhere.
// Unmatched paths (solo, /ranked/*, /replay, /practice, or anything unknown) are left untouched,
// same as before — those stay hidden until the deferred bundle's real router runs.
function applyRouteReveal(html, pathname) {
	var entry = getRouteViews()[pathname];
	if (!entry) return html;
	if (entry.view) {
		var viewRe = new RegExp('(<section id="' + escapeRegExp(entry.view) + '"[^>]*?)\\s*style="display:none"');
		html = html.replace(viewRe, "$1");
	}
	if (entry.nav) {
		var navRe = new RegExp('(<a\\b[^>]*?class="site-nav-link)("[^>]*?data-route="' + escapeRegExp(entry.nav) + '")');
		html = html.replace(navRe, "$1 active$2");
	}
	return html;
}

// Binary types (png) are already compressed and gain nothing from gzip/brotli — can even grow
// slightly from the framing overhead — so only compress text.
var COMPRESSIBLE = { "text/javascript": true, "text/css": true, "image/svg+xml": true, "text/html": true, "application/manifest+json": true };

function resolveStatic(pathname) {
	if (pathname === "/") pathname = "/index.html";
	for (var i = 0; i < STATIC_ROOTS.length; i++) {
		var full = path.join(STATIC_ROOTS[i], pathname);
		// Guard against path traversal — must stay rooted under the static dir.
		if (full.indexOf(STATIC_ROOTS[i]) !== 0) continue;
		// Must be a regular FILE — a request like /admin matches the client `admin/` subfolder
		// (a directory), which readFile can't serve; let those fall through to the SPA fallback.
		try { if (fs.statSync(full).isFile()) return full; } catch (e) {}
	}
	return null;
}

// Prefer brotli (denser than gzip for text) when the client advertises it, else gzip, else
// serve uncompressed. Accept-Encoding is a comma-separated list (e.g. "gzip, deflate, br") —
// a simple substring test is sufficient here (no q-value negotiation needed for this use case).
function pickEncoding(req) {
	var accept = (req && req.headers && req.headers["accept-encoding"]) || "";
	if (accept.indexOf("br") !== -1) return "br";
	if (accept.indexOf("gzip") !== -1) return "gzip";
	return null;
}

// Compress + send a small in-memory buffer (used for index.html, which needs a text transform
// first so can't just stream straight from disk).
function serveBuffer(res, body, headers, encoding) {
	if (!encoding) {
		res.writeHead(200, headers);
		res.end(body);
		return;
	}
	headers = Object.assign({}, headers, { "Content-Encoding": encoding, "Vary": "Accept-Encoding" });
	var compress = (encoding === "br") ? zlib.brotliCompress : zlib.gzip;
	compress(body, function(err, compressed) {
		if (err) { res.destroy(); return; }
		res.writeHead(200, headers);
		res.end(compressed);
	});
}

// Service worker: __SW_VERSION__ (in the real sw.js source) is replaced with this process's start
// timestamp — every deploy is a fresh process, so every deploy gets a fresh cache name and the
// worker's `activate` step purges whatever the previous version cached. Computed once at startup,
// not per-request. Dev serves a small self-unregistering "kill switch" worker instead of the real
// one — even the source file's cache-first behavior has no place in dev's always-fresh iteration
// loop, and this also cleans up any real worker a dev previously registered while testing a prod
// build against this same origin.
var SW_VERSION = String(Date.now());
var SW_SOURCE_PATH = path.join(__dirname, "..", "..", "client", "sw.js");
var SW_KILL_SWITCH = [
	'self.addEventListener("install", function() { self.skipWaiting(); });',
	'self.addEventListener("activate", function(event) {',
	'\tevent.waitUntil(',
	'\t\tcaches.keys()',
	'\t\t\t.then(function(names) { return Promise.all(names.map(function(n) { return caches.delete(n); })); })',
	'\t\t\t.then(function() { return self.registration.unregister(); })',
	'\t\t\t.then(function() { return self.clients.matchAll(); })',
	'\t\t\t.then(function(clients) { clients.forEach(function(c) { c.navigate(c.url); }); })',
	'\t);',
	'});'
].join("\n");
var swSourceCache = null;
function serveServiceWorker(res, req) {
	var body;
	if (DEV) {
		body = SW_KILL_SWITCH;
	} else {
		if (!swSourceCache) swSourceCache = fs.readFileSync(SW_SOURCE_PATH, "utf8");
		// split/join, not .replace() — a plain string search only swaps the FIRST occurrence, and
		// this placeholder appears more than once (verified against the current source, but this
		// makes the substitution correct regardless of future edits to sw.js).
		body = swSourceCache.split("__SW_VERSION__").join(SW_VERSION);
	}
	var headers = { "Content-Type": "text/javascript", "Cache-Control": "no-cache" };
	serveBuffer(res, Buffer.from(body), headers, pickEncoding(req));
}

function serve(res, pathname, req) {
	if (pathname === "/sw.js") { serveServiceWorker(res, req); return; }
	var filePath = resolveStatic(pathname);
	if (!filePath) {
		var last = pathname.split("/").pop();
		if (last.indexOf(".") === -1) filePath = resolveStatic("/index.html");
		if (!filePath) { res.writeHead(404); res.end(); return; }
	}
	var contentType = CONTENT_TYPES[path.extname(filePath)] || "text/html";
	var headers = { "Content-Type": contentType };
	// index.html (and any other text/html path — the SPA fallback) must never go stale behind a
	// cache; everything else has no cache-busting in its URL, so keep the lifetime short rather
	// than long-lived/immutable. Dev disables it entirely (see DEV above).
	headers["Cache-Control"] = (contentType === "text/html" || DEV) ? "no-cache" : "public, max-age=3600";

	var encoding = COMPRESSIBLE[contentType] ? pickEncoding(req) : null;

	// index.html is the one file that needs a text transform (the production bundle swap, the route
	// reveal, and the hydration data injection, all above), so it can't stream straight from disk
	// like everything else — read it fully (a few dozen KB, cheap) and go through serveBuffer instead.
	if (path.basename(filePath) === "index.html") {
		fs.readFile(filePath, "utf8", function(err, html) {
			if (err) { res.writeHead(500); res.end("Error while loading " + filePath); return; }
			html = applyHydration(applyRouteReveal(applyBundleSwap(html), pathname), req);
			serveBuffer(res, Buffer.from(html), headers, encoding);
		});
		return;
	}

	if (!encoding) {
		fs.readFile(filePath, function(err, data) {
			if (err) {
				res.writeHead(500);
				res.end("Error while loading " + filePath);
			} else {
				res.writeHead(200, headers);
				res.end(data);
			}
		});
		return;
	}

	headers["Content-Encoding"] = encoding;
	headers["Vary"] = "Accept-Encoding";
	var stream = fs.createReadStream(filePath);
	var compressor = (encoding === "br") ? zlib.createBrotliCompress() : zlib.createGzip();
	// A mid-stream read error (file removed, etc.) after headers are already flushed can't send a
	// fresh 500 — just tear the connection down instead of hanging or crashing the process.
	stream.on("error", function() { res.destroy(); });
	compressor.on("error", function() { res.destroy(); });
	res.writeHead(200, headers);
	stream.pipe(compressor).pipe(res);
}

module.exports = { serve: serve };
