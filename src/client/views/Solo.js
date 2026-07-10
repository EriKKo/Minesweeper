// Solo (single-player "Free play") mode.
//
// The user picks a board size + mine density from the Solo page and plays a generated
// no-guess board offline — no socket, no opponents, just timer + win/lose.
// Loaded as a separate <script> tag; it shares a small set of globals with
// the main inline script (myState, cellAnims, focused R/C, board dims, the
// sound helper, redrawOwnBoardWithFocus). Those are populated by the server
// at room-start; for solo we initialise them locally inside startSolo.

var soloSession = null;        // { size, totalSafe, totalMines, startTime, finished, finishTime } when in single-player Free play
var soloTimerHandle = null;
var soloSelectedSize = "medium";
var soloSelectedDensity = 0.10; // Low; Medium = 0.15, High = 0.20

// Solo mode hooks. performAction (in Input.js) drives the board for every
// mode; these hooks plug in the solo-specific bits — start the timer on the
// first real move, detect win/lose locally since there's no server-authoritative
// game.win / game.mineHit callback.
//
// The timer starts on the first move that actually does something — a reveal/chord
// that changes the board, or placing a flag — NOT on a no-op click (e.g. clicking
// an already-revealed cell to position the cursor). soloOnAfterReveal and the flag
// branch in Input.js call this; it's a no-op once the clock is running.
function soloStartTimerOnce() {
	if (!soloSession || soloSession.finished) return;
	if (!soloSession.startTime) {
		soloSession.startTime = Date.now();
		startSoloTimer();
	}
}

function soloOnAfterReveal(result) {
	if (!soloSession || soloSession.finished) return;
	// A reveal/chord only counts as the first move if it actually changed the board.
	if (result && (result.anyChange || result.hitMine)) soloStartTimerOnce();
	if (result.hitMine) {
		soloSession.finished = true;
		soloSession.finishTime = Date.now();
		stopSoloTimer();
		triggerShake && triggerShake();
		showSoloOutcome(false);
		return;
	}
	if (countSoloSafeRevealed() >= soloSession.totalSafe) {
		soloSession.finished = true;
		soloSession.finishTime = Date.now();
		stopSoloTimer();
		sound.win && sound.win();
		submitSoloResult();
		if (typeof reportClear === "function") reportClear(); // no-flag / chord-only challenge
		showSoloOutcome(true);
	}
}

// --- Free-play best times, per (board size, mine density) ---------------------------------------
function soloComboKey(size, density) { return size + "_" + Math.round((density || 0) * 100); }
function soloBestFor(size, density) {
	var bests = (typeof account !== "undefined" && account && account.soloBests) || null;
	return bests ? bests[soloComboKey(size, density)] : null;
}
// Reflect the best time for the CURRENTLY selected size+density on the in-game
// sidebar (#solo_best).
function updateSoloBest() {
	var sidebar = document.getElementById("solo_best");
	if (!sidebar) return;
	var b = soloBestFor(soloSelectedSize, soloSelectedDensity);
	sidebar.textContent = b ? formatSoloTime(b) : "—";
}

// Sync the in-game sidebar's size/density buttons to the current selection and
// refresh the best-time line. Called whenever a board starts, so the sidebar
// reflects the size/density actually in play.
function syncSoloControls() {
	function sync(els, attr, val, parse) {
		for (var i = 0; i < els.length; i++) {
			var a = els[i].getAttribute(attr);
			els[i].classList.toggle("active", (parse ? parseFloat(a) : a) === val);
		}
	}
	sync(document.querySelectorAll(".solo-size-btn"), "data-size", soloSelectedSize, false);
	sync(document.querySelectorAll(".solo-density-btn"), "data-density", soloSelectedDensity, true);
	updateSoloBest();
}
// Report a clear to the server, which records it as a best for this combo if it's faster.
function submitSoloResult() {
	if (!soloSession || !soloSession.startTime || typeof socket === "undefined") return;
	var ms = (soloSession.finishTime || Date.now()) - soloSession.startTime;
	socket.emit("solo_result", { size: soloSession.size, density: soloSession.density, ms: ms });
}
// Server's reply: if the open outcome panel is showing, mark a new record / show the standing best.
function onSoloRecord(data) {
	var line = document.querySelector(".solo-best-line");
	if (!line) return;
	if (data.isNewBest) {
		line.textContent = "★ New best!";
		line.classList.add("solo-best-new");
	} else {
		line.textContent = "Best: " + formatSoloTime(data.best);
	}
}

function countSoloSafeRevealed() {
	var n = 0;
	for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
		if (myState[r][c] === KNOWN && boardCell(r, c) !== MINE) n++;
	}
	return n;
}

function startSolo(size) {
	autoEnterGameFullscreen();
	soloSelectedSize = size || soloSelectedSize || "medium";
	syncSoloControls();
	socket.emit("request_solo_board", { size: soloSelectedSize, density: soloSelectedDensity });
}

