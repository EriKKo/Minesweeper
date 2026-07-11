// Live game board canvas: the RAF animation loop, the reveal/flag/mine
// per-cell timing (cellAnims keyed by "r,c"), pressed-cell + keyboard-focus
// highlights, and the renderPlayerBoard function that paints the player's
// own board each frame. Also owns drawBoardStatic for the opponent thumbnails
// and liveBoardView, which builds the game's BoardView (board + territory hooks).

var prevPlayerState = null;   // last-seen state of game0, for reveal diffing
var cellAnims = {};            // "r,c" -> { type:"reveal"|"flag"|"mine", start:ms }
var animRAF = null;
var lastActionCell = null;     // where the local player last revealed, for ripple origin

// Round-start countdown, drawn ON the board itself instead of a text overlay on top of it: a
// blocky digit (3/2/1) formed from a patch of cells near the board's centre, filled dark and
// fading back to the normal covered colour before the next digit. No "GO" glyph — the round's
// opening cascade (the first draw_board once the countdown finishes) is itself the go signal.
// See startCountdownGlyph (called from countdownDigitCycle in Overlay.js).
var COUNTDOWN_GLYPHS = {
	"3": ["111", "001", "111", "001", "111"],
	"2": ["111", "001", "111", "100", "111"],
	"1": ["010", "110", "010", "010", "111"]
};
// Tunable knobs, shared by real gameplay and the /admin/countdown lab (CountdownLab.js) — the lab's
// sliders mutate this object directly, so what it previews is the exact code path a real round
// uses, not a copy of it. fadeInMs/holdMs/fadeOutMs/gapMs together set the length of one digit's
// tick — the interval between one digit STARTING and the next one starting (see countdownDigitCycle
// in Overlay.js, which reads this instead of a fixed 1000ms): fade in, hold, fade out, then gapMs of
// plain blue before the next digit starts fading in. This is purely cosmetic pacing now — it no
// longer determines when a round actually goes live, see the comment on countDown in Overlay.js.
// gapMs can go NEGATIVE — the next digit then starts (and begins fading in) before the previous one
// has finished fading out, so both are visible and crossfading at once; see countdownGlyphs below.
// brightness/indent: read by
// drawPressedGlyphCell/drawGlowGlyphCell below — brightness scales the fill, indent scales the
// depth cue (pressed: shadow/highlight strength; glow: bloom size) — drawFlatGlyphCell ignores
// indent, since a flat colour swap has no depth to speak of. color: the base hue the fill/glow/
// highlight/flat-tint are derived from (see hexToRgb/lighten/darken below) — the pressed
// treatment's top shadow stays neutral black regardless, since that's a depth cue, not a colour.
// Chosen via /admin/countdown: "reveal" (a patch of the board spells out the digit using real,
// numbered clue cells — see drawRevealGlyphCell) at fade-in 200ms, hold 300ms, fade-out 500ms, gap
// 100ms (tick = 1100ms/digit).
var COUNTDOWN_STYLE = {
	mode: "reveal", // "glow" | "pressed" | "flat" | "reveal"
	fadeInMs: 200,
	holdMs: 300,
	fadeOutMs: 500,
	gapMs: 100,
	brightness: 1,
	indent: 1,
	color: "#bfdbfe",
	persistUnchanged: false
};
// Every currently-fading-or-held digit for the live game, oldest first — usually just one, but a
// negative gapMs means the next digit's cycle can start while the previous one is still fading out,
// so more than one can be live at once. Painted oldest-to-newest so a newer digit layers on top of
// an older one in any cells they share. Used only when COUNTDOWN_STYLE.persistUnchanged is false —
// see countdownCells below for the alternative.
var countdownGlyphs = [];

// Alternative to countdownGlyphs, used when COUNTDOWN_STYLE.persistUnchanged is true: "r,c" ->
// { number, litSince, fadeOutStart }, one entry per currently-lit cell rather than one entry per
// digit. A cell that's part of two consecutive digits' shapes (e.g. "3" and "2" share their whole
// top row) just keeps its existing litSince and stays fully visible across the transition instead
// of fading out and immediately back in — only cells that actually stop being needed get a
// fadeOutStart, and only cells that are newly needed get a fresh litSince. See
// advanceCountdownCells/paintCountdownCells below.
var countdownCells = {};

// One digit's full cycle length: fade in, hold, fade out, then a gap of plain blue (or, if gapMs is
// negative, an overlap into the next digit's own fade-in) before the next digit starts. Purely
// cosmetic pacing for the digit sequence itself (see countDown's comment in Overlay.js for what
// actually governs when a round goes live). Shared by countdownDigitCycle (Overlay.js, real
// gameplay) and countdownLabDigitCycle (CountdownLab.js, the looping preview) so the two can't drift
// apart on how this is computed. Floored well above 0 regardless of how negative gapMs goes, so it
// can't schedule the next tick immediately (or in the past) and spawn glyphs faster than they can
// ever finish painting.
function countdownTickMs() {
	return Math.max(50, COUNTDOWN_STYLE.fadeInMs + COUNTDOWN_STYLE.holdMs + COUNTDOWN_STYLE.fadeOutMs + COUNTDOWN_STYLE.gapMs);
}

