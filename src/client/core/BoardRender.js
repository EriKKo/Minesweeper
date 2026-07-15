// Canvas-based board rendering. Every interactive board surface on the site —
// the live game's playerCanvas, the opponent thumbnails, the bot-demo board, the
// Learn demos/puzzles, and the pattern / starting-position admin cards — builds a
// BoardView (below) bound to its canvas and calls draw(); the cell loop and the
// drawCell primitive live here, so no surface re-implements them.
//
// Loaded via a plain <script> tag before the main inline script. Everything
// declared here becomes a global the main script can reach.

// ---- palette / board skins -------------------------------------------
// The draw helpers below read these module-scoped vars live, so swapping a skin
// is just reassigning them (applyBoardSkin) — no re-plumbing of the renderer.
// Skins are the foundation for texture packs; the frame/chrome half lives in CSS
// keyed off `body[data-board-skin]`.
var COLOR_MINE, NUMBER_COLORS, COLOR_KNOWN_BG, COLOR_KNOWN_EDGE,
	COLOR_UNKNOWN_TOP, COLOR_UNKNOWN_BOTTOM, COLOR_UNKNOWN_EDGE, COLOR_UNKNOWN_HILITE,
	COLOR_FLAG_CLOTH, COLOR_FLAG_POLE, NUMBER_FONT, NUMBER_GLOW;

var BOARD_SKINS = {
	classic: {
		label: "Classic", blurb: "The default blue tiles.",
		mine: "#fca5a5",
		numbers: { 1: "#60a5fa", 2: "#4ade80", 3: "#f87171", 4: "#c084fc", 5: "#fbbf24", 6: "#22d3ee", 7: "#f9a8d4", 8: "#e2e8f0" },
		knownBg: "#162033", knownEdge: "#0b1220",
		unknownTop: "#4f93f7", unknownBottom: "#2563eb", unknownEdge: "#1e40af",
		unknownHilite: "rgba(255,255,255,0.28)",
		flagCloth: "#ef4444", flagPole: "#e2e8f0",
		font: "Inter, system-ui, sans-serif", glow: false
	},
	tactical: {
		label: "Tactical", blurb: "Phosphor-CRT display with glowing digits.",
		mine: "#ff4d4d",
		numbers: { 1: "#00e8c8", 2: "#39ff14", 3: "#ff4d4d", 4: "#c084fc", 5: "#fb923c", 6: "#22d3ee", 7: "#80fff4", 8: "#eeeef5" },
		knownBg: "#020c0f", knownEdge: "#0a2a30",
		unknownTop: "#0a3a42", unknownBottom: "#062830", unknownEdge: "#00614f",
		unknownHilite: "rgba(0,232,200,0.20)",
		flagCloth: "#ff4d4d", flagPole: "#80fff4",
		font: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", glow: true
	}
};
var BOARD_SKIN_LIST = ["classic", "tactical"];
// Avatar cloth colour — the in-game flag. Just the classic red flag now (the other colours were dropped).
var AVATAR_COLORS = ["#ef4444"];
var DEFAULT_AVATAR_COLOR = "#ef4444";
// The default avatar shown anywhere a player hasn't chosen one — the anonymous silhouette.
var DEFAULT_AVATAR = "anon";
// Preset image avatars — an avatar value of "img:<id>" renders the image instead of a flag pennant.
var AVATAR_IMAGES = { teddy: "/avatars/mine-teddy.png", "recon-fox": "/avatars/recon-fox.png", "eod-bulldog": "/avatars/eod-bulldog.png", "night-cat": "/avatars/night-cat.png", "commando-cat": "/avatars/commando-cat.png", "comms-cat": "/avatars/comms-cat.png", "mine-dog": "/avatars/mine-dog.png", "drone-fox": "/avatars/drone-fox.png", "demo-raccoon": "/avatars/demo-raccoon.png", "rookie-penguin": "/avatars/rookie-penguin.png", "field-corgi": "/avatars/field-corgi.png", "journal-cat": "/avatars/journal-cat.png", "recon-owl": "/avatars/recon-owl.png", "scout-dog": "/avatars/scout-dog.png", "sentry-fox": "/avatars/sentry-fox.png", "sentry-owl": "/avatars/sentry-owl.png", "signal-cat": "/avatars/signal-cat.png", "guard-teddy": "/avatars/guard-teddy.png" };
// localBoardSkin = the skin the *local* user picked (their own board + UI previews).
// Other players' boards render in THEIR skin (passed per-BoardView); bots/unknown fall
// back to classic. Each BoardView.draw() loads its skin's palette into these vars for the
// duration of the paint, then restores localBoardSkin — so the draw helpers stay simple.
var localBoardSkin = "classic";

