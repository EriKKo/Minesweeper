// Board overlay banner + the round-start countdown.
//
// showOverlay / hideOverlay paint the centered text card over the player's
// own board (Cleared, Frozen, Eliminated, …). countDown / countDownStep play
// the countdown and recurse until 0 (see Animations.js for the on-board digit itself).
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

// onDone (optional) fires the moment the round goes live — used by solo to unlock the board.
// The countdown itself is drawn ON the board (see startCountdownGlyph in Animations.js) rather
// than as a text overlay on top of it — hideOverlay() here just clears any leftover overlay
// (a "Cleared"/"Frozen" card) from before this round started. The "go" board sweep plays BEFORE
// this — the instant the game is ready to start, not at the end of the countdown — see
// startBoardGoAnimation's call site in Main.js's start_game handler.
function countDown(time, onDone) {
	hideOverlay();
	countDownStep(time, onDone);
}

function countDownStep(number, onDone) {
	if (number <= 0) {
		sound.go();
		roundStartTime = Date.now(); // danger-warning grace period starts here
		if (typeof onDone === "function") onDone();
		return;
	}
	if (typeof startCountdownGlyph === "function") startCountdownGlyph(number);
	sound.beep(392 + (3 - Math.min(number, 3)) * 110);
	// Was a fixed 1000ms; now the digit's own fade-in + hold + fade-out + gap (tunable from
	// /admin/countdown — see COUNTDOWN_STYLE/countdownTickMs in Animations.js), so cranking those
	// sliders actually changes how long a real round's countdown takes, not just how the lab's
	// preview looks. Defaults (0+500+400+100) sum to the original 1000ms exactly.
	var tickMs = (typeof countdownTickMs === "function") ? countdownTickMs() : 1000;
	setTimeout(function() { countDownStep(number - 1, onDone); }, tickMs);
}