function hexToRgb(hex) {
	hex = (hex || "#bfdbfe").replace("#", "");
	if (hex.length === 3) hex = hex.split("").map(function(ch) { return ch + ch; }).join("");
	var num = parseInt(hex, 16) || 0;
	return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbaStr(rgb, a) {
	return "rgba(" + rgb.r + ", " + rgb.g + ", " + rgb.b + ", " + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
}
function lightenRgb(rgb, amt) {
	return { r: Math.round(rgb.r + (255 - rgb.r) * amt), g: Math.round(rgb.g + (255 - rgb.g) * amt), b: Math.round(rgb.b + (255 - rgb.b) * amt) };
}
function darkenRgb(rgb, amt) {
	return { r: Math.round(rgb.r * (1 - amt)), g: Math.round(rgb.g * (1 - amt)), b: Math.round(rgb.b * (1 - amt)) };
}

// Pure: glyph shape + placement scale for `number`, sized to a board boardRows tall. No
// dependency on live-game globals, so the same call works for the real board and for
// /admin/countdown's own preview board alike. scale maps each glyph "pixel" to an NxN patch of
// real cells so the digit reads at a consistent size whether the board is small (10 rows) or
// large (16 rows), rather than shrinking to a sliver of a big board or overflowing a small one.
function buildCountdownGlyphState(number, boardRows) {
	var glyph = COUNTDOWN_GLYPHS[String(number)];
	if (!glyph || !boardRows) return null;
	var scale = Math.max(1, Math.round(boardRows / 10));
	return { glyph: glyph, scale: scale, start: performance.now(), number: number };
}

// Pure: which [r,c] cells `number`'s glyph lights up on a boardRows x boardCols board — the same
// placement math buildCountdownGlyphState's caller (paintCountdownGlyph) uses, factored out so
// advanceCountdownCells (persistUnchanged mode) can diff one digit's cells against the next's.
function countdownGlyphCells(number, boardRows, boardCols) {
	var glyph = COUNTDOWN_GLYPHS[String(number)];
	if (!glyph || !boardRows) return [];
	var scale = Math.max(1, Math.round(boardRows / 10));
	var glyphRows = glyph.length * scale, glyphCols = glyph[0].length * scale;
	var startRow = Math.floor((boardRows - glyphRows) / 2);
	var startCol = Math.floor((boardCols - glyphCols) / 2);
	var out = [];
	for (var gr = 0; gr < glyph.length; gr++) {
		for (var gc = 0; gc < glyph[gr].length; gc++) {
			if (glyph[gr].charAt(gc) !== "1") continue;
			for (var sr = 0; sr < scale; sr++) {
				for (var sc = 0; sc < scale; sc++) {
					var r = startRow + gr * scale + sr, c = startCol + gc * scale + sc;
					if (r < 0 || r >= boardRows || c < 0 || c >= boardCols) continue;
					out.push([r, c]);
				}
			}
		}
	}
	return out;
}

function startCountdownGlyph(number) {
	if (COUNTDOWN_STYLE.persistUnchanged) {
		advanceCountdownCells(countdownCells, number, rows, cols);
		startAnimLoop();
		return;
	}
	var g = buildCountdownGlyphState(number, rows);
	if (!g) return;
	countdownGlyphs.push(g);
	startAnimLoop();
}

function drawCountdownGlyph(ctx, sw, sh) {
	if (!myState) return;
	var isRevealed = function(r, c) { return myState[r][c] === KNOWN; };
	if (COUNTDOWN_STYLE.persistUnchanged) { paintCountdownCells(ctx, sw, sh, countdownCells, isRevealed); return; }
	countdownGlyphs = paintCountdownGlyphs(ctx, sw, sh, rows, cols, countdownGlyphs, isRevealed);
}

// Paints every glyph in glyphStates (oldest first, so a newer digit layers on top of an older one
// in shared cells — see countdownGlyphs above) and returns the subset still alive, for the caller to
// keep as its new list.
function paintCountdownGlyphs(ctx, sw, sh, boardRows, boardCols, glyphStates, isRevealed) {
	var alive = [];
	for (var i = 0; i < glyphStates.length; i++) {
		if (paintCountdownGlyph(ctx, sw, sh, boardRows, boardCols, glyphStates[i], isRevealed)) alive.push(glyphStates[i]);
	}
	return alive;
}

// persistUnchanged mode: move countdownCells to `number`'s shape. A cell the new digit still wants
// just has any pending fade-out cancelled (it was never actually removed, so it stays exactly as
// visible as it already was — no re-fade). A cell the new digit drops gets fadeOutStart stamped now
// (if it isn't already fading). A cell the new digit newly wants gets a fresh litSince so it fades
// in from scratch. Geometry-only — actual painting/fading/removal happens in paintCountdownCells.
// Mutates cellsMap in place (like queueRevealAnimations does to cellAnims) rather than
// returning a new one — takes the map as a parameter (not the countdownCells global directly) so
// the live game and the /admin/countdown lab can each keep their own independent instance, the same
// separation countdownGlyphs/countdownLabGlyphs already have.
function advanceCountdownCells(cellsMap, number, boardRows, boardCols) {
	var cells = countdownGlyphCells(number, boardRows, boardCols);
	var wanted = {};
	for (var i = 0; i < cells.length; i++) wanted[cells[i][0] + "," + cells[i][1]] = true;
	var now = performance.now();
	for (var key in cellsMap) {
		if (wanted[key]) cellsMap[key].fadeOutStart = null;
		else if (cellsMap[key].fadeOutStart === null) cellsMap[key].fadeOutStart = now;
	}
	for (var k in wanted) {
		if (cellsMap[k]) cellsMap[k].number = number; // still lit — just relabel for reveal mode
		else cellsMap[k] = { number: number, litSince: now, fadeOutStart: null };
	}
}

// persistUnchanged mode: paints every cell tracked in cellsMap — steady ones (no fadeOutStart) fade
// in once from litSince then hold indefinitely (the next advanceCountdownCells call, driven by
// countdownTickMs, decides when they actually need to start leaving); cells with a fadeOutStart
// fade out from that moment and are deleted from cellsMap once fully gone. Returns whether anything
// is still tracked (including cells skipped this frame by isRevealed), so callers know whether to
// keep animating.
function paintCountdownCells(ctx, sw, sh, cellsMap, isRevealed) {
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	var now = performance.now();
	var any = false;
	for (var key in cellsMap) {
		var cell = cellsMap[key];
		var alpha;
		if (cell.fadeOutStart !== null) {
			var fo = COUNTDOWN_STYLE.fadeOutMs;
			alpha = fo > 0 ? Math.max(0, 1 - (now - cell.fadeOutStart) / fo) : 0;
			if (alpha <= 0) { delete cellsMap[key]; continue; }
		} else {
			var fi = COUNTDOWN_STYLE.fadeInMs;
			var elapsed = now - cell.litSince;
			alpha = (fi > 0 && elapsed < fi) ? elapsed / fi : 1;
		}
		any = true;
		var parts = key.split(","), r = parseInt(parts[0], 10), c = parseInt(parts[1], 10);
		if (isRevealed && isRevealed(r, c)) continue;
		drawCountdownGlyphCell(ctx, c * sw + gap / 2, r * sh + gap / 2, w, h, rad, alpha, cell.number);
	}
	return any;
}

// Renders glyphState (from buildCountdownGlyphState) onto ctx at boardRows x boardCols cell
// geometry. isRevealed(r,c), if given, skips cells that shouldn't be tinted — a board can already
// show its pre-opened cascade during the countdown (solo does; ranked stays fully covered until
// GO), and washing over an already-revealed clue cell just muddies the number instead of reading
// as part of the digit. Returns false once fully faded — callers should drop their glyph reference
// then (and, if driving their own loop, stop it).
function paintCountdownGlyph(ctx, sw, sh, boardRows, boardCols, glyphState, isRevealed) {
	if (!glyphState) return false;
	var elapsed = performance.now() - glyphState.start;
	var fadeInMs = COUNTDOWN_STYLE.fadeInMs, holdMs = COUNTDOWN_STYLE.holdMs, fadeOutMs = COUNTDOWN_STYLE.fadeOutMs;
	var alpha;
	if (elapsed < fadeInMs) alpha = fadeInMs > 0 ? elapsed / fadeInMs : 1;
	else if (elapsed < fadeInMs + holdMs) alpha = 1;
	else alpha = fadeOutMs > 0 ? Math.max(0, 1 - (elapsed - fadeInMs - holdMs) / fadeOutMs) : 0;
	if (alpha <= 0) return false;
	var glyph = glyphState.glyph, scale = glyphState.scale;
	var glyphRows = glyph.length * scale;
	var glyphCols = glyph[0].length * scale;
	var startRow = Math.floor((boardRows - glyphRows) / 2);
	var startCol = Math.floor((boardCols - glyphCols) / 2);
	// Same inset/rounding every normal cell uses (see drawCell in BoardRender.js) so a lit glyph
	// cell reads as a distinct cell being pressed, not a borderless dark blob.
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	for (var gr = 0; gr < glyph.length; gr++) {
		for (var gc = 0; gc < glyph[gr].length; gc++) {
			if (glyph[gr].charAt(gc) !== "1") continue;
			for (var sr = 0; sr < scale; sr++) {
				for (var sc = 0; sc < scale; sc++) {
					var r = startRow + gr * scale + sr;
					var c = startCol + gc * scale + sc;
					if (r < 0 || r >= boardRows || c < 0 || c >= boardCols) continue;
					if (isRevealed && isRevealed(r, c)) continue;
					drawCountdownGlyphCell(ctx, c * sw + gap / 2, r * sh + gap / 2, w, h, rad, alpha, glyphState.number);
				}
			}
		}
	}
	return true;
}

function drawCountdownGlyphCell(ctx, x, y, w, h, rad, alpha, number) {
	if (COUNTDOWN_STYLE.mode === "pressed") drawPressedGlyphCell(ctx, x, y, w, h, rad, alpha);
	else if (COUNTDOWN_STYLE.mode === "flat") drawFlatGlyphCell(ctx, x, y, w, h, rad, alpha);
	else if (COUNTDOWN_STYLE.mode === "reveal") drawRevealGlyphCell(ctx, x, y, w, h, rad, alpha, number);
	else drawGlowGlyphCell(ctx, x, y, w, h, rad, alpha);
}

// The "funny" treatment: the glyph's cells actually reveal, each showing the current countdown
// digit as an ordinary clue number — reusing the real board's own drawKnownBase/drawNumber
// (BoardRender.js), so this is a patch of the board briefly and literally spelling out "3" using a
// crowd of little 3s (then a crowd of 2s, then 1s). Fades the same as every other style: drawNumber
// takes its own alpha/pop-scale from `t`, so passing alpha through as `t` fades the number in place
// rather than needing a second alpha layer on top.
function drawRevealGlyphCell(ctx, x, y, w, h, rad, alpha, number) {
	ctx.save();
	ctx.translate(x, y);
	ctx.globalAlpha = alpha;
	drawKnownBase(ctx, w, h, rad);
	drawNumber(ctx, number, w, h, alpha);
	ctx.restore();
}

// Simplest treatment: no depth cue at all, just the cell's colour changing to the base colour and
// back — same inset/rounding as every other cell so it still reads as a distinct cell, just a flat
// single-tone fill instead of a gradient.
function drawFlatGlyphCell(ctx, x, y, w, h, rad, alpha) {
	ctx.save();
	ctx.translate(x, y);
	ctx.globalAlpha = alpha;
	var base = hexToRgb(COUNTDOWN_STYLE.color);
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = rgbaStr(base, 0.85 * COUNTDOWN_STYLE.brightness);
	ctx.fill();
	ctx.restore();
}

// The normal covered cell (drawUnknown in BoardRender.js) reads as raised: light gradient top to
// dark bottom, plus a bright top hairline and a dark bottom edge — light hitting a bump. This is
// that same treatment inverted — dark pooling at the top like the recess's shadow, a touch lighter
// at the bottom where light catches the inner lip — so the glyph cells read as pressed IN rather
// than just darker.
function drawPressedGlyphCell(ctx, x, y, w, h, rad, alpha) {
	ctx.save();
	ctx.translate(x, y);
	ctx.globalAlpha = alpha;
	var b = COUNTDOWN_STYLE.brightness, ind = COUNTDOWN_STYLE.indent;
	var base = hexToRgb(COUNTDOWN_STYLE.color);
	// The fill is a darkened version of the base colour (a lit material would still read dark in a
	// shadowed recess); the top/bottom strokes below stay their own thing (see comments there).
	var fillTop = darkenRgb(base, 0.90), fillBottom = darkenRgb(base, 0.74);
	var g = ctx.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, rgbaStr(fillTop, 0.62 * b));
	g.addColorStop(1, rgbaStr(fillBottom, 0.34 * b));
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = g;
	ctx.fill();
	// shadow hugging the top inner edge — the recess's deepest point, always neutral black (a
	// shadow has no material colour). indent scales how deep it reads: a thin, faint line barely
	// dents the cell; thick and dark reads as a real pocket.
	ctx.strokeStyle = "rgba(0, 0, 0, " + Math.min(1, 0.38 * ind).toFixed(3) + ")";
	ctx.lineWidth = Math.max(1, h * 0.10 * ind);
	ctx.beginPath();
	ctx.moveTo(rad, ctx.lineWidth / 2);
	ctx.lineTo(w - rad, ctx.lineWidth / 2);
	ctx.stroke();
	// faint highlight catching the bottom inner lip — tinted toward the base colour, like light
	// bouncing off the pocket's floor.
	ctx.strokeStyle = rgbaStr(lightenRgb(base, 0.35), 0.20 * ind);
	ctx.lineWidth = Math.max(1, h * 0.06 * ind);
	ctx.beginPath();
	ctx.moveTo(rad, h - ctx.lineWidth / 2);
	ctx.lineTo(w - rad, h - ctx.lineWidth / 2);
	ctx.stroke();
	ctx.restore();
}