// Load a skin's colours into the module palette vars the draw helpers read.
function setPaletteVars(id) {
	var s = BOARD_SKINS[id] || BOARD_SKINS.classic;
	COLOR_MINE = s.mine;
	NUMBER_COLORS = s.numbers;
	COLOR_KNOWN_BG = s.knownBg; COLOR_KNOWN_EDGE = s.knownEdge;
	COLOR_UNKNOWN_TOP = s.unknownTop; COLOR_UNKNOWN_BOTTOM = s.unknownBottom; COLOR_UNKNOWN_EDGE = s.unknownEdge;
	COLOR_UNKNOWN_HILITE = s.unknownHilite;
	COLOR_FLAG_CLOTH = s.flagCloth; COLOR_FLAG_POLE = s.flagPole;
	NUMBER_FONT = s.font; NUMBER_GLOW = s.glow;
}

// Set the LOCAL user's skin: drives their own board, the CSS frame (body[data-board-skin]),
// and the resting palette. Other boards override per-draw.
function applyBoardSkin(id) {
	if (!BOARD_SKINS[id]) id = "classic";
	localBoardSkin = id;
	setPaletteVars(id);
	if (document.body) document.body.setAttribute("data-board-skin", id);
}

// User picked a skin in the Profile picker: persist, apply, tell the server (so opponents
// see it), repaint the live board, and refresh the picker's active state.
function setBoardSkin(id) {
	applyBoardSkin(id);
	try { localStorage.setItem("ms_board_skin", localBoardSkin); } catch (e) {}
	if (typeof socket !== "undefined" && socket) socket.emit("set_skin", { skin: localBoardSkin });
	if (typeof myState !== "undefined" && myState && typeof redrawOwnBoardWithFocus === "function") redrawOwnBoardWithFocus();
	if (typeof renderBoardSkins === "function") renderBoardSkins();
}

applyBoardSkin((function () { try { return localStorage.getItem("ms_board_skin"); } catch (e) { return null; } })() || "classic");

// Device pixel ratio — every canvas on the site renders at this multiple so
// it's crisp on HiDPI displays. Used by sizeBoardCanvas/sizePlayerCanvas in
// the live game and the Learn page's canvas factory. Capped at 2: beyond that
// a flat-colour board with modest text gains nothing visible, but the pixel
// count (and so the cost of every fill/gradient/shadow, repeated per cell,
// every animated frame, across up to 6 boards at once in a 6-player match)
// keeps scaling with the square of the ratio — a real, needless cost on the
// 3x-4x displays some phones/tablets report, and on any HiDPI display paired
// with modest graphics hardware.
var DPR = Math.min(2, window.devicePixelRatio || 1);

// ---- animation timing -------------------------------------------------
var REVEAL_DUR = 230;
var FLAG_DUR = 260;
var MINE_DUR = 460;
var STAGGER_MS = 13;     // per unit of distance from the reveal origin
var STAGGER_CAP = 340;   // max ripple delay so big floods stay snappy

