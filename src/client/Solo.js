// Solo (single-player "Free play") mode.
//
// The user picks a board size from the Practice menu and plays a generated
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
// mode; these hooks plug in the solo-specific bits — start the timer on
// first click, detect win/lose locally since there's no server-authoritative
// game.win / game.mineHit callback.
function soloOnBeforeAction() {
	if (!soloSession || soloSession.finished) return;
	if (!soloSession.startTime) {
		soloSession.startTime = Date.now();
		startSoloTimer();
	}
}

function soloOnAfterReveal(result) {
	if (!soloSession || soloSession.finished) return;
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
		showSoloOutcome(true);
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
	enterGameFullscreen();
	soloSelectedSize = size || soloSelectedSize || "medium";
	socket.emit("request_solo_board", { size: soloSelectedSize, density: soloSelectedDensity });
}

function exitSolo() {
	exitGameFullscreen();
	soloSession = null;
	stopSoloTimer();
	hideOverlay();
	myState = null;
	prevPlayerState = null;
	boardDecoder = null;
	// Solo lives at /practice. navigate() routes even when the path is unchanged, so calling it
	// unconditionally drives the view and keeps the URL in sync.
	navigate("/practice");
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
	var timerEl = document.getElementById("solo_timer");
	var minesEl = document.getElementById("solo_mines");
	if (timerEl) {
		var elapsed = soloSession.startTime
			? (soloSession.finishTime || Date.now()) - soloSession.startTime
			: 0;
		timerEl.textContent = formatSoloTime(elapsed);
	}
	if (minesEl) {
		var flagged = 0;
		if (myState) for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
			if (myState[r][c] === FLAGGED) flagged++;
		}
		minesEl.textContent = flagged + " / " + soloSession.totalMines;
	}
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