// Alternate treatment being tried alongside drawPressedGlyphCell: cells glow UP instead of
// pressing in — a bright fill plus an actual bloom (shadowBlur bleeding past the cell's own
// edges, the signature of glowing rather than just being lighter) and a bright rim amplifying
// the raised highlight every normal cell already has.
function drawGlowGlyphCell(ctx, x, y, w, h, rad, alpha) {
	ctx.save();
	ctx.translate(x, y);
	ctx.globalAlpha = alpha;
	var b = COUNTDOWN_STYLE.brightness, ind = COUNTDOWN_STYLE.indent;
	var base = hexToRgb(COUNTDOWN_STYLE.color);
	var fillTop = lightenRgb(base, 0.82), fillBottom = lightenRgb(base, 0.30);
	var rim = lightenRgb(base, 0.92);
	// indent doubles here as "how far the glow puffs out" — glow has no literal depth, but it's
	// the same "how pronounced is the dimensional effect" knob as the pressed style's shadow depth.
	ctx.shadowBlur = Math.max(0, w * 0.6 * ind);
	ctx.shadowColor = rgbaStr(base, 0.85 * b);
	var g = ctx.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, rgbaStr(fillTop, 0.95 * b));
	g.addColorStop(1, rgbaStr(fillBottom, 0.80 * b));
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = g;
	ctx.fill();
	ctx.shadowBlur = 0;
	ctx.strokeStyle = rgbaStr(rim, 0.75 * b);
	ctx.lineWidth = Math.max(1, h * 0.08);
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.stroke();
	ctx.restore();
}