// ---- easing + geometry helpers ----------------------------------------
function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t) { return t * t * t; }
function easeOutBack(t) {
	var c1 = 1.70158, c3 = c1 + 1;
	return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function roundRectPath(ctx, x, y, w, h, r) {
	r = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

// ---- BoardView: a board bound to a canvas, that renders itself ----------
// One object both *represents* a board (the cell-state accessors drawCell reads)
// and *renders* it: draw() clears the canvas and paints every cell, so no caller
// loops cells itself. There is one canonical board encoding — `state` uses the
// BoardLogic sentinels (UNKNOWN/KNOWN/FLAGGED) and `cellAt(r, c)` returns MINE or
// a clue value — used everywhere from the live game to the admin cards (it
// replaced the old makeGridView/makeBoardView split).
//
// Callers shape the picture without touching the loop:
//   .overlay(fn) / .underlay(fn)  — fn(ctx, sw, sh) run after / before the cells
//   .markSafe(cells)              — green "proved safe" check on covered cells
//   .animAt = fn(r, c)            — per-cell reveal/flag/mine animation (live game)
//   .includeCell = fn(r, c)       — limit which cells are painted (pattern footprint)
//   .getOwner/.hideClue/.structureCharge/.structureBuild — territory-only accessors
// The sentinels/MINE are page globals assigned after the scripts load, so they're
// only read inside these methods (at call time), never at module-eval time.
function BoardView(canvas, rows, cols, state, cellAt, opts) {
	opts = opts || {};
	this.canvas = canvas;
	this.rows = rows;
	this.cols = cols;
	this._state = state;
	this._cellAt = cellAt;
	this.xray = !!opts.xray;
	this.animAt = opts.animAt || null;
	this.includeCell = opts.includeCell || null;
	this.getOwner = opts.getOwner || null;
	this.hideClue = opts.hideClue || null;
	this.structureCharge = opts.structureCharge || null;
	this.structureBuild = opts.structureBuild || null;
	// Which skin to paint this board in (null → the local user's skin). Opponent boards
	// pass the owner's skin so each player renders in their own theme.
	this.skinId = opts.skin || null;
	this._underlays = [];
	this._overlays = [];
}
// Cell-state interface drawCell consumes.
BoardView.prototype.isCovered  = function(r, c) { return this._state[r][c] === UNKNOWN; };
BoardView.prototype.isRevealed = function(r, c) { return this._state[r][c] === KNOWN; };
BoardView.prototype.isFlagged  = function(r, c) { return this._state[r][c] === FLAGGED; };
BoardView.prototype.isMine     = function(r, c) { return this._cellAt(r, c) === MINE; };
BoardView.prototype.getClue    = function(r, c) { var v = this._cellAt(r, c); return v > 0 ? v : 0; };
// Influence the picture (each returns this, so calls chain).
BoardView.prototype.underlay = function(fn) { this._underlays.push(fn); return this; };
BoardView.prototype.overlay  = function(fn) { this._overlays.push(fn); return this; };
BoardView.prototype.markSafe = function(cells) {
	return this.overlay(function(ctx, sw, sh) {
		for (var i = 0; i < cells.length; i++) drawSafeMarker(ctx, cells[i][1] * sw, cells[i][0] * sh, sw, sh);
	});
};
// dirtyCells: optional [[r,c], ...] — when given, skips the full clear + full board loop and
// only clears/repaints those specific cells, leaving every other cell's already-painted pixels
// untouched (the underlay pass is skipped too, since an underlay typically washes the whole
// canvas and can't be safely composited over stale pixels). This is the fast path the live
// game's own board uses every animation frame (see renderPlayerBoard in Animations.js) — most of
// a board is static from one frame to the next (already-revealed clues, untouched covered
// cells), so repainting only the handful of cells that actually changed avoids redoing a
// fill+roundRectPath (plus, for covered cells, a fresh gradient) on every cell, every frame.
// Every other caller (Learn, admin lab boards, opponent thumbnails, one-off live-game repaints
// like a mouse press or a fresh draw_board) calls draw() with no argument and keeps getting the
// exact same full repaint as before — this is strictly additive.
BoardView.prototype.draw = function(dirtyCells) {
	var ctx = this.canvas.getContext("2d");
	var sw = this.canvas.width / this.cols, sh = this.canvas.height / this.rows;
	// Paint this board in its own skin, then restore the local user's skin. Rendering is
	// synchronous so the swap can't interleave with another board's draw.
	setPaletteVars(this.skinId || localBoardSkin);
	var i, r, c;
	if (dirtyCells) {
		for (i = 0; i < dirtyCells.length; i++) {
			r = dirtyCells[i][0]; c = dirtyCells[i][1];
			if (r < 0 || r >= this.rows || c < 0 || c >= this.cols) continue;
			if (this.includeCell && !this.includeCell(r, c)) continue;
			ctx.clearRect(c * sw, r * sh, sw, sh);
			drawCell(ctx, r, c, this, sw, sh, this.animAt ? this.animAt(r, c) : null);
		}
	} else {
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		for (i = 0; i < this._underlays.length; i++) this._underlays[i](ctx, sw, sh);
		for (r = 0; r < this.rows; r++) {
			for (c = 0; c < this.cols; c++) {
				if (this.includeCell && !this.includeCell(r, c)) continue;
				drawCell(ctx, r, c, this, sw, sh, this.animAt ? this.animAt(r, c) : null);
			}
		}
	}
	for (i = 0; i < this._overlays.length; i++) this._overlays[i](ctx, sw, sh);
	setPaletteVars(localBoardSkin);
};

// Create a DPR-scaled canvas sized to a cols×rows grid of `cellPx` logical px.
// Shared by the Learn / pattern / starting-position canvas factories.
function buildCellCanvas(cols, rows, cellPx, className) {
	var canvas = document.createElement("canvas");
	if (className) canvas.className = className;
	canvas.width = Math.round(cols * cellPx * DPR);
	canvas.height = Math.round(rows * cellPx * DPR);
	canvas.style.width = (cols * cellPx) + "px";
	canvas.style.height = (rows * cellPx) + "px";
	return canvas;
}

// Small green checkmark overlay marking a covered cell the solver proved safe.
// Used by the pattern and starting-position admin cards (it lives here, with the
// other cell-drawing primitives, rather than in one view file the others reach into).
function drawSafeMarker(ctx, x, y, sw, sh) {
	var cx = x + sw / 2, cy = y + sh / 2;
	var s = Math.min(sw, sh) * 0.28;
	ctx.save();
	ctx.strokeStyle = "#4ade80";
	ctx.lineWidth = Math.max(2, s * 0.35);
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	ctx.moveTo(cx - s, cy + s * 0.05);
	ctx.lineTo(cx - s * 0.25, cy + s * 0.65);
	ctx.lineTo(cx + s, cy - s * 0.55);
	ctx.stroke();
	ctx.restore();
}

// ---- one cell ---------------------------------------------------------
// drawCell paints a single cell into the canvas at logical position (r, c).
// `view` is the BoardView interface — isCovered/isRevealed/isFlagged/isMine/
// getClue/xray — so the same draw code works for the live game and Learn.
function drawCell(ctx, r, c, view, sw, sh, anim) {
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	ctx.save();
	ctx.translate(c * sw + gap / 2, r * sh + gap / 2);

	// In x-ray mode every mine (covered OR revealed) gets the same friendly
	// "this is where the bomb is" look: blue covered background with the
	// favicon-style icon on top — unless the cell is flagged, in which case
	// the flag wins.
	if (view.xray && view.isMine(r, c) && !view.isFlagged(r, c)) {
		drawUnknown(ctx, w, h, rad);
		drawMineXray(ctx, w, h);
	} else if (view.isRevealed(r, c)) {
		var revealing = anim && (anim.type === "reveal" || anim.type === "mine");
		var t = revealing ? clamp01(anim.t) : 1;
		drawKnownBase(ctx, w, h, rad);
		// Territory mode: subtle per-owner tint behind the clue. getOwner returns a colour
		// string for claimed cells and null otherwise, so other modes are unaffected.
		var ownerColor = view.getOwner && view.getOwner(r, c);
		if (ownerColor) {
			ctx.save();
			ctx.globalAlpha = 0.20 * (revealing ? easeOutCubic(t) : 1);
			ctx.fillStyle = ownerColor;
			roundRectPath(ctx, 0, 0, w, h, rad);
			ctx.fill();
			ctx.restore();
		}
		if (view.isMine(r, c)) {
			if (anim && anim.type === "mine") {
				// red danger flash that fades as the bomb settles in
				ctx.globalAlpha = (1 - easeOutCubic(t)) * 0.85;
				ctx.fillStyle = "#dc2626";
				roundRectPath(ctx, 0, 0, w, h, rad);
				ctx.fill();
				ctx.globalAlpha = 1;
			}
			drawMine(ctx, w, h, t);
		} else {
			var clue = view.getClue(r, c);
			// hideClue (territory fog-of-clues): a revealed cell you don't own shows its tint but no number.
			if (clue > 0 && !(view.hideClue && view.hideClue(r, c))) drawNumber(ctx, clue, w, h, t);
		}
		// the unknown "cover" lifts off as the reveal plays
		if (revealing && anim.t < 1) {
			ctx.globalAlpha = 1 - easeOutCubic(t);
			drawUnknown(ctx, w, h, rad);
			ctx.globalAlpha = 1;
		}
	} else if (view.isFlagged(r, c)) {
		drawUnknown(ctx, w, h, rad);
		// Territory structure: a flagged cell with an owner colour is a fort (a surrounded mine). Tint it
		// in the owner colour, fly the flag in that colour, and show a charge gauge. A plain (ownerless)
		// flag is a manual suspected-mine mark — the usual red flag.
		var flagOwner = view.getOwner && view.getOwner(r, c);
		if (flagOwner) {
			ctx.save();
			ctx.globalAlpha = 0.30;
			ctx.fillStyle = flagOwner;
			roundRectPath(ctx, 0, 0, w, h, rad);
			ctx.fill();
			ctx.restore();
		}
		var fs = anim && anim.type === "flag" ? easeOutBack(clamp01(anim.t)) : 1;
		// An extractor under construction flies its flag dimmed and shows a build ring; once built it gets a
		// glowing energy core plus its beam-charge gauge.
		var bf = (flagOwner && view.structureBuild) ? view.structureBuild(r, c) : 1;
		if (flagOwner && bf < 1) ctx.globalAlpha = 0.55;
		drawFlag(ctx, w, h, fs, flagOwner || null);
		ctx.globalAlpha = 1;
		if (flagOwner) {
			if (bf < 1) {
				drawExtractorBuild(ctx, w, h, bf, flagOwner);
			} else {
				drawExtractorCore(ctx, w, h, flagOwner);
				if (view.structureCharge) drawStructureCharge(ctx, w, h, view.structureCharge(r, c), flagOwner);
			}
		}
	} else if (anim && anim.type === "unreveal") {
		// Reverse cascade (territory explosion): the clue fades out as the cover drops back in.
		var ut = clamp01(anim.t);
		drawKnownBase(ctx, w, h, rad);
		var uclue = view.getClue(r, c);
		// Don't fade a number out for a cell whose clue is hidden (e.g. an opponent's cell re-covered by
		// their own explosion) — that would briefly leak their clue.
		if (uclue > 0 && !(view.hideClue && view.hideClue(r, c))) { ctx.globalAlpha = 1 - easeOutCubic(ut); drawNumber(ctx, uclue, w, h, 1); ctx.globalAlpha = 1; }
		ctx.globalAlpha = easeOutCubic(ut);
		drawUnknown(ctx, w, h, rad);
		ctx.globalAlpha = 1;
	} else {
		drawUnknown(ctx, w, h, rad);
	}
	ctx.restore();
}

function drawUnknown(ctx, w, h, rad) {
	var g = ctx.createLinearGradient(0, 0, 0, h);
	g.addColorStop(0, COLOR_UNKNOWN_TOP);
	g.addColorStop(1, COLOR_UNKNOWN_BOTTOM);
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = g;
	ctx.fill();
	// raised top highlight
	ctx.strokeStyle = COLOR_UNKNOWN_HILITE;
	ctx.lineWidth = Math.max(1, h * 0.06);
	ctx.beginPath();
	ctx.moveTo(rad, ctx.lineWidth / 2);
	ctx.lineTo(w - rad, ctx.lineWidth / 2);
	ctx.stroke();
	// darker bottom edge
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.strokeStyle = COLOR_UNKNOWN_EDGE;
	ctx.lineWidth = 1;
	ctx.stroke();
}

function drawKnownBase(ctx, w, h, rad) {
	roundRectPath(ctx, 0, 0, w, h, rad);
	ctx.fillStyle = COLOR_KNOWN_BG;
	ctx.fill();
	ctx.strokeStyle = COLOR_KNOWN_EDGE;
	ctx.lineWidth = 1;
	ctx.stroke();
}

function drawNumber(ctx, n, w, h, t) {
	ctx.save();
	ctx.globalAlpha = clamp01(t);
	var scale = 0.7 + 0.3 * easeOutBack(clamp01(t));
	ctx.translate(w / 2, h / 2 + 1);
	ctx.scale(scale, scale);
	var col = NUMBER_COLORS[n] || "#e2e8f0";
	ctx.fillStyle = col;
	// Phosphor skins glow each digit in its own colour.
	if (NUMBER_GLOW) { ctx.shadowColor = col; ctx.shadowBlur = Math.max(2, h * 0.4); }
	ctx.font = "bold " + Math.floor(0.72 * h) + "px " + NUMBER_FONT;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(String(n), 0, 0);
	ctx.restore();
}

function drawMine(ctx, w, h, t) {
	ctx.save();
	ctx.globalAlpha = clamp01(t);
	var scale = 0.6 + 0.4 * easeOutBack(clamp01(t));
	ctx.translate(w / 2, h / 2);
	ctx.scale(scale, scale);
	var rad = Math.min(w, h) * 0.26;
	// spikes — 8 short tips around the body, in the pink "exploded" look
	ctx.strokeStyle = COLOR_MINE;
	ctx.lineWidth = Math.max(1, rad * 0.22);
	ctx.lineCap = "round";
	for (var i = 0; i < 8; i++) {
		var a = i * Math.PI / 4;
		ctx.beginPath();
		ctx.moveTo(Math.cos(a) * rad * 0.7, Math.sin(a) * rad * 0.7);
		ctx.lineTo(Math.cos(a) * rad * 1.5, Math.sin(a) * rad * 1.5);
		ctx.stroke();
	}
	// body
	ctx.beginPath();
	ctx.arc(0, 0, rad, 0, Math.PI * 2);
	ctx.fillStyle = COLOR_MINE;
	ctx.fill();
	// shine
	ctx.beginPath();
	ctx.arc(-rad * 0.3, -rad * 0.3, rad * 0.3, 0, Math.PI * 2);
	ctx.fillStyle = "rgba(255,255,255,0.7)";
	ctx.fill();
	ctx.restore();
}

// drawMineXray: near-black body + four full spike lines + white shine, drawn
// on top of a still-covered cell. Used by Learn demos to show "this is where
// the mine is" without exploding it.
function drawMineXray(ctx, w, h) {
	ctx.save();
	ctx.translate(w / 2, h / 2);
	var rad = Math.min(w, h) * 0.2;
	ctx.strokeStyle = "#0f172a";
	ctx.lineWidth = Math.max(1, rad * 0.32);
	ctx.lineCap = "round";
	// 4 full diameter spike lines (vertical, horizontal, two diagonals)
	var len = rad * 1.8;
	var lines = [[0, -len, 0, len], [-len, 0, len, 0], [-len * 0.8, -len * 0.8, len * 0.8, len * 0.8], [len * 0.8, -len * 0.8, -len * 0.8, len * 0.8]];
	for (var i = 0; i < lines.length; i++) {
		ctx.beginPath();
		ctx.moveTo(lines[i][0], lines[i][1]);
		ctx.lineTo(lines[i][2], lines[i][3]);
		ctx.stroke();
	}
	ctx.beginPath();
	ctx.arc(0, 0, rad, 0, Math.PI * 2);
	ctx.fillStyle = "#0f172a";
	ctx.fill();
	ctx.beginPath();
	ctx.arc(-rad * 0.35, -rad * 0.35, rad * 0.28, 0, Math.PI * 2);
	ctx.fillStyle = "rgba(255,255,255,0.85)";
	ctx.fill();
	ctx.restore();
}

function drawFlag(ctx, w, h, scale, clothColor) {
	ctx.save();
	ctx.translate(w / 2, h / 2);
	ctx.scale(scale, scale);
	var ph = h * 0.5;          // pole height
	var px = -w * 0.12;        // pole x
	// pole
	ctx.strokeStyle = COLOR_FLAG_POLE;
	ctx.lineWidth = Math.max(1, w * 0.07);
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.moveTo(px, -ph / 2);
	ctx.lineTo(px, ph / 2);
	ctx.stroke();
	// base
	ctx.beginPath();
	ctx.moveTo(px - w * 0.16, ph / 2);
	ctx.lineTo(px + w * 0.16, ph / 2);
	ctx.stroke();
	// cloth
	ctx.beginPath();
	ctx.moveTo(px, -ph / 2);
	ctx.lineTo(px + w * 0.34, -ph * 0.28);
	ctx.lineTo(px, -ph * 0.06);
	ctx.closePath();
	ctx.fillStyle = clothColor || COLOR_FLAG_CLOTH;
	ctx.fill();
	ctx.restore();
}

// --- Avatars -------------------------------------------------------------------------------------
// The avatar is the in-game flag on a pole. With a country, the "cloth" is the player's round country
// flag (the /flags SVGs are circular icons), drawn large so it's recognisable; without one it falls back
// to a coloured pennant in `avatar_color`. Rendered to a canvas so the pole/tile match the board art.
// The country flag loads async — we paint a placeholder, then repaint when the image arrives.
function buildAvatarCanvas(color, px, country) {
	px = px || 28;
	var dpr = window.devicePixelRatio || 1;
	var c = document.createElement("canvas");
	c.className = "avatar-canvas";
	c.width = Math.round(px * dpr); c.height = Math.round(px * dpr);
	c.style.width = px + "px"; c.style.height = px + "px";
	var ctx = c.getContext("2d");
	ctx.scale(dpr, dpr);

	function tileBg() {
		ctx.clearRect(0, 0, px, px);
		roundRectPath(ctx, 0.5, 0.5, px - 1, px - 1, px * 0.28);
		ctx.fillStyle = "#1a2240"; ctx.fill();
		ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1; ctx.stroke();
	}

	// Anonymous avatar ("anon") — a generic head-and-shoulders silhouette (the default for guests).
	if (color === "anon") {
		tileBg();
		ctx.save();
		roundRectPath(ctx, 0.5, 0.5, px - 1, px - 1, px * 0.28); ctx.clip();
		ctx.fillStyle = "#aab3d0";
		ctx.beginPath(); ctx.arc(px * 0.5, px * 1.04, px * 0.37, 0, Math.PI * 2); ctx.fill(); // shoulders
		ctx.beginPath(); ctx.arc(px * 0.5, px * 0.37, px * 0.17, 0, Math.PI * 2); ctx.fill(); // head
		ctx.restore();
		return c;
	}

	// Mine avatar ("mine") — the game's iconic spiky sea-mine, centred on the tile.
	if (color === "mine") {
		tileBg();
		ctx.save();
		var mcx = px * 0.5, mcy = px * 0.5, mrad = px * 0.28;
		// 8 spikes, set between the diagonals so they don't hide behind the shine
		ctx.strokeStyle = "#475569";
		ctx.lineWidth = Math.max(1.2, mrad * 0.34);
		ctx.lineCap = "round";
		for (var mi = 0; mi < 8; mi++) {
			var ma = mi * Math.PI / 4 + Math.PI / 8;
			ctx.beginPath();
			ctx.moveTo(mcx + Math.cos(ma) * mrad * 0.85, mcy + Math.sin(ma) * mrad * 0.85);
			ctx.lineTo(mcx + Math.cos(ma) * mrad * 1.52, mcy + Math.sin(ma) * mrad * 1.52);
			ctx.stroke();
		}
		// body — a slight top-to-bottom gradient so it reads as a sphere
		var mg = ctx.createLinearGradient(0, mcy - mrad, 0, mcy + mrad);
		mg.addColorStop(0, "#33425e"); mg.addColorStop(1, "#0b1220");
		ctx.beginPath(); ctx.arc(mcx, mcy, mrad, 0, Math.PI * 2);
		ctx.fillStyle = mg; ctx.fill();
		// rim light so the dark body separates from the dark tile
		ctx.lineWidth = Math.max(1, px * 0.02);
		ctx.strokeStyle = "rgba(148,163,184,0.45)"; ctx.stroke();
		// specular shine
		ctx.beginPath(); ctx.arc(mcx - mrad * 0.32, mcy - mrad * 0.34, mrad * 0.26, 0, Math.PI * 2);
		ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.fill();
		ctx.restore();
		return c;
	}

	// Image avatar ("img:<id>") — render the preset image contained in the rounded tile, ignoring the flag.
	var imgId = (typeof color === "string" && color.indexOf("img:") === 0) ? color.slice(4) : null;
	if (imgId && AVATAR_IMAGES[imgId]) {
		tileBg();
		var aim = new Image();
		aim.onload = function() {
			tileBg();
			ctx.save();
			roundRectPath(ctx, 0.5, 0.5, px - 1, px - 1, px * 0.28); ctx.clip();
			var pad = px * 0.02; // minimal inset so image avatars (e.g. the teddy) fill the tile
			var s = Math.min((px - pad * 2) / (aim.naturalWidth || 1), (px - pad * 2) / (aim.naturalHeight || 1));
			var w = (aim.naturalWidth || px) * s, h = (aim.naturalHeight || px) * s;
			ctx.drawImage(aim, (px - w) / 2, (px - h) / 2, w, h);
			ctx.restore();
		};
		aim.src = AVATAR_IMAGES[imgId];
		return c;
	}

	var poleX = px * 0.24, poleTop = px * 0.12, poleBot = px * 0.88;
	// Pennant triangle (the minesweeper flag), offset right of the pole so more of the stick shows.
	var clothLeft = poleX + px * 0.05;
	var Ax = clothLeft, Ay = px * 0.12;
	var Bx = clothLeft + px * 0.56, By = px * 0.35;
	var Cx = clothLeft, Cy = px * 0.58;
	// Centroid + max vertex distance: the country flag (a circular icon) is scaled to a square big enough
	// that its disc covers the whole triangle, so no transparent corners show — the triangle just crops it.
	var Gx = (Ax + Bx + Cx) / 3, Gy = (Ay + By + Cy) / 3;
	var Rmax = Math.max(Math.hypot(Ax - Gx, Ay - Gy), Math.hypot(Bx - Gx, By - Gy), Math.hypot(Cx - Gx, Cy - Gy));
	var side = Rmax * 2 * 1.06;

	function tri() { ctx.beginPath(); ctx.moveTo(Ax, Ay); ctx.lineTo(Bx, By); ctx.lineTo(Cx, Cy); ctx.closePath(); }
	function base() {
		ctx.clearRect(0, 0, px, px);
		roundRectPath(ctx, 0.5, 0.5, px - 1, px - 1, px * 0.28);
		ctx.fillStyle = "#1a2240"; ctx.fill();
		ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1; ctx.stroke();
		ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = Math.max(1, px * 0.045); ctx.lineCap = "round";
		ctx.beginPath(); ctx.moveTo(poleX, poleTop); ctx.lineTo(poleX, poleBot); ctx.stroke();           // pole
		ctx.beginPath(); ctx.moveTo(poleX - px * 0.07, poleBot); ctx.lineTo(poleX + px * 0.07, poleBot); ctx.stroke(); // base
	}
	function drawCountry(img) {
		base();
		ctx.save(); tri(); ctx.clip();
		ctx.drawImage(img, Gx - side / 2, Gy - side / 2, side, side); // flag scaled to cover the triangle (corners cropped)
		ctx.restore();
		tri(); ctx.strokeStyle = "rgba(0,0,0,0.30)"; ctx.lineWidth = Math.max(1, px * 0.025); ctx.stroke();
	}
	function drawPennant() { base(); tri(); ctx.fillStyle = color || DEFAULT_AVATAR_COLOR; ctx.fill(); }
	function drawPlaceholder() {
		base(); tri();
		ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fill();
		ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1; ctx.stroke();
	}

	if (country && typeof countryFlagSrc === "function") {
		drawPlaceholder();
		var im = new Image();
		im.onload = function() { drawCountry(im); };
		im.src = countryFlagSrc(country);
	} else {
		drawPennant();
	}
	return c;
}

// A reusable identity element: the flag avatar (country flag inside it, or coloured pennant). Used on the
// profile, leaderboard, home card, match panels, and replays.
function buildAvatarChip(color, country, px) {
	var wrap = document.createElement("span");
	wrap.className = "avatar-chip";
	wrap.title = (country && typeof countryName === "function") ? countryName(country) : "";
	wrap.appendChild(buildAvatarCanvas(color, px || 28, country));
	return wrap;
}

// Territory structure charge gauge: a thin bar across the bottom of the cell, filling 0..1 in the owner
// colour. At full charge it's bright/solid (ready to fire); while charging it's dim.
function drawStructureCharge(ctx, w, h, frac, color) {
	frac = clamp01(frac == null ? 1 : frac);
	var pad = w * 0.14, bw = w - pad * 2, bh = Math.max(1.5, h * 0.09), by = h - bh - h * 0.1;
	ctx.save();
	ctx.globalAlpha = 0.35;
	ctx.fillStyle = "#0b1220";
	roundRectPath(ctx, pad, by, bw, bh, bh / 2);
	ctx.fill();
	ctx.globalAlpha = frac >= 1 ? 1 : 0.7;
	ctx.fillStyle = color;
	roundRectPath(ctx, pad, by, Math.max(bh, bw * frac), bh, bh / 2);
	ctx.fill();
	ctx.restore();
}

// Energy extractor under construction: a faint full ring with a colored arc sweeping to show progress.
function drawExtractorBuild(ctx, w, h, frac, color) {
	frac = clamp01(frac);
	var cx = w / 2, cy = h / 2, rad = Math.min(w, h) * 0.26, lw = Math.max(1.5, Math.min(w, h) * 0.08);
	ctx.save();
	ctx.lineWidth = lw;
	ctx.globalAlpha = 0.25; ctx.strokeStyle = color;
	ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
	ctx.globalAlpha = 0.95; ctx.strokeStyle = color; ctx.lineCap = "round";
	ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
	ctx.restore();
}

// Operational extractor: a glowing energy core dot in the owner colour.
function drawExtractorCore(ctx, w, h, color) {
	var cx = w / 2, cy = h / 2, rad = Math.min(w, h) * 0.17;
	ctx.save();
	ctx.shadowColor = color; ctx.shadowBlur = Math.min(w, h) * 0.5;
	ctx.fillStyle = color;
	ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
	ctx.shadowBlur = 0; ctx.globalAlpha = 0.85; ctx.fillStyle = "#fff";
	ctx.beginPath(); ctx.arc(cx, cy, rad * 0.45, 0, Math.PI * 2); ctx.fill();
	ctx.restore();
}

// ---- keyboard focus for boards that use real DOM focus -----------------------------------
// The live game's own board (Input.js) doesn't use this: it's a single always-on-screen board
// gated by currentActionMode(), and deliberately keeps working no matter what has DOM focus —
// requiring the canvas to be focused would be a regression there, not an improvement (losing
// focus, e.g. by clicking a HUD button mid-match, would stop keys from doing anything).
//
// This is for the opposite situation: any number of independent, genuinely-focusable board
// widgets that can coexist on a page (Learn puzzles, and anywhere else buildLearnPuzzle is used
// — a Help-modal preview can be open over a Learn puzzle, for instance, each with its own canvas
// and its own local cursor state). Exactly one is ever "the" keyboard target at a time, decided
// by real focus: a board calls focusBoard(controller) when its surface receives a focus event
// and blurBoard(controller) on blur; this file's one keydown listener maps the event through
// keybindings.actionFor and forwards it to whichever controller is currently registered, so the
// board-specific logic (how a cursor moves, what reveal/flag mean for that particular board)
// stays with the board, not duplicated into every caller's own keydown handler.
//
// controller shape: { moveCursor(dr, dc, skipRevealed), reveal(), flag(), jumpToNext(forward)? }
// jumpToNext is optional — a board that doesn't implement it (Learn's puzzles: see buildLearnPuzzle)
// simply doesn't bind "next" (default Tab), leaving Tab to move real DOM focus as normal instead
// of trapping the player on the board.
var focusedBoardController = null;

function focusBoard(controller) { focusedBoardController = controller; }
function blurBoard(controller) { if (focusedBoardController === controller) focusedBoardController = null; }

document.addEventListener("keydown", function(e) {
	var c = focusedBoardController;
	if (!c) return;
	var tag = (e.target && e.target.tagName) || "";
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	if (e.target && e.target.closest && e.target.closest(".kbd-btn-group")) return;
	if (e.ctrlKey || e.metaKey || e.altKey) return;
	var action = (typeof keybindings !== "undefined") ? keybindings.actionFor(e) : null;
	if (!action) return;
	if (action === "reveal") {
		e.preventDefault();
		if (e.repeat) return; // one press, one action — not a spam-while-held key
		c.reveal();
		return;
	}
	if (action === "flag") {
		e.preventDefault();
		if (e.repeat) return;
		c.flag();
		return;
	}
	if (action === "next") {
		if (!c.jumpToNext) return; // not supported by this controller — let Tab behave natively
		e.preventDefault();
		c.jumpToNext(!e.shiftKey);
		return;
	}
	var dr = action === "up" ? -1 : action === "down" ? 1 : 0;
	var dc = action === "left" ? -1 : action === "right" ? 1 : 0;
	if (!dr && !dc) return;
	e.preventDefault();
	c.moveCursor(dr, dc, e.shiftKey);
});
