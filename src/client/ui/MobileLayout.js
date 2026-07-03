// Mobile / responsive layout: media-query tracking, canvas sizing for both
// the player board and opponent thumbnails (DPR-aware), the "find next
// frontier" mobile aid, and the routing-into/out-of mobile layout when the
// breakpoint changes.

var mobileMQL = window.matchMedia ? window.matchMedia("(max-width: 700px)") : null;
var mobileLayout = !!(mobileMQL && mobileMQL.matches);
function sizeBoardCanvas(canvas, cellPx) {
	var w = Math.round(cols * cellPx * DPR), h = Math.round(rows * cellPx * DPR);
	// Only reassign the backing size when it actually changes — assigning canvas.width/height clears
	// the canvas even to the same value, which would wipe a board we want to keep on screen (e.g. the
	// final board states under the game-over result, repainted only by live frames that have stopped).
	if (canvas.width !== w) canvas.width = w;
	if (canvas.height !== h) canvas.height = h;
	canvas.style.width = (cols * cellPx) + "px";
	canvas.style.maxWidth = "100%";
	canvas.style.height = "auto";
}
// Fixed board area for the rated-puzzle view so the page layout doesn't
// jump as different-sized puzzles load. Cells scale to fit the larger
// dimension, smaller dimension is centered in the box via flex on
// .board-scroll (see style.css). Cell size is capped — at the unbounded
// 480/max(rows,cols), a 4×4 would render at 120-px cells, ~3.5× the
// multiplayer cell, which looks oversized against itself.
var PUZZLE_BOARD_PX = 480;
var PUZZLE_BOARD_PX_MOBILE = 320;
var PUZZLE_CELL_MAX = 75;
var PUZZLE_CELL_MAX_MOBILE = 56;

// Largest cell size that lets a rows×cols board fit the available board area on
// desktop, clamped to [DESKTOP_CELL_MIN, DESKTOP_CELL_MAX]. Scaling to fit means a
// big board grows to use the screen instead of sitting at a fixed small size, and a
// wide board uses the full column width. Falls back to PLAYER_CELL if the layout
// can't be measured yet (e.g. called before the game view is visible).
function fitDesktopCellPx() {
	var gameLeft = document.querySelector(".game-left");
	// .game-left has min-width:0 and lives in a minmax(0,1fr) track, so its width is
	// the available column width regardless of the canvas's current size.
	var availW = gameLeft ? gameLeft.clientWidth - 42 : 0; // minus .player-board padding + border
	var top = playerCanvas.getBoundingClientRect().top;
	var availH = window.innerHeight - top - 24;            // leave a small bottom gap
	if (!(availW > 0)) availW = cols * PLAYER_CELL;
	if (!(availH > 0)) availH = rows * PLAYER_CELL;
	var cell = Math.floor(Math.min(availW / cols, availH / rows));
	// Territory and solo fill the whole area below the nav, so let their cells grow past the racing cap.
	var bigCell = (typeof territoryActive !== "undefined" && territoryActive) || ((typeof soloSession !== "undefined") && soloSession);
	var maxCell = bigCell ? 100 : DESKTOP_CELL_MAX;
	return Math.max(DESKTOP_CELL_MIN, Math.min(maxCell, cell));
}

// Mobile cell size for racing/solo/territory: the largest whole-pixel cell that lets a finger-friendly
// number of columns (~MOBILE_PLAYER_CELL wide) fill the board viewport exactly. A board narrower than
// that fits entirely (no panning); a wider board keeps big cells and pans. Returns an integer so cells
// render crisp, and so the viewport can be sized to a whole number of them (no half-cut cells).
var mobileCellPx = 0; // last mobile cell size, used to snap panning to whole-cell steps
// Available board width = the (full-bleed) parent of the scroll viewport. We measure the PARENT, not
// boardScroll itself, because sizePlayerCanvas shrinks boardScroll to a whole-cell width — reading its
// own (already-shrunk) width would drift smaller on every re-run.
function mobileAvailW() {
	var p = boardScroll && boardScroll.parentNode;
	var w = (p && p.clientWidth) || (boardScroll && boardScroll.clientWidth) || window.innerWidth;
	return w > 0 ? w : window.innerWidth;
}
function fitMobileCellPx() {
	var availW = mobileAvailW();
	var fitCols = Math.max(1, Math.floor(availW / MOBILE_PLAYER_CELL));
	var visibleCols = Math.min(cols, fitCols);            // never claim more columns than the board has
	return Math.max(1, Math.floor(availW / visibleCols)); // fill the width with whole columns
}