// "Go" board animation: a single wave that sweeps across the board once, the instant the game is
// ready to start — right before the countdown begins, not after it finishes (see
// startBoardGoAnimation's call sites: Main.js's start_game handler, Solo.js's beginSolo,
// Territory.js's territoryStart) — a different, one-shot thing from the countdown digit above,
// tunable separately from the same "Board animations" admin lab (CountdownLab.js). Purely
// decorative: roundStartTime, not this, is what actually unlocks input (Input.js), so nothing here
// affects gameplay timing.
var BOARD_GO_STYLE = {
	mode: "diagonal", // "diagonal" | "radial" | "rowWipe" | "colWipe"
	durationMs: 700,
	width: 3,          // how many cells wide the wave band is
	brightness: 0.7,
	color: "#bfdbfe",
	pauseAfterMs: 300  // beat of plain blue between the sweep finishing and the countdown starting
};
var boardGoAnim = null; // { start } | null — the live game's current sweep

// Pure: just a timestamp today, but built the same way as buildCountdownGlyphState (a function, not
// a bare object literal) so the real game and the lab can each hold their own independent instance
// and so there's one obvious place to add per-sweep parameters later if a style ever needs them.
function buildBoardGoAnimState() {
	return { start: performance.now() };
}

function startBoardGoAnimation(boardRows, boardCols) {
	if (!boardRows || !boardCols) { boardGoAnim = null; return; }
	boardGoAnim = buildBoardGoAnimState();
	startAnimLoop();
}

// How long to wait after startBoardGoAnimation before starting the countdown that follows it — the
// sweep's own duration plus a beat of plain blue, so the countdown doesn't start over the sweep or
// cut it off. Shared by every startBoardGoAnimation call site (Main.js's start_game handler,
// Solo.js's beginSolo, Territory.js's territoryStart) so they can't drift on how it's computed —
// same reasoning as countdownTickMs above.
function boardGoTotalMs() {
	return Math.max(0, BOARD_GO_STYLE.durationMs) + Math.max(0, BOARD_GO_STYLE.pauseAfterMs);
}

// The full "ready to start" sequence's natural length: the go sweep + its pause, then three digit
// ticks (3, 2, 1). Used where there's no server-side deadline to defer to (solo, and the
// /admin/countdown lab's own preview) — countDown's delayMs is set to exactly this, so those places
// don't have to invent their own round-start timing.
function naturalCountdownTotalMs() {
	return boardGoTotalMs() + 3 * countdownTickMs();
}

// How far cell (r,c) sits along `mode`'s sweep axis, and that axis's max extent on a
// boardRows x boardCols board — diagonal sweeps top-left to bottom-right, radial ripples out from
// centre, rowWipe/colWipe scan top-to-bottom / left-to-right. The paint function below moves a wave
// front linearly along this axis from just-off-board to just-off-board over durationMs.
function boardGoAxisPos(mode, r, c, boardRows, boardCols) {
	if (mode === "radial") return Math.hypot(r - (boardRows - 1) / 2, c - (boardCols - 1) / 2);
	if (mode === "rowWipe") return r;
	if (mode === "colWipe") return c;
	return r + c; // diagonal
}
function boardGoAxisMax(mode, boardRows, boardCols) {
	if (mode === "radial") {
		var cr = (boardRows - 1) / 2, cc = (boardCols - 1) / 2;
		return Math.hypot(Math.max(cr, boardRows - 1 - cr), Math.max(cc, boardCols - 1 - cc));
	}
	if (mode === "rowWipe") return boardRows - 1;
	if (mode === "colWipe") return boardCols - 1;
	return boardRows - 1 + boardCols - 1; // diagonal
}

// Renders animState (from buildBoardGoAnimState) onto ctx at boardRows x boardCols cell geometry.
// isRevealed(r,c), if given, skips cells that are already revealed — same reasoning as
// paintCountdownGlyph: washing over a real clue number muddies it instead of reading as the sweep.
// Returns false once the sweep has fully passed, so callers know to drop their reference.
function paintBoardGoAnimation(ctx, sw, sh, boardRows, boardCols, animState, isRevealed) {
	if (!animState) return false;
	var duration = Math.max(50, BOARD_GO_STYLE.durationMs);
	var elapsed = performance.now() - animState.start;
	if (elapsed >= duration) return false;
	var mode = BOARD_GO_STYLE.mode;
	var width = Math.max(0.5, BOARD_GO_STYLE.width);
	var maxP = boardGoAxisMax(mode, boardRows, boardCols);
	// The front travels from one width-band short of the board to one width-band past it, so the
	// wave visibly enters and exits rather than snapping on/off at the edges.
	var frontP = (elapsed / duration) * (maxP + width * 2) - width;
	var base = hexToRgb(BOARD_GO_STYLE.color);
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	for (var r = 0; r < boardRows; r++) {
		for (var c = 0; c < boardCols; c++) {
			var dist = Math.abs(boardGoAxisPos(mode, r, c, boardRows, boardCols) - frontP);
			if (dist > width) continue;
			if (isRevealed && isRevealed(r, c)) continue;
			var strength = 1 - dist / width; // 1 at the front's centre, 0 at the band's edge
			drawGoAnimCell(ctx, c * sw + gap / 2, r * sh + gap / 2, w, h, rad, strength * BOARD_GO_STYLE.brightness, base);
		}
	}
	return true;
}

