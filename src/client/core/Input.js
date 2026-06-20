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
	if (!myState || !boardDecoder) return { revealed: [], hitMine: false, anyChange: false, clearedFlags: [] };
	var revealed = [];
	var hitMine = false;
	var clearedFlags = [];
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
				// A chord that detonates means a flag here was wrong. Clear every incorrect flag around
				// this number (flagged but not actually a mine) so the mistake is visibly undone.
				if (hitMine) {
					for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
						if (!dr && !dc) continue;
						var nr = r + dr, nc = c + dc;
						if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
						if (myState[nr][nc] === FLAGGED && boardCell(nr, nc) !== MINE) {
							myState[nr][nc] = UNKNOWN;
							delete cellAnims[nr + "," + nc];
							clearedFlags.push([nr, nc]);
						}
					}
				}
			}
		}
	}
	return { revealed: revealed, hitMine: hitMine, anyChange: revealed.length > 0 || clearedFlags.length > 0, clearedFlags: clearedFlags };
}

// One click pipeline for every mode. The board logic is identical — only
// the mode-specific bookkeeping differs (server echo, freeze-on-mine for
// multiplayer; timer start, local win/lose detection, outcome panel for
// solo; rating HUD for puzzles). Splitting this earlier had the rendering
// bug masked by the multiplayer server echo, which silently kicked the
// animation loop; in solo and puzzles there's no echo so the bug shows up.
function performAction(r, c, asFlag) {
	var mode = currentActionMode();
	if (!mode) return;
	// Spectators (tournament-eliminated) see opponents on slot-0 but can't
	// affect their boards — drop clicks early so we don't corrupt local
	// myState or emit illegal left_click events to the server.
	if (iAmEliminated) return;
	if (Date.now() < frozenUntil) return;
	if (r < 0 || r >= rows || c < 0 || c >= cols) return;
	// Solo is locked until the player hits Start and the countdown finishes.
	if (mode === "solo" && soloSession && !soloSession.started) return;
	if (mode === "puzzle" && typeof clearPuzzleHints === "function") clearPuzzleHints();
	// Custom-lobby modifiers: "noFlags" blocks flag/right-click; "onlyFlags" lets only the flag tool act.
	if (mode === "multiplayer" && currentRoom && currentRoom.modifier) {
		if (currentRoom.modifier === "noFlags" && asFlag) return;
		if (currentRoom.modifier === "onlyFlags" && !asFlag) {
			// Flags-only: a left-click can't reveal — it only chords a revealed number (right-click places/
			// removes flags, which auto-chord). A left-click on a covered or flagged cell is a no-op; on a
			// revealed number it routes through the flag tool so the server (which ignores left_click in this
			// mode) handles it as a chord.
			if (!myState || myState[r][c] !== KNOWN) return;
			asFlag = true;
		}
	}
	focusedR = r;
	focusedC = c;
	if (mode === "territory") {
		// Shared board with local prediction (the client decodes the board, like the other modes):
		// predict a safe reveal immediately, then emit for the server to validate/explode/capture and
		// reconcile via territory_board. Clicking one of your own revealed numbers chords (client-driven,
		// since flags are local-only). Flags are a local "suspected mine" mark; a flagged cell is
		// protected from an accidental reveal.
		// Aiming an energy bomb: the next left-click picks the target area (handled in Territory.js).
		if (!asFlag && typeof territoryAiming !== "undefined" && territoryAiming) {
			if (typeof territoryLaunchBomb === "function") territoryLaunchBomb(r, c);
			redrawOwnBoardWithFocus();
			return;
		}
		if (!asFlag && typeof territoryIsMyStructure === "function" && territoryIsMyStructure(r, c)) {
			activeGameSocket().emit("territory_fire", { r: r, c: c }); // fire this fort's beam at the nearest enemy
		} else if (myState && myState[r][c] === KNOWN) {
			territoryChord(r, c);
		} else if (asFlag) {
			if (typeof territoryToggleFlag === "function") territoryToggleFlag(r, c);
		} else if (!(myState && myState[r][c] === FLAGGED)) {
			if (typeof territoryLocalReveal === "function") territoryLocalReveal(r, c); // optimistic predict
			activeGameSocket().emit("left_click", { r: r, c: c, id: id });
		}
		redrawOwnBoardWithFocus();
		return;
	}
	var actionResult = null; // reveal/chord result, for emitting any chord-cleared flags to the server
	if (asFlag) {
		// Right-click on a covered cell toggles a flag. Right-click on a
		// revealed number with the matching flag count chords the same way
		// left-click does — both go through revealAt so the local cascade
		// (and any mine-hit detection) is identical regardless of which
		// button triggered it.
		if (myState && myState[r][c] === KNOWN) {
			var chordResult = revealAt(r, c);
			actionResult = chordResult;
			if (mode === "multiplayer" && chordResult.hitMine && currentRoom.deathPenalty) {
				frozenUntil = Date.now() + currentRoom.deathPenalty * 1000;
				startFreezeTick();
			}
			if (mode === "solo") soloOnAfterReveal(chordResult);
		} else {
			placeFlag(r, c);
			// Placing/toggling a flag is a real first move — start the solo clock.
			if (mode === "solo" && typeof soloStartTimerOnce === "function") soloStartTimerOnce();
			// No-flag-clear challenge (solo + racing only, not puzzles): a flag disqualifies it.
			if (mode === "solo" || mode === "multiplayer") clearNoFlag = false;
		}
	} else {
		// A direct reveal of a covered cell (vs. a chord on a revealed number) disqualifies the
		// "chord-only" clear challenge. Capture before revealAt mutates the cell.
		var wasCovered = myState && myState[r][c] === UNKNOWN;
		var result = revealAt(r, c);
		actionResult = result;
		if (wasCovered && (mode === "solo" || mode === "multiplayer")) clearNoReveal = false;
		if (mode === "multiplayer" && result.hitMine && currentRoom.deathPenalty) {
			frozenUntil = Date.now() + currentRoom.deathPenalty * 1000;
			startFreezeTick();
		}
		if (mode === "solo") soloOnAfterReveal(result);
		if (mode === "puzzle" && typeof notePuzzleReveal === "function") notePuzzleReveal(result);
	}
	if (mode === "multiplayer" || mode === "puzzle") {
		activeGameSocket().emit(asFlag ? "right_click" : "left_click", { r: r, c: c, id: id });
		// A chord that detonated cleared its incorrect flags locally — tell the server to drop those
		// flags too (right_click toggles each off) so its per-player board stays in sync.
		if (actionResult && actionResult.clearedFlags) {
			for (var cf = 0; cf < actionResult.clearedFlags.length; cf++) {
				activeGameSocket().emit("right_click", { r: actionResult.clearedFlags[cf][0], c: actionResult.clearedFlags[cf][1], id: id });
			}
		}
	}
	if (mode === "solo") updateSoloHud();
	else if (mode === "puzzle") updatePuzzleHud();
	redrawOwnBoardWithFocus();
}

