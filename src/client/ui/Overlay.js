// Board overlay banner + the round-start countdown.
//
// showOverlay / hideOverlay paint the centered text card over the player's
// own board (Cleared, Frozen, Eliminated, …). countDown schedules the single authoritative "round
// goes live" timer plus the purely-decorative sweep/digit animations layered on top of it (see its
// own comment below, and Animations.js for the on-board digit itself).
//
// Plus a couple of tiny shared helpers (clearCanvas, hideReadyButton).

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


// App-styled confirmation modal — a DOM dialog used instead of window.confirm().
// Native confirm() is unreliable in browser fullscreen (it's suppressed and returns
// false silently, so an in-game button looks dead); this renders inside the page so it
// works fullscreen or windowed, and traps the keyboard so board input can't leak through.
// Returns a Promise<boolean> (true = confirmed). opts: { title, okText, cancelText, danger }.
function showConfirm(message, opts) {
	opts = opts || {};
	return new Promise(function(resolve) {
		var existing = document.getElementById("confirm_modal");
		if (existing) existing.remove();

		var backdrop = document.createElement("div");
		backdrop.id = "confirm_modal";
		backdrop.className = "confirm-backdrop";

		var modal = document.createElement("div");
		modal.className = "confirm-modal";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");

		if (opts.title) {
			var title = document.createElement("p");
			title.className = "confirm-modal-title";
			title.textContent = opts.title;
			modal.appendChild(title);
		}
		var msg = document.createElement("p");
		msg.className = "confirm-modal-msg";
		msg.textContent = message;
		modal.appendChild(msg);

		var actions = document.createElement("div");
		actions.className = "confirm-modal-actions";
		var cancelBtn = document.createElement("button");
		cancelBtn.className = "btn btn-secondary";
		cancelBtn.textContent = opts.cancelText || "Cancel";
		var okBtn = document.createElement("button");
		okBtn.className = "btn " + (opts.danger ? "btn-danger" : "btn-primary");
		okBtn.textContent = opts.okText || "OK";
		actions.appendChild(cancelBtn);
		actions.appendChild(okBtn);
		modal.appendChild(actions);

		backdrop.appendChild(modal);
		document.body.appendChild(backdrop);
		okBtn.focus();

		function close(result) {
			document.removeEventListener("keydown", onKey, true);
			backdrop.remove();
			resolve(result);
		}
		// Capture phase + stopPropagation so the in-game board key handlers don't fire
		// while the modal is open; only Enter / Escape do anything.
		function onKey(e) {
			e.stopPropagation();
			if (e.key === "Escape") { e.preventDefault(); close(false); }
			else if (e.key === "Enter") { e.preventDefault(); close(true); }
		}
		okBtn.addEventListener("click", function() { close(true); });
		cancelBtn.addEventListener("click", function() { close(false); });
		backdrop.addEventListener("click", function(e) { if (e.target === backdrop) close(false); });
		document.addEventListener("keydown", onKey, true);
	});
}

function clearCanvas(canvas) {
	var ctx = canvas.getContext("2d");
	ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function hideReadyButton() {
	readyButton.style.display = "none";
}

// delayMs is an ABSOLUTE budget (real match: the server's own ROUND_START_DELAY_MS, echoed back as
// startDelayMs so client and server start their timers from the same start_game event; solo: a
// locally-computed natural total, see beginSolo in Solo.js) — onDone fires at EXACTLY that many ms
// from now, no matter how the decorative animations below are paced. This is the fix for a real bug:
// the countdown used to BE the clock (each digit's own tunable fade-in/hold/fade-out/gap chained
// into the next), so retiming the animation for looks also retimed when the round actually went
// live — drifting the client out of sync with the server's own fixed-duration timer. Now there's
// exactly one authoritative timer, sized directly from the server's real delay. The two decorative
// pieces are paced independently against it: the "go" sweep plays IMMEDIATELY (it's the "the round
// is ready" cue, so it should fire the instant this is called — right off the start_game/
// territory_start event, not delayed), while the digit cycle is TIMED BACKWARDS FROM THE DEADLINE —
// its own natural length (3 digits × countdownTickMs) is computed up front and it doesn't start
// until delayMs minus that length has elapsed, so "1" finishes fading exactly as GO fires instead of
// the countdown finishing early and leaving a dead gap of plain blue before the round actually goes
// live. If the digit cycle alone is tuned longer than delayMs there's no lead-in to give — it starts
// right away and simply gets cut off when GO fires. This is the one function every "ready to start"
// call site (Main.js, Solo.js, Territory.js) should schedule everything through — none of them call
// startBoardGoAnimation themselves anymore.
function countDown(delayMs, onDone) {
	hideOverlay();
	if (typeof startBoardGoAnimation === "function") startBoardGoAnimation(rows, cols);
	if (typeof sound !== "undefined") sound.sweep();
	var digitsMs = (typeof countdownTickMs === "function") ? countdownTickMs() * 3 : 3000;
	var digitLeadDelay = Math.max(0, delayMs - digitsMs);
	setTimeout(function() { countdownDigitCycle(3); }, digitLeadDelay);
	setTimeout(function() {
		sound.go();
		roundStartTime = Date.now(); // danger-warning grace period starts here
		if (typeof onDone === "function") onDone();
	}, delayMs);
}

function countdownDigitCycle(number) {
	if (number <= 0) return; // decorative sequence exhausted — the real GO timer in countDown still governs
	if (typeof startCountdownGlyph === "function") startCountdownGlyph(number);
	sound.beep(392 + (3 - Math.min(number, 3)) * 110);
	// Was a fixed 1000ms; now the digit's own fade-in + hold + fade-out + gap (tunable from
	// /admin/countdown — see COUNTDOWN_STYLE/countdownTickMs in Animations.js). Purely cosmetic
	// pacing now — see the comment on countDown above for why it no longer drives gameplay timing.
	var tickMs = (typeof countdownTickMs === "function") ? countdownTickMs() : 1000;
	setTimeout(function() { countdownDigitCycle(number - 1); }, tickMs);
}