// Reuses the glow style's visual language (bright bloom-y fill) since a "the board is coming alive"
// pulse reads naturally as light, regardless of which countdown digit style is active.
function drawGoAnimCell(ctx, x, y, w, h, rad, alpha, base) {
	ctx.save();
	ctx.translate(x, y);
	ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
	ctx.shadowBlur = Math.max(0, w * 0.6);
	ctx.shadowColor = rgbaStr(base, 0.8);
	var g = ctx.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, rgbaStr(lightenRgb(base, 0.85), 0.92));
	g.addColorStop(1, rgbaStr(lightenRgb(base, 0.32), 0.78));
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = g;
	ctx.fill();
	ctx.shadowBlur = 0;
	ctx.restore();
}

// Same wave math as paintBoardGoAnimation, but a cell the wave hasn't reached YET also gets the idle
// animation painted on it (instead of sitting flat/dark) — so the effect reads as the sweep settling
// the idle board into stillness as it passes, rather than two independent effects layered on top of
// each other: ahead of the wave the board is still idling, right at the wave it flashes bright, and
// behind the wave it's plain and still — "ready for play". Used only by the real game
// (renderPlayerBoard); the admin lab's own Go sweep tab keeps using the bare paintBoardGoAnimation so
// it previews the sweep's own motion in isolation, unblended with idle. Returns false once the sweep
// has fully passed — same contract as paintBoardGoAnimation, and the caller should treat that as "the
// whole board is now settled" (see its own call site for why that also means turning idle off there).
function paintBoardGoWithIdle(ctx, sw, sh, boardRows, boardCols, animState, isRevealed) {
	if (!animState) return false;
	var duration = Math.max(50, BOARD_GO_STYLE.durationMs);
	var elapsed = performance.now() - animState.start;
	if (elapsed >= duration) return false;
	var mode = BOARD_GO_STYLE.mode;
	var width = Math.max(0.5, BOARD_GO_STYLE.width);
	var maxP = boardGoAxisMax(mode, boardRows, boardCols);
	var frontP = (elapsed / duration) * (maxP + width * 2) - width;
	var base = hexToRgb(BOARD_GO_STYLE.color);
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	var now = performance.now();
	var idleMode = BOARD_IDLE_STYLE.mode;
	var idleSpeed = Math.max(0.05, BOARD_IDLE_STYLE.speed);
	var idleBrightness = BOARD_IDLE_STYLE.brightness;
	var idleBase = hexToRgb(BOARD_IDLE_STYLE.color);
	var idleFrameCtx = boardIdleFrameContext(idleMode, boardRows, boardCols, now, idleSpeed);
	for (var r = 0; r < boardRows; r++) {
		for (var c = 0; c < boardCols; c++) {
			if (isRevealed && isRevealed(r, c)) continue;
			var pos = boardGoAxisPos(mode, r, c, boardRows, boardCols);
			var dist = Math.abs(pos - frontP);
			if (dist <= width) {
				var strength = 1 - dist / width; // 1 at the front's centre, 0 at the band's edge
				drawGoAnimCell(ctx, c * sw + gap / 2, r * sh + gap / 2, w, h, rad, strength * BOARD_GO_STYLE.brightness, base);
			} else if (pos > frontP) {
				// Ahead of the wave — still idling, waiting its turn to be cleared.
				var idleAlpha = boardIdleCellAlpha(idleMode, r, c, boardRows, boardCols, now, idleSpeed, idleBrightness, idleFrameCtx);
				if (idleAlpha > 0.015) drawIdleCell(ctx, c * sw + gap / 2, r * sh + gap / 2, w, h, rad, idleAlpha, idleBase);
			}
			// pos < frontP - width: the wave has fully passed — settled, plain, nothing drawn.
		}
	}
	return true;
}

// Idle board animation, played continuously (no fixed duration, unlike the go sweep above) while
// waiting for a casual series to start — replaces the old static dim + "Waiting for series to
// start" text (see the .idle rules removed from style.css) with something that reads as "alive"
// rather than "disabled". Toggled from GameRoom.js's existing .idle class logic (setBoardIdleActive
// alongside the classList.toggle, not instead of it — .idle still drives other CSS, like hiding the
// find-next-cell arrow). Tunable from the "Board animations" admin lab (CountdownLab.js) alongside
// the countdown digit and go sweep.
var BOARD_IDLE_STYLE = {
	mode: "twinkle", // "breathe" | "shimmer" | "twinkle"
	speed: 3,
	brightness: 0.7,
	color: "#bfdbfe"
};
var boardIdleActive = false;

function setBoardIdleActive(active) {
	active = !!active;
	if (active === boardIdleActive) return;
	boardIdleActive = active;
	if (active) startAnimLoop();
}

// Per-cell idle brightness (0 = not glowing this frame) for BOARD_IDLE_STYLE's current mode at time
// `now` — factored out of paintBoardIdleAnimation so paintBoardGoWithIdle (below) can paint idle on a
// cell-by-cell basis too, for just the cells its sweep hasn't reached yet.
// Per-frame setup for idle modes whose math has a part that's constant across every cell (shimmer's
// sweep position depends only on boardRows/boardCols/now/speed, never r/c) — computed once per paint
// call and threaded through boardIdleCellAlpha below instead of recomputed on every one of a board's
// cells, every frame, for as long as idle is active.
function boardIdleFrameContext(mode, boardRows, boardCols, now, speed) {
	if (mode !== "shimmer") return null;
	var maxP = boardGoAxisMax("diagonal", boardRows, boardCols);
	var periodMs = 2600 / speed;
	return { frontP: ((now % periodMs) / periodMs) * (maxP + 6) - 3, width: 2.5 };
}

