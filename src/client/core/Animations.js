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
// Held at full strength before fading, so the digit reads clearly before it starts dissolving —
// the tick itself is ~1000ms (see countDownStep), so hold + fade leaves a short beat of plain
// blue before the next digit lands.
var COUNTDOWN_GLYPH_HOLD_MS = 500;
var COUNTDOWN_GLYPH_FADE_MS = 400;
var countdownGlyph = null; // { glyph, scale, start } | null

// scale maps each glyph "pixel" to an NxN patch of real cells so the digit reads at a consistent
// size whether the board is small (10 rows) or large (16 rows), rather than the glyph shrinking
// to a sliver of a big board or overflowing a small one.
function startCountdownGlyph(number) {
	var glyph = COUNTDOWN_GLYPHS[String(number)];
	if (!glyph || !rows || !cols) { countdownGlyph = null; return; }
	var scale = Math.max(1, Math.round(rows / 10));
	countdownGlyph = { glyph: glyph, scale: scale, start: performance.now() };
	startAnimLoop();
}

function drawCountdownGlyph(ctx, sw, sh) {
	if (!countdownGlyph || !myState) return;
	var elapsed = performance.now() - countdownGlyph.start;
	var alpha = elapsed < COUNTDOWN_GLYPH_HOLD_MS ? 1
		: Math.max(0, 1 - (elapsed - COUNTDOWN_GLYPH_HOLD_MS) / COUNTDOWN_GLYPH_FADE_MS);
	if (alpha <= 0) { countdownGlyph = null; return; }
	var glyph = countdownGlyph.glyph, scale = countdownGlyph.scale;
	var glyphRows = glyph.length * scale;
	var glyphCols = glyph[0].length * scale;
	var startRow = Math.floor((rows - glyphRows) / 2);
	var startCol = Math.floor((cols - glyphCols) / 2);
	// Same inset/rounding every normal cell uses (see drawCell in BoardRender.js) so a lit glyph
	// cell reads as a distinct cell being pressed, not a borderless dark blob.
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	// Only tint still-covered cells — a board can already show its pre-opened cascade during the
	// countdown (solo does; ranked stays fully covered until GO), and washing over an already-
	// revealed clue cell just muddies the number instead of reading as part of the digit.
	for (var gr = 0; gr < glyph.length; gr++) {
		for (var gc = 0; gc < glyph[gr].length; gc++) {
			if (glyph[gr].charAt(gc) !== "1") continue;
			for (var sr = 0; sr < scale; sr++) {
				for (var sc = 0; sc < scale; sc++) {
					var r = startRow + gr * scale + sr;
					var c = startCol + gc * scale + sc;
					if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
					if (myState[r][c] === KNOWN) continue;
					drawGlowGlyphCell(ctx, c * sw + gap / 2, r * sh + gap / 2, w, h, rad, alpha);
				}
			}
		}
	}
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
	var g = ctx.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, "rgba(10, 18, 38, 0.62)");
	g.addColorStop(1, "rgba(24, 36, 66, 0.34)");
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = g;
	ctx.fill();
	// shadow hugging the top inner edge — the recess's deepest point
	ctx.strokeStyle = "rgba(0, 0, 0, 0.38)";
	ctx.lineWidth = Math.max(1, h * 0.10);
	ctx.beginPath();
	ctx.moveTo(rad, ctx.lineWidth / 2);
	ctx.lineTo(w - rad, ctx.lineWidth / 2);
	ctx.stroke();
	// faint highlight catching the bottom inner lip
	ctx.strokeStyle = "rgba(148, 176, 255, 0.20)";
	ctx.lineWidth = Math.max(1, h * 0.06);
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
	ctx.shadowBlur = Math.max(6, w * 0.6);
	ctx.shadowColor = "rgba(191, 219, 254, 0.85)";
	var g = ctx.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, "rgba(235, 245, 255, 0.95)");
	g.addColorStop(1, "rgba(147, 197, 253, 0.80)");
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = g;
	ctx.fill();
	ctx.shadowBlur = 0;
	ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
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
		if (countdownGlyph) alive = true; // keep fading the countdown digit
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
