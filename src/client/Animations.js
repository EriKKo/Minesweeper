// Live game board canvas: the RAF animation loop, the reveal/flag/mine
// per-cell timing (cellAnims keyed by "r,c"), pressed-cell + keyboard-focus
// highlights, and the renderPlayerBoard function that paints the player's
// own board through drawCell each frame. Also owns drawBoardStatic for the
// opponent thumbnails and the BoardView adapter makeLiveView.

var prevPlayerState = null;   // last-seen state of game0, for reveal diffing
var cellAnims = {};            // "r,c" -> { type:"reveal"|"flag"|"mine", start:ms }
var animRAF = null;
var lastActionCell = null;     // where the local player last revealed, for ripple origin

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
	var x = focusedC * playerCanvasSquareWidth;
	var y = focusedR * playerCanvasSquareHeight;
	var gap = Math.max(1, Math.round(Math.min(playerCanvasSquareWidth, playerCanvasSquareHeight) * 0.08));
	ctx.save();
	ctx.strokeStyle = "#facc15";
	ctx.lineWidth = 2;
	roundRectPath(ctx, x + gap / 2, y + gap / 2, playerCanvasSquareWidth - gap, playerCanvasSquareHeight - gap, (Math.min(playerCanvasSquareWidth, playerCanvasSquareHeight) - gap) * 0.2);
	ctx.stroke();
	ctx.restore();
}

function redrawOwnBoardWithFocus() {
	renderPlayerBoard();
}

function makeLiveView(state) {
	return {
		rows: rows, cols: cols,
		isCovered: function(r, c) { return state[r][c] === UNKNOWN; },
		isRevealed: function(r, c) { return state[r][c] === KNOWN; },
		isFlagged: function(r, c) { return state[r][c] === FLAGGED; },
		isMine: function(r, c) { return boardCell(r, c) === MINE; },
		getClue: function(r, c) { var v = boardCell(r, c); return v > 0 ? v : 0; },
		xray: false
	};
}

// ---- whole boards ------------------------------------------------------
function drawBoardStatic(state, canvas) {
	var ctx = canvas.getContext("2d");
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	var sw = canvas.width / cols, sh = canvas.height / rows;
	var view = makeLiveView(state);
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			drawCell(ctx, r, c, view, sw, sh, null);
		}
	}
}

function renderPlayerBoard() {
	var ctx = playerCanvas.getContext("2d");
	ctx.clearRect(0, 0, playerCanvas.width, playerCanvas.height);
	if (boardDecoder && myState) {
		var view = makeLiveView(myState);
		var sw = playerCanvas.width / cols, sh = playerCanvas.height / rows;
		var now = performance.now();
		for (var r = 0; r < rows; r++) {
			for (var c = 0; c < cols; c++) {
				var a = cellAnims[r + "," + c];
				var animArg = null;
				if (a) {
					var dur = a.type === "flag" ? FLAG_DUR : a.type === "mine" ? MINE_DUR : REVEAL_DUR;
					animArg = { type: a.type, t: (now - a.start) / dur };
				}
				drawCell(ctx, r, c, view, sw, sh, animArg);
			}
		}
	}
	drawPressedHighlight();
	drawFocusHighlight();
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
