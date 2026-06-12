// Board overlay banner + the round-start countdown.
//
// showOverlay / hideOverlay paint the centered text card over the player's
// own board (Cleared, Frozen, Eliminated, …). countDown / countDownStep play
// the GO\! sequence and recurse until 0.
//
// Plus a couple of tiny shared helpers (clearCanvas, hideReadyButton).

// Countdown overlay colours.
var COUNT_DOWN_COLORS = ["#facc15", "#fb923c", "#f87171"];

function showOverlay(text, kind, autoHideMs) {
	boardOverlay.style.display = "";
	boardOverlay.textContent = text;
	boardOverlay.className = "board-overlay" + (kind ? " board-overlay-" + kind : "");
	if (autoHideMs) {
		setTimeout(function() {
			if (boardOverlay.textContent === text) hideOverlay();
		}, autoHideMs);
	}
}

function hideOverlay() {
	boardOverlay.style.display = "none";
	boardOverlay.textContent = "";
	boardOverlay.className = "board-overlay";
}


function clearCanvas(canvas) {
	var ctx = canvas.getContext("2d");
	ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function hideReadyButton() {
	readyButton.style.display = "none";
}

function countDown(time) {
	countDownStep(time);
}

function countDownStep(number) {
	if (number <= 0) {
		showOverlay("GO", "go");
		sound.go();
		roundStartTime = Date.now(); // danger-warning grace period starts here
		setTimeout(function() {
			if (boardOverlay.textContent === "GO") hideOverlay();
		}, 700);
		return;
	}
	showOverlay(String(number), "count");
	boardOverlay.style.color = number <= COUNT_DOWN_COLORS.length ? COUNT_DOWN_COLORS[number - 1] : "#94a3b8";
	sound.beep(392 + (3 - Math.min(number, 3)) * 110);
	setTimeout(function() { countDownStep(number - 1); }, 1000);
}
