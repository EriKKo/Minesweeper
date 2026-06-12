// Round timer + mine-hit freeze ticker.
//
// startRoundTimer counts down the visible "T-12s" header label while the
// round is live. The freeze tick runs while frozenUntil > now (after a mine
// hit) and grays out the board overlay.

function startFreezeTick() {
	clearFreezeTick();
	freezeTickHandle = setInterval(updateFreezeOverlay, 100);
	updateFreezeOverlay();
}

function clearFreezeTick() {
	if (freezeTickHandle) {
		clearInterval(freezeTickHandle);
		freezeTickHandle = null;
	}
}

function clearFreeze() {
	frozenUntil = 0;
	clearFreezeTick();
	if (boardOverlay.className.indexOf("board-overlay-frozen") !== -1) hideOverlay();
}

function updateFreezeOverlay() {
	var remaining = Math.max(0, frozenUntil - Date.now());
	if (remaining <= 0) {
		clearFreezeTick();
		if (boardOverlay.className.indexOf("board-overlay-frozen") !== -1) hideOverlay();
		return;
	}
	var s = Math.ceil(remaining / 1000);
	showOverlay("💥 " + s, "frozen");
}

function startRoundTimer(deadline) {
	stopRoundTimer();
	roundDeadline = deadline;
	if (!deadline) return;
	roundTickHandle = setInterval(updateRoundTimer, 500);
	updateRoundTimer();
}

function stopRoundTimer() {
	if (roundTickHandle) { clearInterval(roundTickHandle); roundTickHandle = null; }
	roundDeadline = null;
	roundTimer.textContent = "";
	roundTimer.classList.remove("round-timer-urgent");
	roundTimer.classList.remove("round-timer-warning");
}

function updateRoundTimer() {
	if (!roundDeadline) return;
	var remaining = Math.max(0, Math.round((roundDeadline - Date.now()) / 1000));
	roundTimer.textContent = "⏱ " + formatRoundTime(remaining);
	roundTimer.classList.toggle("round-timer-urgent", remaining <= 10 && remaining > 0);
	roundTimer.classList.toggle("round-timer-warning", remaining <= 30 && remaining > 10);
	if (remaining <= 0) { clearInterval(roundTickHandle); roundTickHandle = null; }
}

