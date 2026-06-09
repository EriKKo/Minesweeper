// Client for the 2-player Territory (versus) mode.
//
// Territory reuses the SAME board widget as the racing/solo/puzzle modes — the #game0 canvas,
// renderPlayerBoard/drawCell, and Input.js's performAction pipeline — so keyboard focus, the
// key-repeat guard, right-click preventDefault and hit-testing all behave identically and we don't
// reimplement (and re-break) them. The only additions are: a per-cell owner tint (drawCell reads
// `view.getOwner`, fed by the global `territoryOwnerColors` grid), a "territory" action mode in
// Input (server-authoritative — emit, no optimistic reveal), and a small territory HUD.
//
// State arrives via territory_start / territory_board / territory_result (forwarded from the inline
// socket handlers in index.html). Globals territoryActive / territoryOwnerColors are read by
// Input.currentActionMode and Animations.makeLiveView respectively.

var territoryActive = false;          // Input.currentActionMode → "territory" while true
var territoryOwnerColors = null;      // [r][c] -> owner colour hex (or null) for drawCell tint
var territoryInfo = null;             // { myId, players, colorOf, started, playing, scores, deadline }
var territoryFlags = null;            // [r][c] -> bool, local-only "suspected mine" marks (not shared/scored)

function territoryColorHex(color) { return color === "amber" ? "#fb923c" : "#22d3ee"; }

function territoryColorOf(pid) {
	var p = territoryInfo && territoryInfo.players.filter(function(x) { return x.id === pid; })[0];
	return p ? p.color : "cyan";
}

// Build / fetch the HUD that sits above the shared board in game_view.
function territoryEnsureHud() {
	var hud = document.getElementById("territory_hud");
	if (hud) return hud;
	var left = document.querySelector("#game_view .game-left");
	if (!left) return null;
	hud = document.createElement("div");
	hud.id = "territory_hud";
	hud.className = "tv-hud";
	hud.innerHTML =
		'<div class="tv-chip" id="tv_chip0"></div>' +
		'<div class="tv-bar"><div class="tv-bar-fill" id="tv_bar0"></div><div class="tv-bar-fill" id="tv_bar1"></div></div>' +
		'<div class="tv-chip" id="tv_chip1"></div>';
	left.insertBefore(hud, left.firstChild);
	return hud;
}

function territoryStart(data) {
	var R = data.rows, C = data.cols;
	territoryInfo = { myId: data.you, players: data.players, started: false, playing: true, scores: {}, deadline: null, total: R * C };
	territoryActive = true;
	territoryOwnerColors = [];
	territoryFlags = [];
	for (var r = 0; r < R; r++) { territoryOwnerColors.push(new Array(C).fill(null)); territoryFlags.push(new Array(C).fill(false)); }

	// Set up the shared board exactly like a normal round start.
	applyBoardDims(R, C);
	if (data.boardData && data.boardMask) installBoardDecoder(data.boardData, data.boardMask, R, C);
	myState = null;
	prevPlayerState = null;
	resetBoardAnimations();
	clearFreeze();
	// Focus a sensible starting cell (the player's own corner) for keyboard play.
	var myStart = (data.starts && data.players[0] && data.players[0].id === data.you) ? data.starts[0] : (data.starts ? data.starts[1] : [0, 0]);
	focusedR = myStart ? myStart[0] : 0;
	focusedC = myStart ? myStart[1] : 0;
	focusVisible = false;

	showGameView();
	var gv = document.getElementById("game_view");
	if (gv) gv.classList.add("territory");
	document.body.classList.add("territory-fullscreen");
	if (typeof hideReadyButton === "function") hideReadyButton();
	territoryEnsureHud();
	territoryRenderHud();
	countDown(data.time || 3);
	// Re-fit the board now that the .territory single-column layout is applied (applyBoardDims
	// sized it against the racing layout / may have early-returned on unchanged dims).
	requestAnimationFrame(sizeTerritoryBoard);
}

// Size the shared canvas to fill the territory board area (reuses the fit-to-space sizing), then
// recompute the hit-test cell size and repaint. Also run on window resize via the shared handler.
function sizeTerritoryBoard() {
	if (!territoryActive || typeof sizePlayerCanvas !== "function") return;
	sizePlayerCanvas();
	playerCanvasWidth = playerCanvas.width;
	playerCanvasHeight = playerCanvas.height;
	playerCanvasSquareWidth = playerCanvasWidth / cols;
	playerCanvasSquareHeight = playerCanvasHeight / rows;
	if (typeof renderPlayerBoard === "function") renderPlayerBoard();
}