function sizePlayerCanvas() {
	var inPuzzle = (typeof puzzleSession !== "undefined") && puzzleSession;
	var cellPx;
	if (inPuzzle) {
		var target = mobileLayout ? PUZZLE_BOARD_PX_MOBILE : PUZZLE_BOARD_PX;
		var cap = mobileLayout ? PUZZLE_CELL_MAX_MOBILE : PUZZLE_CELL_MAX;
		cellPx = Math.min(cap, Math.floor(target / Math.max(rows, cols)));
	} else {
		cellPx = mobileLayout ? fitMobileCellPx() : fitDesktopCellPx();
	}
	var pw = Math.round(cols * cellPx * DPR), ph = Math.round(rows * cellPx * DPR);
	// Same guard as sizeBoardCanvas: don't clear the player board by re-assigning the same size.
	if (playerCanvas.width !== pw) playerCanvas.width = pw;
	if (playerCanvas.height !== ph) playerCanvas.height = ph;
	playerCanvas.style.width = (cols * cellPx) + "px";
	if (mobileLayout) {
		mobileCellPx = cellPx;
		wireScrollSnap();
		playerCanvas.style.height = (rows * cellPx) + "px";
		playerCanvas.style.maxWidth = "none";
		// Constrain the scroll viewport to a whole number of cells (centered), so its edges always land
		// on cell boundaries — combined with whole-step panning (snapBoardScroll), no cell is ever
		// rendered half-visible. Puzzles keep their fixed centered box.
		if (boardScroll && !inPuzzle) {
			var visW = Math.min(cols, Math.floor(mobileAvailW() / cellPx)) * cellPx;
			boardScroll.style.width = visW + "px";
			boardScroll.style.marginLeft = "auto";
			boardScroll.style.marginRight = "auto";
		}
	} else {
		playerCanvas.style.height = "auto";
		playerCanvas.style.maxWidth = "100%";
	}
}

