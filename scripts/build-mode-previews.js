// Pre-renders the 4 static home-dashboard mode-board previews (Sprint/Standard/Puzzles/Practice —
// see DASH_MODE_BOARDS in Profile.js) into PNG files, using a real headless browser running the
// actual client rendering code (buildLearnPuzzle / BoardRender.js) — so the images are pixel-
// identical to what the JS would draw, with no separate/duplicated rendering logic to drift out of
// sync. These 4 boards are fixed data in a fixed ("classic") skin, so there's no reason to redraw
// them per-request or even per-build: run this manually whenever DASH_MODE_BOARDS or the classic
// skin's colors change, and commit the resulting PNGs (src/client/mode-preview-*.png).
//
// index.html embeds these as plain <img> tags (inside the existing #dash_board_* slots), so
// showing them needs no client JS at all — renderModeBoardPreviews() (Profile.js) still runs as a
// defensive fallback; its existing "slot.firstChild" guard makes it a no-op once the <img> is
// already there.

var { chromium } = require("playwright");
var { spawn } = require("node:child_process");
var path = require("node:path");
var fs = require("node:fs");
var os = require("node:os");

var ROOT = path.join(__dirname, "..");
var PORT = 13851;
var OUT_DIR = path.join(ROOT, "src", "client");
var MODES = ["sprint", "standard", "puzzles", "solo"];
var SCALE = 2; // render at 2x for a crisp result on retina displays

function startServer() {
	var dbPath = path.join(os.tmpdir(), "ms-preview-build-" + process.pid + ".db");
	try { fs.unlinkSync(dbPath); } catch (e) {}
	var child = spawn("node", ["src/server/minesweeperServer.js"], {
		cwd: ROOT,
		env: Object.assign({}, process.env, { PORT: String(PORT), RANKED_DB: dbPath, DEV_AUTH: "1" }),
		stdio: "ignore"
	});
	var base = "http://localhost:" + PORT;
	return new Promise(function(resolve, reject) {
		var attempts = 0;
		(function poll() {
			fetch(base + "/").then(function(r) {
				if (r.ok) resolve({ child: child, dbPath: dbPath, base: base });
				else retry();
			}).catch(retry);
			function retry() {
				attempts++;
				if (attempts > 100) { try { child.kill("SIGKILL"); } catch (e) {} reject(new Error("server did not start")); return; }
				setTimeout(poll, 100);
			}
		})();
	});
}

async function main() {
	var server = await startServer();
	var dims = {};
	try {
		var browser = await chromium.launch();
		var page = await browser.newPage({ deviceScaleFactor: SCALE });
		await page.goto(server.base + "/", { waitUntil: "networkidle" });

		for (var i = 0; i < MODES.length; i++) {
			var mode = MODES[i];
			// Build the exact same DOM buildLearnPuzzle produces for this slot today, off-screen.
			await page.evaluate(function(key) {
				var b = DASH_MODE_BOARDS[key];
				var el = buildLearnPuzzle({
					title: "", rows: b.rows, cols: b.cols, mines: b.mines,
					revealed: b.revealed, revealStart: b.revealStart, flagged: b.flagged,
					skin: "classic"
				}, false, function() {});
				el.classList.add("dash-board-preview");
				el.style.background = "#131a2e"; // match .dash-row's background so edge pixels aren't transparent-black
				document.body.appendChild(el);
				el.querySelector("canvas").setAttribute("data-preview-capture", key);
			}, mode);
			var canvasHandle = await page.$('canvas[data-preview-capture="' + mode + '"]');
			var box = await canvasHandle.boundingBox();
			var outPath = path.join(OUT_DIR, "mode-preview-" + mode + ".png");
			await canvasHandle.screenshot({ path: outPath });
			// CSS pixel size (not the 2x-scaled PNG's raw pixel size) — this is what the <img>'s
			// width/height attributes need, so the browser reserves the right box before the file
			// itself has loaded.
			dims[mode] = { width: Math.round(box.width), height: Math.round(box.height) };
			console.log("wrote " + outPath + " (" + dims[mode].width + "x" + dims[mode].height + " css px, " + SCALE + "x raster)");
		}
		await browser.close();
	} finally {
		try { server.child.kill("SIGKILL"); } catch (e) {}
		try { fs.unlinkSync(server.dbPath); } catch (e) {}
	}
	console.log(JSON.stringify(dims));
}

main().catch(function(e) { console.error(e); process.exit(1); });