function territoryBoard(data) {
	if (!territoryInfo) return;
	territoryInfo.started = true;
	territoryInfo.playing = data.playing;
	territoryInfo.scores = data.scores || {};
	territoryInfo.deadline = data.roundDeadline || null;

	// A mine explosion re-generated a patch: patch the client's board clues so the re-covered cells
	// re-reveal with their NEW values, note the origin for the reverse-cascade animation, and clear
	// any local flags in the affected area (the old layout they marked no longer holds).
	if (data.explosion) {
		if (typeof patchBoardCells === "function") patchBoardCells(data.explosion.clues);
		if (territoryFlags) for (var ek in data.explosion.clues) { var ep = ek.split(","); territoryFlags[+ep[0]][+ep[1]] = false; }
	}

	// Cells the server re-covered this tick (only an explosion does this). Used both to allow an
	// authoritative un-reveal and to drive the reverse-cascade animation.
	var recovered = (data.explosion && data.explosion.recovered) || [];
	var recoveredSet = {};
	for (var i = 0; i < recovered.length; i++) recoveredSet[recovered[i][0] + "," + recovered[i][1]] = true;

	var R = rows, C = cols;
	// Translate the shared state + owner grids into the board's myState + tint grid, MERGING with the
	// local prediction: a cell we already revealed is never un-revealed by a server board unless an
	// explosion actually re-covered it. Otherwise a broadcast that races ahead of our own reveal's echo
	// (e.g. the opponent moving) would briefly revert our just-revealed cells — a flicker.
	var newState = [];
	for (var r = 0; r < R; r++) {
		newState.push(new Array(C));
		for (var c = 0; c < C; c++) {
			var s = data.state[r][c];
			var o = data.owner[r][c];
			if (s === UNKNOWN && myState && myState[r][c] === KNOWN && !recoveredSet[r + "," + c]) {
				s = KNOWN;                                  // keep our predicted reveal (server just hasn't echoed it yet)
				if (o == null) o = territoryInfo.myId;      // we predicted it ours
			}
			territoryOwnerColors[r][c] = o == null ? null : territoryColorHex(territoryColorOf(o));
			// A claimed cell can't stay flagged; otherwise re-apply the local flag mark so the
			// server's state broadcast doesn't wipe it (flags are client-only in territory).
			if (s === KNOWN) territoryFlags[r][c] = false;
			else if (territoryFlags[r][c]) s = FLAGGED;
			newState[r][c] = s;
		}
	}
	myState = newState;
	// Animate newly-claimed cells (queueRevealAnimations diffs against prevPlayerState, then we
	// snapshot). On the first board prevPlayerState is null, so the start cascades animate in.
	queueRevealAnimations(newState);
	// Reverse cascade: animate exactly the cells the server re-covered (the exploder's territory),
	// staggered outward from the blast origin — never inferred from a diff, so a rolled-back local
	// prediction can't trigger a spurious un-reveal. Queued AFTER queueRevealAnimations (which clears
	// anims for now-covered cells) so they aren't wiped.
	if (data.explosion && recovered.length) {
		var origin = data.explosion.origin, now = performance.now(), any = false;
		for (var ri = 0; ri < recovered.length; ri++) {
			var rc = recovered[ri];
			if (newState[rc[0]][rc[1]] !== UNKNOWN) continue;
			cellAnims[rc[0] + "," + rc[1]] = { type: "unreveal", start: now + Math.hypot(rc[0] - origin[0], rc[1] - origin[1]) * 26 };
			any = true;
		}
		if (any && typeof startAnimLoop === "function") startAnimLoop();
	}
	prevPlayerState = cloneState(newState);
	renderPlayerBoard();

	// Freeze: reuse the shared frozenUntil + freeze visuals.
	var fz = (data.frozenUntil && data.frozenUntil[territoryInfo.myId]) || 0;
	if (fz > Date.now()) { frozenUntil = fz; if (typeof startFreezeTick === "function") startFreezeTick(); }
	else { clearFreeze(); }

	territoryRenderHud();
}

function territoryResult(data) {
	// Keep territoryActive true so the final board still shows the territory tints behind the
	// result overlay; it's fully reset by territoryReset() when the player actually leaves.
	if (territoryInfo) territoryInfo.playing = false;
	var mine = data.scores && data.scores.filter(function(s) { return s.id === (territoryInfo && territoryInfo.myId); })[0];
	var win = data.winnerId === (territoryInfo && territoryInfo.myId);
	var head = data.winnerId == null ? "Draw" : (win ? "You win!" : "You lose");
	var detail = (data.scores || []).map(function(s) {
		return '<span style="color:' + territoryColorHex(s.color) + '">' + s.name + ": " + s.score + "</span>";
	}).join(" &nbsp;·&nbsp; ");
	if (data.ranked && mine && typeof mine.ratingDelta === "number") {
		var sign = mine.ratingDelta >= 0 ? "+" : "";
		detail += '<br><span class="tv-elo">Territory rating ' + mine.rating + " (" + sign + mine.ratingDelta + ")</span>";
		if (typeof account !== "undefined" && account) {
			account.ratingTerritory = mine.rating; account.rating = mine.rating;
			account.provisional = !!mine.provisional;
		}
		if (typeof renderHomeRankChips === "function") renderHomeRankChips();
	}
	var wrap = document.querySelector("#game_view .board-wrap");
	if (wrap) {
		var ov = document.getElementById("territory_result_overlay");
		if (!ov) { ov = document.createElement("div"); ov.id = "territory_result_overlay"; ov.className = "tv-result-overlay"; wrap.appendChild(ov); }
		ov.innerHTML = '<div class="tv-result"><h2>' + head + '</h2><p>' + detail + '</p>' +
			'<button class="btn btn-primary" onclick="leaveTerritory()">Back to lobby</button></div>';
		ov.style.display = "";
	}
}