// Once a pan settles, glide the board to the nearest whole-cell offset so no cell is left clipped at an
// edge — animated (not an instant jump) so it doesn't feel like the board snaps around under your finger.
function snapBoardScroll() {
	if (!mobileLayout || !boardScroll || !(mobileCellPx > 0)) return;
	var sx = Math.round(boardScroll.scrollLeft / mobileCellPx) * mobileCellPx;
	var sy = Math.round(boardScroll.scrollTop / mobileCellPx) * mobileCellPx;
	if (Math.abs(sx - boardScroll.scrollLeft) < 0.5 && Math.abs(sy - boardScroll.scrollTop) < 0.5) return; // already aligned
	if (typeof boardScroll.scrollTo === "function") {
		try { boardScroll.scrollTo({ left: sx, top: sy, behavior: "smooth" }); return; } catch (e) {}
	}
	boardScroll.scrollLeft = sx;
	boardScroll.scrollTop = sy;
}
function scrollToCell(r, c, smooth) {
	if (!boardScroll) return;
	var rect = playerCanvas.getBoundingClientRect();
	var cellW = rect.width / cols, cellH = rect.height / rows;
	// Centre the cell, then snap the offset to a whole-cell step so edges land on cell boundaries.
	var targetX = Math.round(((c + 0.5) * cellW - boardScroll.clientWidth / 2) / cellW) * cellW;
	var targetY = Math.round(((r + 0.5) * cellH - boardScroll.clientHeight / 2) / cellH) * cellH;
	if (smooth && typeof boardScroll.scrollTo === "function") {
		try { boardScroll.scrollTo({ left: targetX, top: targetY, behavior: "smooth" }); return; } catch (e) {}
	}
	boardScroll.scrollLeft = targetX;
	boardScroll.scrollTop = targetY;
}
// Snap manual (finger) panning to whole-cell steps once the gesture settles.
var scrollSnapWired = false;
function wireScrollSnap() {
	if (scrollSnapWired || !boardScroll) return;
	scrollSnapWired = true;
	// Snap only once scrolling has fully stopped (including momentum), so we never fight an in-progress
	// fling. scrollend fires exactly then; for browsers without it, debounce 'scroll' long enough that
	// momentum has settled. (No touchend snap — the finger lifts while momentum is still running.)
	var t = null;
	function deferredSnap() { if (t) clearTimeout(t); t = setTimeout(snapBoardScroll, 140); }
	if ("onscrollend" in boardScroll) boardScroll.addEventListener("scrollend", snapBoardScroll);
	else boardScroll.addEventListener("scroll", deferredSnap, { passive: true });
}
function isFrontierCell(r, c) {
	if (myState[r][c] !== UNKNOWN) return false;
	for (var dr = -1; dr <= 1; dr++) {
		for (var dc = -1; dc <= 1; dc++) {
			if (dr === 0 && dc === 0) continue;
			var nr = r + dr, nc = c + dc;
			if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
			if (myState[nr][nc] === KNOWN) return true;
		}
	}
	return false;
}
function findNearestFrontierCell() {
	if (!myState) return null;
	var rect = playerCanvas.getBoundingClientRect();
	var cellW = rect.width / cols, cellH = rect.height / rows;
	var viewCol = (boardScroll.scrollLeft + boardScroll.clientWidth / 2) / cellW - 0.5;
	var viewRow = (boardScroll.scrollTop + boardScroll.clientHeight / 2) / cellH - 0.5;
	var bestFrontier = null, bestFrontierD = Infinity;
	var bestUnknown = null, bestUnknownD = Infinity;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (myState[r][c] !== UNKNOWN) continue;
			var dr = r - viewRow, dc = c - viewCol;
			var d = dr * dr + dc * dc;
			if (d < bestUnknownD) { bestUnknownD = d; bestUnknown = { r: r, c: c }; }
			if (isFrontierCell(r, c) && d < bestFrontierD) { bestFrontierD = d; bestFrontier = { r: r, c: c }; }
		}
	}
	return bestFrontier || bestUnknown;
}
function updateMobileFindNextHint() {
	if (!mobileLayout || !findNextArrow) return;
	if (!currentActionMode() || !myState) {
		findNextArrow.classList.remove("visible");
		arrowTargetCell = null;
		return;
	}
	var rect = playerCanvas.getBoundingClientRect();
	if (!rect.width || !rect.height) return;
	var cellW = rect.width / cols, cellH = rect.height / rows;
	var minCol = Math.max(0, Math.floor(boardScroll.scrollLeft / cellW));
	var maxCol = Math.min(cols, Math.ceil((boardScroll.scrollLeft + boardScroll.clientWidth) / cellW));
	var minRow = Math.max(0, Math.floor(boardScroll.scrollTop / cellH));
	var maxRow = Math.min(rows, Math.ceil((boardScroll.scrollTop + boardScroll.clientHeight) / cellH));

	// If any frontier is visible (or the whole board is solved), no arrow.
	for (var r = minRow; r < maxRow; r++) {
		for (var c = minCol; c < maxCol; c++) {
			if (isFrontierCell(r, c)) {
				findNextArrow.classList.remove("visible");
				arrowTargetCell = null;
				return;
			}
		}
	}

	var target = findNearestFrontierCell();
	// Guard against the target already being inside the viewport (race condition).
	if (!target || (target.r >= minRow && target.r < maxRow && target.c >= minCol && target.c < maxCol)) {
		findNextArrow.classList.remove("visible");
		arrowTargetCell = null;
		return;
	}
	arrowTargetCell = target;

	// Direction from viewport centre to the target cell.
	var viewCenterX = boardScroll.scrollLeft + boardScroll.clientWidth / 2;
	var viewCenterY = boardScroll.scrollTop + boardScroll.clientHeight / 2;
	var dx = (target.c + 0.5) * cellW - viewCenterX;
	var dy = (target.r + 0.5) * cellH - viewCenterY;
	var theta = Math.atan2(dy, dx);
	var deg = theta * 180 / Math.PI;

	// Snap arrow to the closest of 8 viewport positions (4 edges + 4 corners).
	var margin = 8, aw = 44, ah = 44;
	var bw = boardScroll.clientWidth, bh = boardScroll.clientHeight;
	var ax, ay;
	var absDeg = Math.abs(deg);
	if (absDeg < 22.5)               { ax = bw - aw - margin; ay = (bh - ah) / 2; }
	else if (deg >= 22.5 && deg < 67.5)   { ax = bw - aw - margin; ay = bh - ah - margin; }
	else if (deg >= 67.5 && deg < 112.5)  { ax = (bw - aw) / 2;    ay = bh - ah - margin; }
	else if (deg >= 112.5 && deg < 157.5) { ax = margin;           ay = bh - ah - margin; }
	else if (absDeg >= 157.5)             { ax = margin;           ay = (bh - ah) / 2; }
	else if (deg <= -22.5 && deg > -67.5) { ax = bw - aw - margin; ay = margin; }
	else if (deg <= -67.5 && deg > -112.5){ ax = (bw - aw) / 2;    ay = margin; }
	else                                  { ax = margin;           ay = margin; }

	findNextArrow.style.left = ax + "px";
	findNextArrow.style.top = ay + "px";
	arrowGlyph.style.transform = "rotate(" + theta + "rad)";
	findNextArrow.classList.add("visible");
}
// --- Mobile cursor / frontier navigation ---

