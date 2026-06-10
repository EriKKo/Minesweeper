// Canvas-based board rendering. Used by every interactive board surface on
// the site: the live game's playerCanvas, the opponent thumbnails, the Learn
// demos, and the Learn puzzles. Each surface supplies a BoardView object —
// isCovered/isRevealed/isFlagged/isMine/getClue/xray — so the same paint code
// works against different cell-state schemas.
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
			var ownProg = revealing ? easeOutCubic(t) : 1;
			ctx.save();
			ctx.globalAlpha = 0.20 * ownProg;
			ctx.fillStyle = ownerColor;
			roundRectPath(ctx, 0, 0, w, h, rad);
			ctx.fill();
			ctx.restore();
			// OpenFront-style border: a bright edge wherever this cell meets a different owner,
			// unclaimed ground, or the board edge — outlining each player's territory clearly.
			drawOwnerBorder(ctx, r, c, w, h, rad, ownerColor, view, ownProg);
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
		var fs = anim && anim.type === "flag" ? easeOutBack(clamp01(anim.t)) : 1;
		drawFlag(ctx, w, h, fs);
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

// Territory: stroke a bright border in the owner colour along each edge of cell (r,c) that faces a
// DIFFERENT owner — a different player, unclaimed/covered ground, or the board edge. Interior cells
// (all four neighbours same owner) draw nothing, so only the outline of each territory shows.
function drawOwnerBorder(ctx, r, c, w, h, rad, color, view, prog) {
	var R = view.rows, C = view.cols;
	function facesOut(nr, nc) {
		if (nr < 0 || nc < 0 || nr >= R || nc >= C) return true;           // board edge
		return (view.getOwner ? view.getOwner(nr, nc) : null) !== color;   // different owner / unclaimed
	}
	var top = facesOut(r - 1, c), bottom = facesOut(r + 1, c), left = facesOut(r, c - 1), right = facesOut(r, c + 1);
	if (!top && !bottom && !left && !right) return;                        // interior cell — no border
	ctx.save();
	ctx.globalAlpha = 0.4 * (prog == null ? 1 : prog);
	ctx.strokeStyle = color;
	ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.06);
	ctx.lineCap = "round";
	var i = ctx.lineWidth / 2; // inset so the stroke sits fully inside the cell
	ctx.beginPath();
	if (top)    { ctx.moveTo(0, i);     ctx.lineTo(w, i); }
	if (bottom) { ctx.moveTo(0, h - i); ctx.lineTo(w, h - i); }
	if (left)   { ctx.moveTo(i, 0);     ctx.lineTo(i, h); }
	if (right)  { ctx.moveTo(w - i, 0); ctx.lineTo(w - i, h); }
	ctx.stroke();
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

function drawFlag(ctx, w, h, scale) {
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
	ctx.fillStyle = COLOR_FLAG_CLOTH;
	ctx.fill();
	ctx.restore();
}