function leaveTerritory() {
	territoryReset();
	if (typeof socket !== "undefined") socket.emit("leave_room");
}

// Tear down ALL territory state + DOM. Called when leaving by any path (the result button, or the
// left_room handler when navigating away) so territoryActive/owner colours can't leak into the
// other modes that share the board (which would break chording and tint their cells).
function territoryReset() {
	territoryActive = false;
	territoryOwnerColors = null;
	territoryFlags = null;
	territoryInfo = null;
	var ov = document.getElementById("territory_result_overlay");
	if (ov) ov.remove();
	var hud = document.getElementById("territory_hud");
	if (hud) hud.remove();
	var gv = document.getElementById("game_view");
	if (gv) gv.classList.remove("territory");
	document.body.classList.remove("territory-fullscreen");
}

// Client-side contiguity check, mirroring the server's g.canReveal: a covered cell 8-adjacent to one
// of my own cells. Lets us predict a reveal locally instead of waiting for the server round-trip.
function territoryCanReveal(r, c) {
	if (!myState || !territoryOwnerColors || myState[r][c] !== UNKNOWN) return false;
	var mine = territoryColorHex(territoryColorOf(territoryInfo.myId));
	for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) {
		if (!dr && !dc) continue;
		var nr = r + dr, nc = c + dc;
		if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && territoryOwnerColors[nr][nc] === mine) return true;
	}
	return false;
}

// Optimistic local reveal: the client knows the decoded board, so it predicts a safe reveal + cascade
// exactly as the server will, claims the cells for me, and animates immediately — no waiting on the
// round-trip. Mines are NOT predicted (the server owns the explosion/regen); enclosure capture and the
// opponent's moves arrive on the authoritative territory_board, which reconciles the whole grid. A move
// the server ends up rejecting is simply overwritten by the next board. Returns true if it revealed.
function territoryLocalReveal(r, c) {
	if (!territoryActive || !myState) return false;
	if (myState[r][c] !== UNKNOWN) return false;          // covered cells only (FLAGGED is protected upstream)
	if (boardCell(r, c) === MINE) return false;           // let the server compute the explosion
	if (!territoryCanReveal(r, c)) return false;          // must touch my own territory
	var mine = territoryColorHex(territoryColorOf(territoryInfo.myId));
	var revealed = [];
	BoardLogic.cascadeReveal(r, c, rows, cols,
		function(rr, cc) { return myState[rr][cc] === UNKNOWN && boardCell(rr, cc) !== MINE; },
		function(rr, cc) { myState[rr][cc] = KNOWN; territoryOwnerColors[rr][cc] = mine; territoryFlags[rr][cc] = false; revealed.push([rr, cc]); return false; },
		function(rr, cc) { return boardCell(rr, cc); });
	if (!revealed.length) return false;
	lastActionCell = { r: r, c: c };
	queueRevealAnimations(myState);
	prevPlayerState = cloneState(myState);                // so the matching server board doesn't re-animate these
	return true;
}

// Toggle a local "suspected mine" flag on a covered cell (client-only — not sent to the server,
// not scored). Reuses the shared flag animation + sounds so it looks identical to the other modes.
function territoryToggleFlag(r, c) {
	if (!myState || !territoryFlags || myState[r][c] === KNOWN) return;
	territoryFlags[r][c] = !territoryFlags[r][c];
	var key = r + "," + c;
	if (territoryFlags[r][c]) {
		myState[r][c] = FLAGGED;
		cellAnims[key] = { type: "flag", start: performance.now() };
		if (typeof sound !== "undefined" && sound.flag) sound.flag();
		startAnimLoop();
	} else {
		myState[r][c] = UNKNOWN;
		delete cellAnims[key];
		if (typeof sound !== "undefined" && sound.unflag) sound.unflag();
	}
	// Mirror the change into prevPlayerState so the next territory_board diff doesn't see a phantom
	// flag transition and re-play the flag-pop (which starts at scale 0, making the flag blink out
	// once). Flags are client-only, so the server's broadcast never carries them.
	if (prevPlayerState) prevPlayerState[r][c] = myState[r][c];
}

function territoryRenderHud() {
	var info = territoryInfo;
	if (!info) return;
	for (var i = 0; i < info.players.length; i++) {
		var p = info.players[i];
		var sc = (info.scores && info.scores[p.id]) || 0;
		var chip = document.getElementById("tv_chip" + i);
		if (chip) {
			chip.innerHTML = '<span class="tv-swatch" style="background:' + territoryColorHex(p.color) + '"></span>' +
				'<span class="tv-name">' + p.name + (p.id === info.myId ? " (you)" : "") + '</span>' +
				'<span class="tv-score">' + sc + '</span>';
		}
		var bar = document.getElementById("tv_bar" + i);
		if (bar) { bar.style.width = (100 * sc / info.total) + "%"; bar.style.background = territoryColorHex(p.color); }
	}
}
