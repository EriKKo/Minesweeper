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
// See startCountdownGlyph (called from countDownStep in Overlay.js).
var COUNTDOWN_GLYPHS = {
	"3": ["111", "001", "111", "001", "111"],
	"2": ["111", "001", "111", "100", "111"],
	"1": ["010", "110", "010", "010", "111"]
};
// Tunable knobs, shared by real gameplay and the /admin/countdown lab (CountdownLab.js) — the lab's
// sliders mutate this object directly, so what it previews is the exact code path a real round
// uses, not a copy of it. fadeInMs/holdMs/fadeOutMs/gapMs together set the length of one digit's
// tick — the interval between one digit STARTING and the next one starting (see countDownStep in
// Overlay.js, which reads this instead of a fixed 1000ms): fade in, hold, fade out, then gapMs of
// plain blue before the next digit starts fading in. gapMs can go NEGATIVE — the next digit then
// starts (and begins fading in) before the previous one has finished fading out, so both are
// visible and crossfading at once; see countdownGlyphs below. brightness/indent: read by
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
// negative, an overlap into the next digit's own fade-in) before the next digit starts. Shared by
// countDownStep (Overlay.js, real gameplay) and countdownLabStep (CountdownLab.js, the looping
// preview) so the two can't drift apart on how this is computed. Floored well above 0 regardless of
// how negative gapMs goes, so it can't schedule the next tick immediately (or in the past) and spawn
// glyphs faster than they can ever finish painting.
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
		});
		bv.draw();
	} else {
		var ctx = playerCanvas.getContext("2d");
		ctx.clearRect(0, 0, playerCanvas.width, playerCanvas.height);
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
	if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; }
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