function boardIdleCellAlpha(mode, r, c, boardRows, boardCols, now, speed, brightness, frameCtx) {
	if (mode === "shimmer") {
		// A soft diagonal band that loops continuously (unlike the one-shot go sweep it reuses the
		// axis math from), slow and low-brightness so it reads as ambient, not attention-grabbing.
		var dist = Math.abs(boardGoAxisPos("diagonal", r, c, boardRows, boardCols) - frameCtx.frontP);
		if (dist > frameCtx.width) return 0;
		return (1 - dist / frameCtx.width) * 0.30 * brightness;
	}
	if (mode === "twinkle") {
		// Each cell's own sine wave, phase-offset by a cheap position hash so they twinkle out of
		// sync — only the positive half of the wave actually lights up, so most cells sit dark at
		// any moment and a few softly glow, like a slow starfield.
		var seed = ((r * 928371 + c * 123457) % 1000) / 1000;
		var wave = Math.sin((now / 1000) * speed * (0.4 + seed * 0.6) + seed * Math.PI * 2);
		return Math.max(0, wave) * 0.28 * brightness;
	}
	// "breathe": the whole board pulses together, gently, like a slow held breath.
	var t = (now / 1000) * speed;
	var intensity = (Math.sin(t * Math.PI * 0.6) + 1) / 2; // 0..1
	return (0.08 + 0.16 * intensity) * brightness;
}

// Unlike buildCountdownGlyphState/buildBoardGoAnimState, there's no per-instance state to build —
// idle just reads performance.now() directly each frame, forever, for as long as boardIdleActive
// (or, for the lab's own preview, its own local flag) says to keep going.
function paintBoardIdleAnimation(ctx, sw, sh, boardRows, boardCols, isRevealed) {
	var now = performance.now();
	var mode = BOARD_IDLE_STYLE.mode;
	var speed = Math.max(0.05, BOARD_IDLE_STYLE.speed);
	var brightness = BOARD_IDLE_STYLE.brightness;
	var base = hexToRgb(BOARD_IDLE_STYLE.color);
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	var frameCtx = boardIdleFrameContext(mode, boardRows, boardCols, now, speed);
	for (var r = 0; r < boardRows; r++) {
		for (var c = 0; c < boardCols; c++) {
			if (isRevealed && isRevealed(r, c)) continue;
			var alpha = boardIdleCellAlpha(mode, r, c, boardRows, boardCols, now, speed, brightness, frameCtx);
			if (alpha <= 0.015) continue;
			drawIdleCell(ctx, c * sw + gap / 2, r * sh + gap / 2, w, h, rad, alpha, base);
		}
	}
}

function drawIdleCell(ctx, x, y, w, h, rad, alpha, base) {
	ctx.save();
	ctx.translate(x, y);
	ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = rgbaStr(lightenRgb(base, 0.5), 1);
	ctx.fill();
	ctx.restore();
}

function drawPressedHighlight() {
	if (!pressedCell || !myState) return;
	if (!currentActionMode()) return;
	var r = pressedCell.r, c = pressedCell.c;
	if (r < 0 || r >= rows || c < 0 || c >= cols) return;
	var ctx = playerCanvas.getContext("2d");
	var sw = playerCanvas.width / cols, sh = playerCanvas.height / rows;
	var x = c * sw, y = r * sh;
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	ctx.save();
	ctx.fillStyle = "rgba(255, 255, 255, 0.32)";
	roundRectPath(ctx, x + gap / 2, y + gap / 2, sw - gap, sh - gap, (Math.min(sw, sh) - gap) * 0.2);
	ctx.fill();
	ctx.restore();
}

function drawFocusHighlight() {
	if (!focusVisible) return;
	if (!currentActionMode()) return;
	if (focusedR < 0 || focusedR >= rows || focusedC < 0 || focusedC >= cols) return;
	var ctx = playerCanvas.getContext("2d");
	// Derive the cell size live from the canvas (single source of truth, same as the board renderer) —
	// a cached copy drifts out of sync when the canvas is resized (custom board sizes / layout switches).
	var sw = playerCanvas.width / cols, sh = playerCanvas.height / rows;
	var x = focusedC * sw;
	var y = focusedR * sh;
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	ctx.save();
	ctx.strokeStyle = "#facc15";
	ctx.lineWidth = 2;
	roundRectPath(ctx, x + gap / 2, y + gap / 2, sw - gap, sh - gap, (Math.min(sw, sh) - gap) * 0.2);
	ctx.stroke();
	ctx.restore();
}

function redrawOwnBoardWithFocus() {
	renderPlayerBoard();
}

// The live game's board: a BoardView over the decoded board (boardCell) plus the
// territory-only accessors the renderer consults when present (no-ops in racing/
// solo/puzzle, which share this path). Callers add per-cell animation and overlays.
function liveBoardView(canvas, state, skinId) {
	return new BoardView(canvas, rows, cols, state, boardCell, {
		skin: skinId || null,
		// Territory mode tints claimed cells by owner colour; gated on territoryActive so the
		// colours never bleed into the racing/solo/puzzle boards (they share this render path).
		getOwner: function(r, c) { return (typeof territoryActive !== "undefined" && territoryActive && territoryOwnerColors) ? territoryOwnerColors[r][c] : null; },
		// Territory "fog of clues": you see clue numbers on cells YOU control, plus any opponent cell
		// that borders one of yours (so the contested frontier is readable). Opponent cells deeper in
		// their territory show their owner tint but no clue. Off (always show) in every other mode.
		hideClue: function(r, c) {
			if (typeof territoryActive === "undefined" || !territoryActive || !territoryOwnerColors || typeof territoryInfo === "undefined" || !territoryInfo) return false;
			var mineColor = territoryColorHex(territoryColorOf(territoryInfo.myId));
			if (territoryOwnerColors[r][c] === mineColor) return false; // your own cell — always shown
			for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
				if (!dr && !dc) continue;
				var nr = r + dr, nc = c + dc;
				if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && territoryOwnerColors[nr][nc] === mineColor) return false; // borders your territory
			}
			return true; // not yours and not touching you — hidden
		},
		// Territory structure charge (0..1), interpolated live from the last broadcast so the gauge fills
		// smoothly between updates. null/1 when not a structure.
		structureCharge: function(r, c) {
			if (typeof territoryStructures === "undefined" || !territoryStructures) return 1;
			var s = territoryStructures[r + "," + c];
			if (!s || !s.cooldownMs) return 1;
			var remaining = s.readyAt - performance.now();
			return remaining <= 0 ? 1 : 1 - remaining / s.cooldownMs;
		},
		// Extractor construction progress (0..1). 1 = built/operational. Interpolated from the broadcast.
		structureBuild: function(r, c) {
			if (typeof territoryStructures === "undefined" || !territoryStructures) return 1;
			var s = territoryStructures[r + "," + c];
			if (!s || !s.buildMs) return 1;
			var remaining = s.builtAt - performance.now();
			return remaining <= 0 ? 1 : 1 - remaining / s.buildMs;
		}
	});
}

