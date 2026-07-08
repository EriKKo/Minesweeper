// Production build: concatenates the client scripts marked BUNDLE:START..BUNDLE:END in
// index.html (in that exact order — plain global scripts, not ES modules, so load order matters)
// into one file and minifies it with esbuild. Writes src/client/bundle.js.
//
// staticServer.js serves this single bundle instead of the individual <script> tags when it's
// present AND DEV_AUTH is unset (see the DEV/BUNDLE_PATH logic there) — local dev always loads the
// files individually, so day-to-day edits never need a rebuild; only production images do
// (Dockerfile runs `npm run build` before starting the server).
//
// Not a bundler in the module-resolution sense: these files share one global scope on purpose
// (each declares vars/functions the others read as globals), so this only concatenates + minifies
// text — esbuild.transformSync operates on a single string with no module wrapping, so top-level
// declarations stay real globals exactly as they are today, just delivered as one file.

var fs = require("fs");
var path = require("path");
var esbuild = require("esbuild");

var CLIENT_DIR = path.join(__dirname, "..", "src", "client");
var COMMON_DIR = path.join(__dirname, "..", "src", "common");
var INDEX_HTML = path.join(CLIENT_DIR, "index.html");
var OUT_FILE = path.join(CLIENT_DIR, "bundle.js");

var START_MARKER = "<!-- BUNDLE:START -->";
var END_MARKER = "<!-- BUNDLE:END -->";

function resolveClientFile(srcPath) {
	var underClient = path.join(CLIENT_DIR, srcPath);
	if (fs.existsSync(underClient)) return underClient;
	var underCommon = path.join(COMMON_DIR, srcPath);
	if (fs.existsSync(underCommon)) return underCommon;
	throw new Error("build-client: could not resolve script src \"" + srcPath + "\" under client/ or common/");
}

function main() {
	var html = fs.readFileSync(INDEX_HTML, "utf8");
	var startIdx = html.indexOf(START_MARKER);
	var endIdx = html.indexOf(END_MARKER);
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		throw new Error("build-client: BUNDLE:START/BUNDLE:END markers not found (or out of order) in index.html");
	}
	var block = html.slice(startIdx + START_MARKER.length, endIdx);

	var srcPaths = [];
	var re = /<script src="([^"]+)"/g;
	var m;
	while ((m = re.exec(block))) srcPaths.push(m[1]);
	if (!srcPaths.length) throw new Error("build-client: no <script src=\"...\"> tags found between the BUNDLE markers");

	var combined = srcPaths.map(function(srcPath) {
		var filePath = resolveClientFile(srcPath);
		return "// ---- " + srcPath + " ----\n" + fs.readFileSync(filePath, "utf8");
	}).join(";\n");

	var result = esbuild.transformSync(combined, {
		minify: true,
		target: "es2019",
		loader: "js"
	});

	fs.writeFileSync(OUT_FILE, result.code);
	var beforeKB = (Buffer.byteLength(combined) / 1024).toFixed(0);
	var afterKB = (Buffer.byteLength(result.code) / 1024).toFixed(0);
	console.log("build-client: " + srcPaths.length + " files, " + beforeKB + "KB -> " + afterKB + "KB (" + OUT_FILE + ")");
}

main();
