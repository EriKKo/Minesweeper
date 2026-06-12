// Static file serving for the client. Resolves a request path to a file under
// src/client or src/common, applies the SPA fallback (an extensionless path with no
// file on disk serves index.html, so the History-API router can render /learn,
// /admin/bots, … directly; a path with an extension 404s as a missing asset), and
// streams it with the right content type. Extracted from minesweeperServer so its
// HTTP handler is a pure router: auth → api → static.

var fs = require("fs");
var path = require("path");

// Static file roots, tried in order. Client assets (HTML, CSS, .js modules) live in
// src/client; the one shared module (BoardLogic.js) lives in src/common.
var STATIC_ROOTS = [
	path.join(__dirname, "..", "..", "client"),
	path.join(__dirname, "..", "..", "common")
];

var CONTENT_TYPES = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

function resolveStatic(pathname) {
	if (pathname === "/") pathname = "/index.html";
	for (var i = 0; i < STATIC_ROOTS.length; i++) {
		var full = path.join(STATIC_ROOTS[i], pathname);
		// Guard against path traversal — must stay rooted under the static dir.
		if (full.indexOf(STATIC_ROOTS[i]) !== 0) continue;
		try { fs.accessSync(full, fs.constants.R_OK); return full; } catch (e) {}
	}
	return null;
}

function serve(res, pathname) {
	var filePath = resolveStatic(pathname);
	if (!filePath) {
		var last = pathname.split("/").pop();
		if (last.indexOf(".") === -1) filePath = resolveStatic("/index.html");
		if (!filePath) { res.writeHead(404); res.end(); return; }
	}
	var contentType = CONTENT_TYPES[path.extname(filePath)] || "text/html";
	fs.readFile(filePath, function(err, data) {
		if (err) {
			res.writeHead(500);
			res.end("Error while loading " + filePath);
		} else {
			res.writeHead(200, { "Content-Type": contentType });
			res.end(data);
		}
	});
}

module.exports = { serve: serve };