// All frontier cells (UNKNOWN and adjacent to at least one KNOWN cell), in
// reading order (top-left → bottom-right). Falls back to all UNKNOWN cells
// when no frontier exists (e.g. very start of game before any reveals).
function getSortedFrontierCells() {
	var cells = [];
	if (!myState) return cells;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (isFrontierCell(r, c)) cells.push({ r: r, c: c });
		}
	}
	if (!cells.length) {
		for (var r = 0; r < rows; r++) {
			for (var c = 0; c < cols; c++) {
				if (myState[r][c] === UNKNOWN) cells.push({ r: r, c: c });
			}
		}
	}
	if (cells.length <= 1) return cells;
	// Sort by angle from the centroid of revealed cells so ‹/› traces the
	// frontier boundary in a circular sweep rather than jumping back and forth
	// across rows in reading order.
	var sumR = 0, sumC = 0, n = 0;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (myState[r][c] === KNOWN) { sumR += r; sumC += c; n++; }
		}
	}
	var cR = n > 0 ? sumR / n : rows / 2;
	var cC = n > 0 ? sumC / n : cols / 2;
	cells.sort(function(a, b) {
		return Math.atan2(a.r - cR, a.c - cC) - Math.atan2(b.r - cR, b.c - cC);
	});
	return cells;
}

// On mobile we play by tapping cells directly and panning the board by hand — there's no focus
// cursor and the board never auto-pans to follow one. So this is a no-op on mobile (it used to move a
// keyboard-style cursor to the nearest frontier cell and scroll it into view after every action, which
// made the board jump around). Kept as a stub so its call sites stay valid.
function mobileAutoSelect() {}

// Step the cursor to the prev (dir=-1) or next (dir=+1) frontier cell along
// the circular boundary sweep, wrapping around. Used by the ‹ / › nav buttons.
function mobileNavigate(dir) {
	if (!mobileLayout || !touchInput) return;
	var cells = getSortedFrontierCells();
	if (!cells.length) return;
	// Find where the cursor currently sits in the sorted list.
	var cur = -1;
	for (var i = 0; i < cells.length; i++) {
		if (cells[i].r === focusedR && cells[i].c === focusedC) { cur = i; break; }
	}
	if (cur === -1) {
		// Cursor isn't on a frontier cell — find the nearest by pixel distance.
		var best = Infinity;
		for (var i = 0; i < cells.length; i++) {
			var dr = cells[i].r - focusedR, dc = cells[i].c - focusedC;
			var d = dr * dr + dc * dc;
			if (d < best) { best = d; cur = i; }
		}
	}
	var next = (cur + dir + cells.length) % cells.length;
	focusedR = cells[next].r;
	focusedC = cells[next].c;
	focusVisible = true;
	scrollToCell(focusedR, focusedC, true);
	redrawOwnBoardWithFocus();
	if (navigator.vibrate) navigator.vibrate(8);
}

function onMobileLayoutChange() {
	mobileLayout = !!(mobileMQL && mobileMQL.matches);
	sizePlayerCanvas();
}
if (mobileMQL) {
	if (typeof mobileMQL.addEventListener === "function") mobileMQL.addEventListener("change", onMobileLayoutChange);
	else if (typeof mobileMQL.addListener === "function") mobileMQL.addListener(onMobileLayoutChange);
}

// Rescale the player board when the window resizes, so the fit-to-space sizing
// tracks the available area. Re-sizing the canvas clears its backing store, so we
// redraw after. Coalesced into one rAF tick to avoid thrashing during a drag.
function refreshPlayerBoardSize() {
	if (typeof myState === "undefined" || !myState) return; // only while a board is active
	sizePlayerCanvas();
	if (typeof redrawOwnBoardWithFocus === "function") redrawOwnBoardWithFocus();
	// Duel: keep the opponent board matched to the (resized) player board and repaint it from
	// the last frame, since resizing a canvas clears it and the opponent may not be moving.
	if (typeof sizeOpponentCanvases === "function") sizeOpponentCanvases();
	if (typeof isDuoRacing === "function" && isDuoRacing() && lastGames && lastGames[1]) {
		drawBoardStatic(lastGames[1].state, document.getElementById("game1"), lastGames[1].skin || "classic");
	}
}
var playerBoardResizeRaf = null;
window.addEventListener("resize", function() {
	if (playerBoardResizeRaf) return;
	playerBoardResizeRaf = requestAnimationFrame(function() {
		playerBoardResizeRaf = null;
		refreshPlayerBoardSize();
	});
});
