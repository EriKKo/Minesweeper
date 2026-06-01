// Mobile / responsive layout: media-query tracking, canvas sizing for both
// the player board and opponent thumbnails (DPR-aware), the "find next
// frontier" mobile aid, and the routing-into/out-of mobile layout when the
// breakpoint changes.

var mobileMQL = window.matchMedia ? window.matchMedia("(max-width: 700px)") : null;
var mobileLayout = !!(mobileMQL && mobileMQL.matches);
function sizeBoardCanvas(canvas, cellPx) {
	canvas.width = Math.round(cols * cellPx * DPR);
	canvas.height = Math.round(rows * cellPx * DPR);
	canvas.style.width = (cols * cellPx) + "px";
	canvas.style.maxWidth = "100%";
	canvas.style.height = "auto";
}
// Fixed board area for the rated-puzzle view so the page layout doesn't
// jump as different-sized puzzles load. Cells scale to fit the larger
// dimension, smaller dimension is centered in the box via flex on
// .board-scroll (see style.css).
var PUZZLE_BOARD_PX = 480;
var PUZZLE_BOARD_PX_MOBILE = 320;

function sizePlayerCanvas() {
	var inPuzzle = (typeof puzzleSession !== "undefined") && puzzleSession;
	var cellPx;
	if (inPuzzle) {
		var target = mobileLayout ? PUZZLE_BOARD_PX_MOBILE : PUZZLE_BOARD_PX;
		cellPx = Math.floor(target / Math.max(rows, cols));
	} else {
		cellPx = mobileLayout ? MOBILE_PLAYER_CELL : PLAYER_CELL;
	}
	playerCanvas.width = Math.round(cols * cellPx * DPR);
	playerCanvas.height = Math.round(rows * cellPx * DPR);
	playerCanvas.style.width = (cols * cellPx) + "px";
	if (mobileLayout) {
		playerCanvas.style.height = (rows * cellPx) + "px";
		playerCanvas.style.maxWidth = "none";
	} else {
		playerCanvas.style.height = "auto";
		playerCanvas.style.maxWidth = "100%";
	}
}
function scrollToCell(r, c, smooth) {
	if (!boardScroll) return;
	var rect = playerCanvas.getBoundingClientRect();
	var cellW = rect.width / cols, cellH = rect.height / rows;
	var targetX = (c + 0.5) * cellW - boardScroll.clientWidth / 2;
	var targetY = (r + 0.5) * cellH - boardScroll.clientHeight / 2;
	if (smooth && typeof boardScroll.scrollTo === "function") {
		try { boardScroll.scrollTo({ left: targetX, top: targetY, behavior: "smooth" }); return; } catch (e) {}
	}
	boardScroll.scrollLeft = targetX;
	boardScroll.scrollTop = targetY;
}
function isFrontierCell(r, c) {
	if (myState[r][c] !== UNKNOWN) return false;
	// Treat unflagged mines as "marked dangerous" — players skip flagging them at
	// speed, but they still aren't candidates to explore toward. Uses the real
	// board (a deliberate cheat for the hint UI only — clicks still go via the
	// server, which doesn't know what the player has mentally deduced).
	if (boardCell(r, c) === MINE) return false;
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
function onMobileLayoutChange() {
	mobileLayout = !!(mobileMQL && mobileMQL.matches);
	sizePlayerCanvas();
	playerCanvasWidth = playerCanvas.width;
	playerCanvasHeight = playerCanvas.height;
	playerCanvasSquareWidth = playerCanvasWidth / cols;
	playerCanvasSquareHeight = playerCanvasHeight / rows;
}
if (mobileMQL) {
	if (typeof mobileMQL.addEventListener === "function") mobileMQL.addEventListener("change", onMobileLayoutChange);
	else if (typeof mobileMQL.addListener === "function") mobileMQL.addListener(onMobileLayoutChange);
}