// ---- whole boards ------------------------------------------------------
// skinId: the board owner's skin (opponents render in their own theme; pass "classic"
// for bots / unknown so they never inherit the local user's skin).
function drawBoardStatic(state, canvas, skinId) {
	liveBoardView(canvas, state, skinId).draw();
}

function renderPlayerBoard() {
	// Covered cells never read the decoder (only revealed cells call getClue), so an
	// all-covered board paints fine before the decoder arrives — that's the pre-round
	// countdown / ranked match-reveal board. A null myState clears the canvas (no game).
	if (myState) {
		var now = performance.now();
		// Normally your own board uses your skin; while spectating (eliminated) slot 0 shows a
		// rival's board, so paint it in their skin instead.
		var ownSkin = (typeof iAmEliminated !== "undefined" && iAmEliminated && typeof spectatorTargetSkin !== "undefined" && spectatorTargetSkin) ? spectatorTargetSkin : localBoardSkin;
		var bv = liveBoardView(playerCanvas, myState, ownSkin);
		bv.animAt = function(r, c) {
			var a = cellAnims[r + "," + c];
			if (!a) return null;
			var dur = a.type === "flag" ? FLAG_DUR : a.type === "mine" ? MINE_DUR : REVEAL_DUR;
			return { type: a.type, t: (now - a.start) / dur };
		};
		bv.overlay(function(ctx, sw, sh) {
			if (typeof drawTerritoryClaims === "function") drawTerritoryClaims(ctx, sw, sh); // territory: bomb claim locks
			if (typeof drawTerritoryEnergyLines === "function") drawTerritoryEnergyLines(ctx, sw, sh); // territory: power grid
			if (typeof drawTerritoryBeams === "function") drawTerritoryBeams(ctx, sw, sh); // territory: offensive beam streaks
			if (typeof drawTerritoryMissiles === "function") drawTerritoryMissiles(ctx, sw, sh); // territory: bombs in flight
			drawCountdownGlyph(ctx, sw, sh); // round-start countdown digit
			var isRevealedFn = function(r, c) { return myState[r][c] === KNOWN; };
			if (boardGoAnim) {
				// While the sweep is running it OWNS the idle-vs-settled call per cell (see
				// paintBoardGoWithIdle) regardless of boardIdleActive's own external timing — the sweep
				// IS the idle-to-ready transition, so it doesn't matter whether whatever toggled idle on
				// in the first place has already flipped it off by now. Once the sweep finishes, force
				// idle off too: "the sweep clears the board" should always mean fully settled, everywhere,
				// not just up to wherever the wave happened to reach.
				if (!paintBoardGoWithIdle(ctx, sw, sh, rows, cols, boardGoAnim, isRevealedFn)) {
					boardGoAnim = null;
					setBoardIdleActive(false);
				}
			} else if (boardIdleActive) {
				paintBoardIdleAnimation(ctx, sw, sh, rows, cols, isRevealedFn); // idle (waiting for series)
			}
		});
		bv.draw();
	} else {
		var ctx = playerCanvas.getContext("2d");
		ctx.clearRect(0, 0, playerCanvas.width, playerCanvas.height);
		// The idle animation can be active before any board exists yet — waiting for players means
		// myState isn't set up until a round is actually dealt, but rows/cols are already known this
		// early (see applyBoardDims in the room_state handler, Main.js). Paint a plain covered grid +
		// the idle animation directly rather than leaving the canvas blank/black.
		if (boardIdleActive && rows && cols) {
			var isw = playerCanvas.width / cols, ish = playerCanvas.height / rows;
			var igap = Math.max(1, Math.round(Math.min(isw, ish) * 0.08));
			var iw = isw - igap, ih = ish - igap;
			var irad = Math.min(iw, ih) * 0.2;
			for (var ir = 0; ir < rows; ir++) {
				for (var ic = 0; ic < cols; ic++) {
					ctx.save();
					ctx.translate(ic * isw + igap / 2, ir * ish + igap / 2);
					drawUnknown(ctx, iw, ih, irad);
					ctx.restore();
				}
			}
			paintBoardIdleAnimation(ctx, isw, ish, rows, cols, null);
		}
	}
	drawPressedHighlight();
	drawFocusHighlight();
	drawPuzzleHintHighlights();
}

// Hint highlights: yellow glow on the clue cell(s) the player should read,
// softer dotted outline on the covered cells whose status those clues
// determine. Persists until the player makes any move (the next click /
// flag clears the highlight via clearPuzzleHints).
function drawPuzzleHintHighlights() {
	if (typeof puzzleHintClues === "undefined") return;
	if (!puzzleHintClues.length && !puzzleHintCovered.length) return;
	var ctx = playerCanvas.getContext("2d");
	var sw = playerCanvas.width / cols, sh = playerCanvas.height / rows;
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	ctx.save();
	// Covered cells first — softer outline so the clue's glow reads on top.
	ctx.strokeStyle = "rgba(251, 191, 36, 0.55)";
	ctx.lineWidth = 2;
	ctx.setLineDash([6, 4]);
	for (var i = 0; i < puzzleHintCovered.length; i++) {
		var rc = puzzleHintCovered[i];
		var x = rc[1] * sw, y = rc[0] * sh;
		roundRectPath(ctx, x + gap / 2, y + gap / 2, sw - gap, sh - gap, (Math.min(sw, sh) - gap) * 0.2);
		ctx.stroke();
	}
	ctx.setLineDash([]);
	// Clue cells — bright glow.
	ctx.strokeStyle = "#fbbf24";
	ctx.lineWidth = 3;
	ctx.shadowBlur = 14;
	ctx.shadowColor = "rgba(251, 191, 36, 0.9)";
	for (var j = 0; j < puzzleHintClues.length; j++) {
		var rc2 = puzzleHintClues[j];
		var x2 = rc2[1] * sw, y2 = rc2[0] * sh;
		roundRectPath(ctx, x2 + gap / 2, y2 + gap / 2, sw - gap, sh - gap, (Math.min(sw, sh) - gap) * 0.2);
		ctx.stroke();
	}
	ctx.restore();
}

// ---- reveal/flag animation bookkeeping ---------------------------------
function cloneState(state) {
	var out = new Array(rows);
	for (var r = 0; r < rows; r++) out[r] = state[r].slice();
	return out;
}

function resetBoardAnimations() {
	prevPlayerState = null;
	cellAnims = {};
	lastActionCell = null;
	countdownGlyphs = [];
	countdownCells = {};
	boardGoAnim = null;
	opponentRevealAnims = null;
	opponentRevealTargets = null;
	if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; }
}