// --- Pre-game Start gate + countdown ---------------------------------------------------------
// A solo board loads in a not-started state: the board is covered, input is blocked
// (Input.js gates on soloSession.started), and a Start button sits over the board.
// Clicking it runs the 3-2-1-GO countdown, then unlocks the board. The clock still
// starts on the first real move (soloStartTimerOnce), so the countdown is just the
// "get ready" ritual.
function showSoloStart() {
	var ov = document.getElementById("solo_start_overlay");
	if (ov) ov.style.display = "";
}
function hideSoloStart() {
	var ov = document.getElementById("solo_start_overlay");
	if (ov) ov.style.display = "none";
}
function beginSolo() {
	if (!soloSession || soloSession.started) return;
	hideSoloStart();
	var session = soloSession; // guard against a new board replacing it mid-countdown/pause
	// Same "ready to start, before the countdown" trigger as a real match's start_game handler
	// (Main.js) — see startBoardGoAnimation in Animations.js. Then a beat of plain blue
	// (boardGoTotalMs) before the countdown actually starts, so the digit doesn't pop in over the
	// sweep or cut it off.
	if (typeof startBoardGoAnimation === "function") {
		startBoardGoAnimation(rows, cols);
		setTimeout(function() {
			if (soloSession !== session) return;
			countDown(3, function() { if (soloSession === session) soloSession.started = true; });
		}, boardGoTotalMs());
	} else {
		countDown(3, function() { if (soloSession === session) soloSession.started = true; });
	}
}

function exitSolo() {
	exitGameFullscreen();
	soloSession = null;
	stopSoloTimer();
	hideOverlay();
	myState = null;
	prevPlayerState = null;
	boardDecoder = null;
	// Solo drops straight into a board, so /solo itself starts a new game. Exit goes
	// home instead (navigating back to /solo would immediately re-launch a board).
	navigate("/");
}

function startSoloTimer() {
	stopSoloTimer();
	soloTimerHandle = setInterval(updateSoloHud, 100);
}

function stopSoloTimer() {
	if (soloTimerHandle) { clearInterval(soloTimerHandle); soloTimerHandle = null; }
}

function formatSoloTime(ms) {
	if (ms == null || ms < 0) ms = 0;
	var totalSec = ms / 1000;
	var m = Math.floor(totalSec / 60);
	var s = totalSec - m * 60;
	return m + ":" + (s < 10 ? "0" : "") + s.toFixed(s >= 10 || m > 0 ? 1 : 2).slice(0, s >= 10 || m > 0 ? 4 : 5);
}

function updateSoloHud() {
	if (!soloSession) return;
	var elapsed = soloSession.startTime
		? (soloSession.finishTime || Date.now()) - soloSession.startTime
		: 0;
	var timeStr = formatSoloTime(elapsed);
	var flagged = 0;
	if (myState) for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
		if (myState[r][c] === FLAGGED) flagged++;
	}
	var minesStr = flagged + " / " + soloSession.totalMines;
	var timerEl = document.getElementById("solo_timer");
	var minesEl = document.getElementById("solo_mines");
	if (timerEl) timerEl.textContent = timeStr;
	if (minesEl) minesEl.textContent = minesStr;
	var mobileTimer = document.getElementById("mobile_solo_timer");
	var mobileMines = document.getElementById("mobile_solo_mines");
	if (mobileTimer) mobileTimer.textContent = timeStr;
	if (mobileMines) mobileMines.textContent = minesStr + " mines";
}

function showSoloOutcome(won) {
	var panel = document.createElement("div");
	panel.className = "result-panel";

	var header = document.createElement("div");
	header.className = "result-header";
	header.textContent = won ? "Cleared!" : "Mine hit";
	panel.appendChild(header);

	var time = document.createElement("div");
	time.className = "tournament-place";
	time.style.color = won ? "#4ade80" : "#f87171";
	var elapsed = (soloSession.finishTime || Date.now()) - (soloSession.startTime || soloSession.finishTime || Date.now());
	time.textContent = formatSoloTime(elapsed);
	panel.appendChild(time);

	if (won) {
		// Shows the standing best (pre-clear); onSoloRecord upgrades it to "★ New best!" if this beat it.
		var bestLine = document.createElement("div");
		bestLine.className = "solo-best-line";
		var prev = soloBestFor(soloSession.size, soloSession.density);
		bestLine.textContent = prev ? "Best: " + formatSoloTime(prev) : "";
		panel.appendChild(bestLine);
	}

	if (!won) {
		var sub = document.createElement("div");
		sub.className = "result-foot";
		var safe = countSoloSafeRevealed();
		sub.textContent = "Revealed " + safe + " of " + soloSession.totalSafe + " safe cells.";
		panel.appendChild(sub);
	}

	var actions = document.createElement("div");
	actions.className = "result-actions";

	var again = document.createElement("button");
	again.className = "btn btn-primary";
	again.textContent = "New board";
	again.addEventListener("click", function() {
		hideOverlay();
		startSolo(soloSelectedSize);
	});
	actions.appendChild(again);

	var back = document.createElement("button");
	back.className = "btn btn-secondary";
	back.textContent = "Back to Practice";
	back.addEventListener("click", exitSolo);
	actions.appendChild(back);

	panel.appendChild(actions);
	presentPanel(panel, won ? "win" : "lose");
}

function toggleSoloChrome(on) {
	// Show solo info card; hide multiplayer side cards. Re-shown when leaving solo.
	var soloCard = document.getElementById("solo_card");
	if (soloCard) soloCard.style.display = on ? "" : "none";
	if (allOpponentsDiv) allOpponentsDiv.style.display = on ? "none" : "";
	var scoreboardCard = document.getElementById("scoreboard_card");
	if (scoreboardCard) scoreboardCard.style.display = on ? "none" : "";
	if (seriesCard) seriesCard.style.display = on ? "none" : "";
	if (botsCard) botsCard.style.display = on ? "none" : "";
	var rankedTagEl = document.getElementById("ranked_tag");
	if (rankedTagEl) rankedTagEl.style.display = "none";
	if (gameProgressText) gameProgressText.textContent = on ? "Free play" : "";
	var roundTimerEl = document.getElementById("round_timer");
	if (roundTimerEl) roundTimerEl.style.display = on ? "none" : "";
	if (readyButton) readyButton.style.display = on ? "none" : "";
}
