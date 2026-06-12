// Canvas-based board rendering. Every interactive board surface on the site —
// the live game's playerCanvas, the opponent thumbnails, the bot-demo board, the
// Learn demos/puzzles, and the pattern / starting-position admin cards — builds a
// BoardView (below) bound to its canvas and calls draw(); the cell loop and the
// drawCell primitive live here, so no surface re-implements them.
//
// Loaded via a plain <script> tag before the main inline script. Everything
// declared here becomes a global the main script can reach.

// ---- palette ----------------------------------------------------------
var COLOR_MINE = "#fca5a5";

var NUMBER_COLORS = {
	1: "#60a5fa", 2: "#4ade80", 3: "#f87171", 4: "#c084fc",
	5: "#fbbf24", 6: "#22d3ee", 7: "#f9a8d4", 8: "#e2e8f0"
};
var COLOR_KNOWN_BG = "#162033";
var COLOR_KNOWN_EDGE = "#0b1220";
var COLOR_UNKNOWN_TOP = "#4f93f7";
var COLOR_UNKNOWN_BOTTOM = "#2563eb";
var COLOR_UNKNOWN_EDGE = "#1e40af";
var COLOR_UNKNOWN_HILITE = "rgba(255,255,255,0.28)";
var COLOR_FLAG_CLOTH = "#ef4444";
var COLOR_FLAG_POLE = "#e2e8f0";
var NUMBER_FONT = "Inter, system-ui, sans-serif";

// Device pixel ratio — every canvas on the site renders at this multiple so
// it's crisp on HiDPI displays. Used by sizeBoardCanvas/sizePlayerCanvas in
// the live game and the Learn page's canvas factory.
var DPR = window.devicePixelRatio || 1;

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
BoardView.prototype.draw = function() {
	var ctx = this.canvas.getContext("2d");
	var sw = this.canvas.width / this.cols, sh = this.canvas.height / this.rows;
	ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
	var i, r, c;
	for (i = 0; i < this._underlays.length; i++) this._underlays[i](ctx, sw, sh);
	for (r = 0; r < this.rows; r++) {
		for (c = 0; c < this.cols; c++) {
			if (this.includeCell && !this.includeCell(r, c)) continue;
			drawCell(ctx, r, c, this, sw, sh, this.animAt ? this.animAt(r, c) : null);
		}
	}
	for (i = 0; i < this._overlays.length; i++) this._overlays[i](ctx, sw, sh);
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
	ctx.fillStyle = NUMBER_COLORS[n] || "#e2e8f0";
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
