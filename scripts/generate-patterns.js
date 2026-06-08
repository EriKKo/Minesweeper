// Catalogue the unique deduction patterns produced by starting-cascade positions, across
// block sizes, into a single JSON file tagged by which size(s) each pattern was found in.
//
// Patterns are the minimal first-move "building blocks" (canonicalised over the 8 dihedral
// variants, so identical logic at different positions/orientations collapses to one record).
// We enumerate 3x3 first, then 3x4, etc.; a pattern's `foundIn` lists every size it appeared
// in, so 3x4-only entries are the genuinely new building blocks the larger block unlocks.
//
// Run:  node scripts/generate-patterns.js
// Writes deduction-patterns.json at the project root. Expect a couple of minutes.

var fs = require("fs");
var path = require("path");
var SP = require("../src/server/StartPatterns");

var SIZES = [[3, 3], [3, 4], [4, 4]];

function ts() { return new Date().toISOString(); }
function log(m) { console.log("[" + ts() + "] " + m); }

// Each block size is enumerated in three placement categories: open (interior, ring on all
// sides), wall (flush against one board edge), and corner (flush against two adjacent edges).
// Walls remove ring cells and add wall cells to the pattern, so wall/corner positions yield
// distinct patterns. For non-square blocks the two wall orientations differ, so both run under
// the same "wall" category. All four corners are equivalent up to symmetry, so one suffices.
var RUNS = [];
SIZES.forEach(function(sz) {
	var H = sz[0], W = sz[1];
	RUNS.push({ H: H, W: W, cat: "open", walls: {} });
	RUNS.push({ H: H, W: W, cat: "wall", walls: { top: true } });
	if (H !== W) RUNS.push({ H: H, W: W, cat: "wall", walls: { left: true } });
	RUNS.push({ H: H, W: W, cat: "corner", walls: { top: true, left: true } });
});

var catalog = {}; // key -> record

RUNS.forEach(function(run) {
	var label = run.H + "x" + run.W + " " + run.cat;
	log("Enumerating " + label + " starting positions…");
	var t0 = Date.now();
	var res = SP.enumeratePatterns(run.H, run.W, run.walls);
	var keys = Object.keys(res.patterns);
	var newToCatalog = 0;
	keys.forEach(function(key) {
		var e = res.patterns[key];
		var rec = catalog[key];
		if (!rec) {
			var p = e.pattern;
			catalog[key] = {
				key: key,
				method: p.method,
				complexity: Math.round(p.complexity * 100) / 100,
				rating: p.rating,
				width: p.width,
				height: p.height,
				clueCells: p.clueCells,
				deducedCells: p.deducedCells,
				coveredCells: p.coveredCells,
				wallCells: p.wallCells || [],
				foundIn: [label],
				counts: {}
			};
			catalog[key].counts[label] = e.count;
			newToCatalog++;
		} else {
			if (rec.foundIn.indexOf(label) < 0) rec.foundIn.push(label);
			rec.counts[label] = (rec.counts[label] || 0) + e.count; // accumulate across wall orientations
		}
	});
	log("  " + label + ": " + res.positions + " positions → " + keys.length + " unique patterns (" + newToCatalog + " new) in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
});

var patterns = Object.keys(catalog).map(function(k) { return catalog[k]; });
patterns.sort(function(a, b) { return b.complexity - a.complexity; }); // hardest first

var out = {
	generatedAt: ts(),
	sizes: SIZES.map(function(s) { return s[0] + "x" + s[1]; }),
	patterns: patterns
};
var outPath = path.join(__dirname, "..", "deduction-patterns.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, "\t"));
log("Wrote " + patterns.length + " unique patterns to " + outPath + " (" + (fs.statSync(outPath).size / 1024).toFixed(0) + " KB)");

// --- report ---
console.log("\nBy source set:");
var bySet = {};
patterns.forEach(function(p) { var tag = p.foundIn.join("+"); bySet[tag] = (bySet[tag] || 0) + 1; });
Object.keys(bySet).sort().forEach(function(tag) { console.log("  " + tag.padEnd(12) + bySet[tag]); });

console.log("\nComplexity (rating) spread — hardest patterns:");
patterns.slice(0, 12).forEach(function(p) {
	console.log("  rating " + String(p.rating).padStart(5) + "  cx " + p.complexity.toFixed(2).padStart(6) + "  " + p.method.padEnd(9) + "  found in " + p.foundIn.join("+"));
});
var maxByTag = {};
patterns.forEach(function(p) { var t = p.foundIn.join("+"); if (!maxByTag[t] || p.complexity > maxByTag[t]) maxByTag[t] = p.complexity; });
console.log("\nHardest complexity per source set:");
Object.keys(maxByTag).sort().forEach(function(t) { console.log("  " + t.padEnd(12) + maxByTag[t].toFixed(2)); });
