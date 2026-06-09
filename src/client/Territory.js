// Client for the 2-player Territory (versus) mode.
//
// One shared board both players grow into from opposite corners; each player's claimed cells get
// a subtle background tint (cyan vs amber). Server-authoritative: a click just emits left_click
// and the server's territory_board broadcast drives all rendering. The inline socket handlers in
// index.html forward territory_start / territory_board / territory_result to the functions here.

var territoryState = null;

// Subtle per-owner tints that fit the dark palette; solid variants for the HUD.
function territoryTint(color) { return color === "amber" ? "rgba(251,146,60,0.16)" : "rgba(34,211,238,0.16)"; }
function territorySolid(color) { return color === "amber" ? "#fb923c" : "#22d3ee"; }

var TERRITORY_NUMBER_COLORS = { 1: "#60a5fa", 2: "#4ade80", 3: "#f87171", 4: "#c084fc", 5: "#fbbf24", 6: "#22d3ee", 7: "#f9a8d4", 8: "#e2e8f0" };

// Decode the obfuscated board blob (XOR of clue bytes; 9 marks a mine) into a clue grid.
function territoryDecode(boardData, boardMask, rows, cols) {
	var bytes = Uint8Array.from(atob(boardData), function(ch) { return ch.charCodeAt(0); });
	var mask = Uint8Array.from(atob(boardMask), function(ch) { return ch.charCodeAt(0); });
	var grid = [];
	for (var r = 0; r < rows; r++) {
		grid.push(new Array(cols));
		for (var c = 0; c < cols; c++) {
			var v = bytes[r * cols + c] ^ mask[(r * cols + c) % mask.length];
			grid[r][c] = v === 9 ? -1 : v;
		}
	}
	return grid;
}

function territoryColorOf(pid) {
	var s = territoryState;
	if (!s) return "cyan";
	for (var i = 0; i < s.players.length; i++) if (s.players[i].id === pid) return s.players[i].color;
	return "cyan";
}

function ensureTerritoryDom() {
	var view = document.getElementById("territory_view");
	if (view.dataset.built) return;
	view.dataset.built = "1";
	view.innerHTML =
		'<div class="tv-hud">' +
		'  <div class="tv-chip" id="tv_chip0"></div>' +
		'  <div class="tv-bar"><div class="tv-bar-fill" id="tv_bar0"></div><div class="tv-bar-fill" id="tv_bar1"></div></div>' +
		'  <div class="tv-chip" id="tv_chip1"></div>' +
		'</div>' +
		'<div class="tv-board-wrap"><canvas id="tv_canvas"></canvas><div class="tv-overlay" id="tv_overlay"></div></div>' +
		'<p class="tv-status" id="tv_status"></p>';
	var cv = document.getElementById("tv_canvas");
	cv.addEventListener("click", territoryOnClick);
}

function showTerritoryView() {
	hideAllViews();
	document.getElementById("territory_view").style.display = "";
	setSiteNavActive("");
}

function territoryStart(data) {
	ensureTerritoryDom();
	territoryState = {
		rows: data.rows, cols: data.cols,
		board: territoryDecode(data.boardData, data.boardMask, data.rows, data.cols),
		players: data.players, myId: data.you,
		state: null, owner: null, scores: {}, frozenUntil: {}, playing: true, started: false,
		roundDeadline: null
	};
	showTerritoryView();
	territoryRenderHud();
	territoryCountdown(data.time || 3);
	territoryResizeAndPaint();
	if (!territoryTicker) territoryTicker = setInterval(territoryTick, 250);
}

function territoryBoard(data) {
	if (!territoryState) return;
	territoryState.state = data.state;
	territoryState.owner = data.owner;
	territoryState.scores = data.scores || {};
	territoryState.frozenUntil = data.frozenUntil || {};
	territoryState.playing = data.playing;
	territoryState.started = true;
	territoryState.roundDeadline = data.roundDeadline || null;
	var ov = document.getElementById("tv_overlay");
	if (ov && ov.dataset.mode === "countdown") { ov.style.display = "none"; ov.dataset.mode = ""; }
	territoryRenderHud();
	territoryResizeAndPaint();
}

function territoryResult(data) {
	if (!territoryState) return;
	var ov = document.getElementById("tv_overlay");
	var mine = data.scores && data.scores.filter(function(s) { return s.id === territoryState.myId; })[0];
	var win = data.winnerId === territoryState.myId;
	var head = data.winnerId == null ? "Draw" : (win ? "You win!" : "You lose");
	var detail = (data.scores || []).map(function(s) {
		return '<span style="color:' + territorySolid(s.color) + '">' + s.name + ": " + s.score + "</span>";
	}).join(" &nbsp;·&nbsp; ");
	if (ov) {
		ov.dataset.mode = "result";
		ov.innerHTML = '<div class="tv-result"><h2>' + head + '</h2><p>' + detail + '</p>' +
			'<button class="btn btn-primary" onclick="leaveTerritory()">Back to lobby</button></div>';
		ov.style.display = "";
	}
	territoryState.playing = false;
}

function leaveTerritory() {
	// Server already flipped the room back to planning; just show the room lobby.
	if (typeof showGameView === "function") showGameView();
}

