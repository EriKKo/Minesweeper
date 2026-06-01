// Player-board input dispatch.
//
// Mouse/touch/key event handlers feed into performAction, which optimistically
// applies the reveal or flag to myState (queuing the corresponding animation)
// and emits the same action to the server. Solo (Solo.js) and the multiplayer
// flow both come through performAction.
//
// localReveal + applyLocalLeftClick are the local mirror of the server's
// dfs reveal + chord click — they run through BoardLogic so the two surfaces
// stay in lockstep.

// Hit-test a canvas at a client (x, y) point. Used by both the live game
// (cellFromClient) and the Learn page — every interactive board on the site
// flows through here.
function cellFromCanvas(canvas, R, C, clientX, clientY) {
	var rect = canvas.getBoundingClientRect();
	var c = Math.floor((clientX - rect.left) / rect.width * C);
	var r = Math.floor((clientY - rect.top) / rect.height * R);
	if (r < 0 || r >= R || c < 0 || c >= C) return null;
	return { r: r, c: c };
}

function cellFromClient(clientX, clientY) {
	return cellFromCanvas(playerCanvas, rows, cols, clientX, clientY);
}

function clearPressed() {
	if (!pressedCell) return;
	pressedCell = null;
	redrawOwnBoardWithFocus();
}
function localReveal(r, c, revealed) {
	return BoardLogic.cascadeReveal(r, c, rows, cols,
		function(rr, cc) { return myState[rr][cc] === UNKNOWN; },
		function(rr, cc) {
			myState[rr][cc] = KNOWN;
			revealed.push([rr, cc]);
			return boardCell(rr, cc) === MINE;
		},
		function(rr, cc) { return boardCell(rr, cc); }
	);
}

// Click on a revealed number-cell with the right flag-count → chord (auto-reveal
// the remaining unflagged neighbors). Matches server clearAdjacentIfEnoughFlags.
function applyLocalLeftClick(r, c) {
	if (!myState || !boardDecoder) return { revealed: [], hitMine: false, anyChange: false };
	var revealed = [];
	var hitMine = false;
	if (myState[r][c] === UNKNOWN) {
		hitMine = localReveal(r, c, revealed);
	} else if (myState[r][c] === KNOWN) {
		var v = boardCell(r, c);
		if (v > 0) {
			var ctx = BoardLogic.chordContext(r, c, rows, cols,
				function(rr, cc) { return myState[rr][cc] === FLAGGED; },
				function(rr, cc) { return myState[rr][cc] === KNOWN && boardCell(rr, cc) === MINE; },
				function(rr, cc) { return myState[rr][cc] === UNKNOWN; }
			);
			if (ctx.flagCount === v) {
				for (var i = 0; i < ctx.covered.length; i++) {
					if (localReveal(ctx.covered[i][0], ctx.covered[i][1], revealed)) hitMine = true;
				}
			}
		}
	}
	return { revealed: revealed, hitMine: hitMine, anyChange: revealed.length > 0 };
}

function performAction(r, c, asFlag) {
	if (soloSession) return performSoloAction(r, c, asFlag);
	var inMultiplayer = inRoom && currentRoom && currentRoom.phase === "playing";
	var inPuzzle = (typeof puzzleSession !== "undefined") && puzzleSession && !puzzleSession.finished;
	if (!inMultiplayer && !inPuzzle) return;
	if (Date.now() < frozenUntil) return;
	if (r < 0 || r >= rows || c < 0 || c >= cols) return;
	focusedR = r;
	focusedC = c;
	if (asFlag) {
		// Optimistic flag toggle. prevPlayerState is updated too so the server's
		// matching broadcast doesn't re-trigger the animation.
		if (myState) {
			if (myState[r][c] === UNKNOWN) {
				myState[r][c] = FLAGGED;
				if (prevPlayerState) prevPlayerState[r][c] = FLAGGED;
				cellAnims[r + "," + c] = { type: "flag", start: performance.now() };
			} else if (myState[r][c] === FLAGGED) {
				myState[r][c] = UNKNOWN;
				if (prevPlayerState) prevPlayerState[r][c] = UNKNOWN;
				delete cellAnims[r + "," + c];
			}
		}
		socket.emit("right_click", { r: r, c: c, id: id });
	} else {
		// Optimistic reveal + cascade. On a mine hit, apply the local freeze
		// straight away; the server's echo will match.
		lastActionCell = { r: r, c: c };
		var result = applyLocalLeftClick(r, c);
		if (result.anyChange) {
			queueRevealAnimations(myState);
			prevPlayerState = cloneState(myState);
		}
		if (result.hitMine && inMultiplayer && currentRoom.deathPenalty) {
			frozenUntil = Date.now() + currentRoom.deathPenalty * 1000;
			startFreezeTick();
		}
		socket.emit("left_click", { r: r, c: c, id: id });
	}
	if (inPuzzle) updatePuzzleHud();
	redrawOwnBoardWithFocus();
}