// Territory chord: clicking an owned number whose local flag-count matches it emits a reveal for
// each remaining covered (non-flagged) neighbour. The server validates each (they're adjacent to
// your territory); revealing into a mine freezes you, like a mistaken chord anywhere else.
function territoryChord(r, c) {
	var v = boardCell(r, c);
	if (v <= 0 || !myState) return;
	var ctx = BoardLogic.chordContext(r, c, rows, cols,
		function(rr, cc) { return myState[rr][cc] === FLAGGED; },
		function() { return false; },                                  // no revealed-mine concept in territory
		function(rr, cc) { return myState[rr][cc] === UNKNOWN; });
	if (ctx.flagCount !== v) return;
	// If a covered non-flagged neighbour is actually a mine, this chord will detonate — a flag here was
	// wrong. Clear every incorrect flag around this number (flagged but not a mine) before revealing.
	var willDetonate = false;
	for (var k = 0; k < ctx.covered.length; k++) if (boardCell(ctx.covered[k][0], ctx.covered[k][1]) === MINE) willDetonate = true;
	if (willDetonate) {
		for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
			if (!dr && !dc) continue;
			var fr = r + dr, fc = c + dc;
			if (fr < 0 || fc < 0 || fr >= rows || fc >= cols) continue;
			if (myState[fr][fc] === FLAGGED && boardCell(fr, fc) !== MINE && typeof territoryToggleFlag === "function") territoryToggleFlag(fr, fc);
		}
	}
	for (var i = 0; i < ctx.covered.length; i++) {
		var nr = ctx.covered[i][0], nc = ctx.covered[i][1];
		if (typeof territoryLocalReveal === "function") territoryLocalReveal(nr, nc); // predict the safe neighbours
		activeGameSocket().emit("left_click", { r: nr, c: nc, id: id });
	}
}

