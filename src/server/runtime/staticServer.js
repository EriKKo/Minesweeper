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

var CONTENT_TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

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

// Binary types (png) are already compressed and gain nothing from gzip/brotli — can even grow
// slightly from the framing overhead — so only compress text.
var COMPRESSIBLE = { "text/javascript": true, "text/css": true, "image/svg+xml": true, "text/html": true };

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

function serve(res, pathname, req) {
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

	// index.html is the one file that needs a text transform (the production bundle swap above),
	// so it can't stream straight from disk like everything else — read it fully (a few dozen KB,
	// cheap) and go through serveBuffer instead.
	if (path.basename(filePath) === "index.html") {
		fs.readFile(filePath, "utf8", function(err, html) {
			if (err) { res.writeHead(500); res.end("Error while loading " + filePath); return; }
			serveBuffer(res, Buffer.from(applyBundleSwap(html)), headers, encoding);
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