// Opponent boards ripple in on the round's OPENING reveal too, mirroring our own board's
// queueRevealAnimations — but only for that one reveal, never for an opponent's own later moves
// (those aren't something we want to visually stage). Every board shares this round's layout, so the
// opening reveal is the exact same cells with the exact same distances-from-origin on every board —
// the schedule cellAnims just got populated with (queueRevealAnimations, called right before this)
// applies unchanged to every opponent target, regardless of whether each target's own state array
// came from our local deterministic computation or from the real draw_board packet (both are the
// same content — see performRoundStartReveal in Main.js, which calls this from either race path).
// Snapshotted into a separate map rather than read live off cellAnims, since cellAnims keeps
// accumulating the PLAYER'S OWN later moves for the rest of the round and those must never bleed onto
// an opponent's board.
var opponentRevealAnims = null;   // "r,c" -> {type,start}, a snapshot of cellAnims — null when idle
var opponentRevealTargets = null; // [{canvas, skin, state}, ...] — each target paints its OWN state

function startOpponentRevealAnim(targets) {
	if (!targets.length) return;
	opponentRevealAnims = {};
	for (var key in cellAnims) opponentRevealAnims[key] = cellAnims[key];
	opponentRevealTargets = targets;
	startAnimLoop();
}

function opponentRevealAnimAt(r, c) {
	var a = opponentRevealAnims[r + "," + c];
	if (!a) return null;
	var dur = a.type === "mine" ? MINE_DUR : REVEAL_DUR;
	return { type: a.type, t: (performance.now() - a.start) / dur };
}

// Repaints every opponent reveal target for the current frame; returns whether any of them still
// has a cell mid-animation (so the caller's RAF loop knows whether to keep going). Always paints —
// including the terminal frame where it flips to "not alive" and clears its own state — so the last
// frame lands on the fully-settled board, same as cellAnims/renderPlayerBoard's own pattern.
function paintOpponentRevealFrame() {
	var now = performance.now();
	var alive = false;
	for (var key in opponentRevealAnims) {
		var a = opponentRevealAnims[key];
		var dur = a.type === "mine" ? MINE_DUR : REVEAL_DUR;
		if (now < a.start + dur) alive = true;
	}
	for (var i = 0; i < opponentRevealTargets.length; i++) {
		var target = opponentRevealTargets[i];
		var bv = liveBoardView(target.canvas, target.state, target.skin);
		bv.animAt = opponentRevealAnimAt;
		bv.draw();
	}
	if (!alive) { opponentRevealAnims = null; opponentRevealTargets = null; }
	return alive;
}

function queueRevealAnimations(newState) {
	var now = performance.now();
	var revealed = [];
	var newlyFlagged = 0, newlyUnflagged = 0;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			var was = prevPlayerState ? prevPlayerState[r][c] : UNKNOWN;
			var cur = newState[r][c];
			var key = r + "," + c;
			if (cur === KNOWN && was !== KNOWN) {
				revealed.push([r, c]);
			} else if (cur === FLAGGED && was !== FLAGGED) {
				cellAnims[key] = { type: "flag", start: now };
				newlyFlagged++;
			} else if (cur !== KNOWN && cur !== FLAGGED) {
				if (was === FLAGGED) newlyUnflagged++;
				delete cellAnims[key];
			}
		}
	}
	var hitMine = false, safeRevealed = 0;
	if (revealed.length) {
		var origin = lastActionCell;
		if (!origin || newState[origin.r][origin.c] !== KNOWN) {
			var sr = 0, sc = 0;
			for (var i = 0; i < revealed.length; i++) { sr += revealed[i][0]; sc += revealed[i][1]; }
			origin = { r: sr / revealed.length, c: sc / revealed.length };
		}
		for (var j = 0; j < revealed.length; j++) {
			var rr = revealed[j][0], cc = revealed[j][1];
			var d = Math.hypot(rr - origin.r, cc - origin.c);
			var delay = Math.min(d * STAGGER_MS, STAGGER_CAP);
			var isMine = boardCell(rr, cc) === MINE;
			if (isMine) hitMine = true; else safeRevealed++;
			cellAnims[rr + "," + cc] = { type: isMine ? "mine" : "reveal", start: now + delay };
		}
		if (hitMine) triggerShake();
	}
	if (safeRevealed > 0) sound.cascade(safeRevealed);
	if (hitMine) sound.mine();
	if (newlyFlagged > 0) sound.flag();
	if (newlyUnflagged > 0) sound.unflag();
	// Drive the music's adaptive intensity: any player action counts as
	// a pulse, with cascade reveals scaled by how many cells opened.
	if (typeof music !== "undefined") {
		var pulses = (safeRevealed > 0 ? Math.min(safeRevealed, 4) : 0)
			+ (newlyFlagged > 0 ? 1 : 0)
			+ (newlyUnflagged > 0 ? 1 : 0);
		for (var pi = 0; pi < pulses; pi++) music.pulse();
	}
	startAnimLoop();
}

function startAnimLoop() {
	if (animRAF) return;
	var step = function() {
		var now = performance.now();
		var alive = false;
		for (var key in cellAnims) {
			var a = cellAnims[key];
			var dur = a.type === "flag" ? FLAG_DUR : a.type === "mine" ? MINE_DUR : REVEAL_DUR;
			if (now >= a.start + dur) { delete cellAnims[key]; }
			else { alive = true; }
		}
		if (typeof territoryBeamsActive === "function" && territoryBeamsActive(now)) alive = true; // keep drawing beam streaks
		if (typeof territoryInfraAnimating === "function" && territoryInfraAnimating()) alive = true; // animate extractor/line construction
		if (countdownGlyphs.length || Object.keys(countdownCells).length) alive = true; // keep fading the countdown digit(s)
		if (boardGoAnim) alive = true; // keep sweeping the "go" animation
		if (boardIdleActive) alive = true; // keep looping the idle animation
		if (opponentRevealTargets && paintOpponentRevealFrame()) alive = true; // ripple the opponents' opening reveal
		renderPlayerBoard();
		if (alive) { animRAF = requestAnimationFrame(step); }
		else { animRAF = null; }
	};
	animRAF = requestAnimationFrame(step);
}

function triggerShake() {
	var wrap = playerCanvas.parentNode;
	if (!wrap) return;
	wrap.classList.remove("shake");
	void wrap.offsetWidth; // reflow so the animation can replay
	wrap.classList.add("shake");
}