function currentActionMode() {
	if (soloSession && !soloSession.finished) return "solo";
	if ((typeof puzzleSession !== "undefined") && puzzleSession && !puzzleSession.finished) return "puzzle";
	// Territory takes precedence over the generic multiplayer path (the room is also phase
	// "playing"), since it drives the shared board differently (server-authoritative, no flags).
	if (typeof territoryActive !== "undefined" && territoryActive) return "territory";
	if (inRoom && currentRoom && currentRoom.phase === "playing") return "multiplayer";
	return null;
}

// Optimistic flag toggle. prevPlayerState is updated too so the server's
// matching broadcast doesn't re-trigger the animation. startAnimLoop is
// required — without it the cellAnim entry sits at t=0 (invisible flag)
// until the next render frame kicks in for another reason.
function placeFlag(r, c) {
	if (!myState) return;
	var key = r + "," + c;
	if (myState[r][c] === UNKNOWN) {
		myState[r][c] = FLAGGED;
		if (prevPlayerState) prevPlayerState[r][c] = FLAGGED;
		cellAnims[key] = { type: "flag", start: performance.now() };
		startAnimLoop();
		sound.flag && sound.flag();
	} else if (myState[r][c] === FLAGGED) {
		myState[r][c] = UNKNOWN;
		if (prevPlayerState) prevPlayerState[r][c] = UNKNOWN;
		delete cellAnims[key];
		sound.unflag && sound.unflag();
	}
}

// Optimistic reveal + cascade. queueRevealAnimations starts the RAF loop
// and plays cascade/mine sounds based on the state diff vs. prevPlayerState.
function revealAt(r, c) {
	lastActionCell = { r: r, c: c };
	var result = applyLocalLeftClick(r, c);
	if (result.anyChange) {
		queueRevealAnimations(myState);
		prevPlayerState = cloneState(myState);
	}
	return result;
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
	// Reuse the same gate as click handling — keep the modes-list defined
	// once so adding a new mode (puzzle, future Streak/Storm, …) doesn't
	// have to update both call sites independently.
	if (!currentActionMode()) return;
	var tag = (e.target && e.target.tagName) || "";
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	// Don't move the board / reveal while a keyboard button-group (puzzle fail actions, result panels)
	// has focus — its own arrow-nav + native Enter own the keys there.
	if (e.target && e.target.closest && e.target.closest(".kbd-btn-group")) return;
	if (e.ctrlKey || e.metaKey || e.altKey) return;
	// Keys are user-rebindable (see Keybindings.js); map the event to an action.
	var action = (typeof keybindings !== "undefined") ? keybindings.actionFor(e) : null;
	if (!action) return;
	var skip = e.shiftKey; // Shift held with movement skips already-revealed cells
	var moved = false;
	if (action === "up") {
		moved = stepFocus(-1, 0, skip);
	} else if (action === "down") {
		moved = stepFocus(1, 0, skip);
	} else if (action === "left") {
		moved = stepFocus(0, -1, skip);
	} else if (action === "right") {
		moved = stepFocus(0, 1, skip);
	} else if (action === "next") {
		e.preventDefault();
		moved = jumpToNextUnknown(!e.shiftKey);
	} else if (action === "reveal") {
		e.preventDefault();
		// Browser key-repeat fires keydown ~30/sec when a key is held; each tick
		// would toggle/re-emit, so reveal/flag are one-press-one-action.
		if (e.repeat) return;
		focusVisible = true;
		performAction(focusedR, focusedC, false);
		return;
	} else if (action === "flag") {
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

// Cell size derived live from the canvas (same source as the renderer/highlight) so hit-testing stays
// correct after the canvas is resized, instead of a cached copy that can drift.
function getRow(y) { return Math.floor(y / (playerCanvas.height / rows)); }
function getCol(x) { return Math.floor(x / (playerCanvas.width / cols)); }
