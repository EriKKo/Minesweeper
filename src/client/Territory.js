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
	for (var r = 0; r < R; r++) territoryOwnerColors.push(new Array(C).fill(null));

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
	if (typeof hideReadyButton === "function") hideReadyButton();
	territoryEnsureHud();
	territoryRenderHud();
	countDown(data.time || 3);
}

function territoryBoard(data) {
	if (!territoryInfo) return;
	territoryInfo.started = true;
	territoryInfo.playing = data.playing;
	territoryInfo.scores = data.scores || {};
	territoryInfo.deadline = data.roundDeadline || null;

	var R = rows, C = cols;
	// Translate the shared state + owner grids into the board's myState + tint grid.
	var newState = [];
	for (var r = 0; r < R; r++) {
		newState.push(new Array(C));
		for (var c = 0; c < C; c++) {
			newState[r][c] = data.state[r][c];
			var o = data.owner[r][c];
			territoryOwnerColors[r][c] = o == null ? null : territoryColorHex(territoryColorOf(o));
		}
	}
	myState = newState;
	// Animate newly-claimed cells (queueRevealAnimations diffs against prevPlayerState, then we
	// snapshot). On the first board prevPlayerState is null, so the start cascades animate in.
	queueRevealAnimations(newState);
	prevPlayerState = cloneState(newState);
	renderPlayerBoard();

	// Freeze: reuse the shared frozenUntil + freeze visuals.
	var fz = (data.frozenUntil && data.frozenUntil[territoryInfo.myId]) || 0;
	if (fz > Date.now()) { frozenUntil = fz; if (typeof startFreezeTick === "function") startFreezeTick(); }
	else { clearFreeze(); }

	territoryRenderHud();
}

function territoryResult(data) {
	territoryActive = false;
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
	var ov = document.getElementById("territory_result_overlay");
	if (ov) ov.remove();
	var gv = document.getElementById("game_view");
	if (gv) gv.classList.remove("territory");
	var hud = document.getElementById("territory_hud");
	if (hud) hud.remove();
	territoryOwnerColors = null;
	territoryInfo = null;
	if (typeof socket !== "undefined") socket.emit("leave_room");
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
