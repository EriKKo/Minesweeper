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
		},
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
		if (typeof drawTerritoryEnergyLines === "function") drawTerritoryEnergyLines(ctx, sw, sh); // territory: power grid
		if (typeof drawTerritoryBeams === "function") drawTerritoryBeams(ctx, sw, sh); // territory: offensive beam streaks
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