function territoryCountdown(secs) {
	var ov = document.getElementById("tv_overlay");
	if (!ov) return;
	ov.dataset.mode = "countdown";
	ov.style.display = "";
	var n = secs;
	function step() {
		if (!territoryState || territoryState.started) { ov.style.display = "none"; ov.dataset.mode = ""; return; }
		ov.innerHTML = '<div class="tv-count">' + (n > 0 ? n : "Go!") + "</div>";
		if (n <= 0) { setTimeout(function() { if (ov.dataset.mode === "countdown") { ov.style.display = "none"; ov.dataset.mode = ""; } }, 500); return; }
		n--; setTimeout(step, 1000);
	}
	step();
}

var territoryTicker = null;
function territoryTick() {
	if (!territoryState || document.getElementById("territory_view").style.display === "none") {
		if (territoryTicker) { clearInterval(territoryTicker); territoryTicker = null; }
		return;
	}
	territoryRenderHud();
	// Repaint so the freeze veil appears/clears as the clock crosses frozenUntil.
	territoryPaint();
}

function territoryFrozen() {
	var s = territoryState;
	return s && s.frozenUntil && Date.now() < (s.frozenUntil[s.myId] || 0);
}

function territoryRenderHud() {
	var s = territoryState;
	if (!s) return;
	var total = s.rows * s.cols;
	for (var i = 0; i < s.players.length; i++) {
		var p = s.players[i];
		var sc = (s.scores && s.scores[p.id]) || 0;
		var chip = document.getElementById("tv_chip" + i);
		if (chip) {
			var meTag = p.id === s.myId ? " (you)" : "";
			chip.innerHTML = '<span class="tv-swatch" style="background:' + territorySolid(p.color) + '"></span>' +
				'<span class="tv-name">' + p.name + meTag + '</span><span class="tv-score">' + sc + "</span>";
		}
		var bar = document.getElementById("tv_bar" + i);
		if (bar) { bar.style.width = (100 * sc / total) + "%"; bar.style.background = territorySolid(p.color); }
	}
	var status = document.getElementById("tv_status");
	if (status) {
		var bits = [];
		if (territoryFrozen()) bits.push("FROZEN " + Math.ceil((s.frozenUntil[s.myId] - Date.now()) / 1000) + "s");
		if (s.roundDeadline) { var left = Math.max(0, Math.ceil((s.roundDeadline - Date.now()) / 1000)); bits.push(left + "s left"); }
		bits.push("Clear cells adjacent to your colour. Avoid mines.");
		status.textContent = bits.join("  ·  ");
	}
}

var TV_CELL = 30;
function territoryResizeAndPaint() {
	var s = territoryState; if (!s) return;
	var cv = document.getElementById("tv_canvas"); if (!cv) return;
	var avail = Math.min(560, (window.innerWidth || 800) - 48);
	TV_CELL = Math.max(16, Math.floor(avail / s.cols));
	var dpr = window.devicePixelRatio || 1;
	cv.width = s.cols * TV_CELL * dpr; cv.height = s.rows * TV_CELL * dpr;
	cv.style.width = (s.cols * TV_CELL) + "px"; cv.style.height = (s.rows * TV_CELL) + "px";
	var ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	territoryPaint();
}

function territoryPaint() {
	var s = territoryState; if (!s) return;
	var cv = document.getElementById("tv_canvas"); if (!cv) return;
	var ctx = cv.getContext("2d");
	var n = TV_CELL, frozen = territoryFrozen();
	for (var r = 0; r < s.rows; r++) {
		for (var c = 0; c < s.cols; c++) {
			var x = c * n, y = r * n;
			var ownerId = s.owner ? s.owner[r][c] : null;
			if (ownerId == null) {
				ctx.fillStyle = "#2b3c63"; ctx.fillRect(x + 1, y + 1, n - 2, n - 2);   // covered tile
				ctx.fillStyle = "#1b2742"; ctx.fillRect(x + 1, y + n - 4, n - 2, 3);   // bottom bevel
			} else {
				ctx.fillStyle = "#162033"; ctx.fillRect(x, y, n, n);
				ctx.fillStyle = territoryTint(territoryColorOf(ownerId)); ctx.fillRect(x, y, n, n);
				ctx.strokeStyle = "#0b1220"; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, n - 1, n - 1);
				var clue = s.board[r][c];
				if (clue > 0) {
					ctx.fillStyle = TERRITORY_NUMBER_COLORS[clue] || "#e2e8f0";
					ctx.font = "bold " + Math.floor(n * 0.55) + "px sans-serif";
					ctx.textAlign = "center"; ctx.textBaseline = "middle";
					ctx.fillText(String(clue), x + n / 2, y + n / 2 + 1);
				}
			}
		}
	}
	if (frozen) { ctx.fillStyle = "rgba(120,150,255,0.12)"; ctx.fillRect(0, 0, s.cols * n, s.rows * n); }
}

function territoryOnClick(e) {
	var s = territoryState;
	if (!s || !s.started || !s.playing || territoryFrozen()) return;
	var cv = document.getElementById("tv_canvas");
	var rect = cv.getBoundingClientRect();
	var c = Math.floor((e.clientX - rect.left) / TV_CELL);
	var r = Math.floor((e.clientY - rect.top) / TV_CELL);
	if (r < 0 || c < 0 || r >= s.rows || c >= s.cols) return;
	socket.emit("left_click", { r: r, c: c, id: s.myId });
}