function emitBoardActionAt(clientX, clientY, asFlag) {
	var cell = cellFromClient(clientX, clientY);
	if (!cell) return;
	focusVisible = false;
	performAction(cell.r, cell.c, asFlag);
}

function boardClicked(event) {
	event = event || window.event;
	var cell = cellFromClient(event.clientX, event.clientY);
	if (!cell) return;
	focusVisible = false;
	if (isLeftClick(event)) performAction(cell.r, cell.c, false);
	else if (isRightClick(event)) performAction(cell.r, cell.c, true);
}
function stepFocus(dr, dc, skipRevealed) {
	if (skipRevealed && myState) {
		var nr = focusedR + dr;
		var nc = focusedC + dc;
		while (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
			if (myState[nr][nc] === UNKNOWN) {
				focusedR = nr;
				focusedC = nc;
				return true;
			}
			nr += dr;
			nc += dc;
		}
		return false;
	}
	var tr = Math.max(0, Math.min(rows - 1, focusedR + dr));
	var tc = Math.max(0, Math.min(cols - 1, focusedC + dc));
	if (tr === focusedR && tc === focusedC) return false;
	focusedR = tr;
	focusedC = tc;
	return true;
}

function jumpToNextUnknown(forward) {
	if (!myState) return false;
	var total = rows * cols;
	var start = focusedR * cols + focusedC;
	for (var i = 1; i <= total; i++) {
		var idx = forward ? (start + i) % total : (start - i + total) % total;
		var r = Math.floor(idx / cols);
		var c = idx % cols;
		if (myState[r][c] === UNKNOWN) {
			focusedR = r;
			focusedC = c;
			return true;
		}
	}
	return false;
}
document.addEventListener("keydown", function(e) {
	if (!soloSession && (!inRoom || !currentRoom || currentRoom.phase !== "playing")) return;
	var tag = (e.target && e.target.tagName) || "";
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	if (e.ctrlKey || e.metaKey || e.altKey) return;
	var key = e.key;
	var skip = e.shiftKey;
	var moved = false;
	if (key === "ArrowUp") {
		moved = stepFocus(-1, 0, skip);
	} else if (key === "ArrowDown") {
		moved = stepFocus(1, 0, skip);
	} else if (key === "ArrowLeft") {
		moved = stepFocus(0, -1, skip);
	} else if (key === "ArrowRight") {
		moved = stepFocus(0, 1, skip);
	} else if (key === "Tab") {
		e.preventDefault();
		moved = jumpToNextUnknown(!e.shiftKey);
	} else if (key === " " || key === "x" || key === "X") {
		e.preventDefault();
		// Browser key-repeat fires keydown ~30/sec when a key is held; each tick
		// would toggle/re-emit, so reveal/flag are one-press-one-action.
		if (e.repeat) return;
		focusVisible = true;
		performAction(focusedR, focusedC, false);
		return;
	} else if (key === "z" || key === "Z") {
		e.preventDefault();
		if (e.repeat) return;
		focusVisible = true;
		performAction(focusedR, focusedC, true);
		return;
	} else {
		return;
	}
	e.preventDefault();
	focusVisible = true;
	redrawOwnBoardWithFocus();
});
function isRightClick(e) {
	return (e.which ? (e.which == 3) : (e.button ? (e.button == 2) : false));
}

function isLeftClick(e) {
	return (e.which ? (e.which == 1) : (e.button ? (e.button == 0) : false));
}

function getRow(y) { return Math.floor(y / playerCanvasSquareHeight); }
function getCol(x) { return Math.floor(x / playerCanvasSquareWidth); }
