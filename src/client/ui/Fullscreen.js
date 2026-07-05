// Fullscreen.js — go into browser fullscreen when a game starts (any mode, and only if the
// player opted in on Settings) and release it when leaving the game.
//
// requestFullscreen() needs a transient user gesture, so autoEnterGameFullscreen() is called
// straight from the click handlers that commit the player to a game (Ready, findRanked,
// startSolo), never from a later socket/board callback. It's idempotent and fails silently if the
// browser blocks or doesn't support it — the game just stays windowed.

function isInFullscreen() {
	return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

// On phones the browser already gives the game (near-)full use of the screen, and forcing the
// Fullscreen API there is disruptive (locks orientation prompts, hides the address bar abruptly,
// fails outright on iOS Safari). Skip it on mobile-sized viewports and just play in the page.
function isMobileViewport() {
	return !!(window.matchMedia && window.matchMedia("(max-width: 700px)").matches);
}

// Auto-entering fullscreen the instant a game starts is opt-in (default off) — persisted locally,
// like the board skin / keybinds. Off by default because the abrupt jump (plus the "Press Esc to
// exit" banner some browsers flash) surprised players who never asked for it; the in-game
// fullscreen button (toggleGameFullscreen) always works regardless of this setting.
function autoFullscreenEnabled() {
	return localStorage.getItem("ms_auto_fullscreen") === "1";
}
function setAutoFullscreenEnabled(on) {
	try { localStorage.setItem("ms_auto_fullscreen", on ? "1" : "0"); } catch (e) {}
}
// Call this from the "commit to a game" click handlers (Ready, findRanked, startSolo, …) instead of
// enterGameFullscreen() directly — it only fires if the player opted in. The manual toggle button
// bypasses this and calls enterGameFullscreen() unconditionally.
function autoEnterGameFullscreen() {
	if (autoFullscreenEnabled()) enterGameFullscreen();
}

function enterGameFullscreen() {
	try {
		if (isMobileViewport()) return; // skip fullscreen on mobile — play windowed
		if (isInFullscreen()) return; // already fullscreen — nothing to do
		var el = document.documentElement;
		var req = el.requestFullscreen || el.webkitRequestFullscreen
			|| el.mozRequestFullScreen || el.msRequestFullscreen;
		if (!req) return; // unsupported (e.g. iOS Safari) — play windowed
		var r = req.call(el);
		if (r && typeof r.catch === "function") r.catch(function() {});
	} catch (e) { /* blocked or unsupported — ignore, stay windowed */ }
}

function exitGameFullscreen() {
	try {
		if (!isInFullscreen()) return;
		var exit = document.exitFullscreen || document.webkitExitFullscreen
			|| document.mozCancelFullScreen || document.msExitFullscreen;
		if (!exit) return;
		var r = exit.call(document);
		if (r && typeof r.catch === "function") r.catch(function() {});
	} catch (e) { /* ignore */ }
}

// Toggle for the in-game fullscreen button: re-enter if we've exited (e.g. pressed Esc), or exit if in.
// The click is a user gesture, so requestFullscreen() is allowed here.
function toggleGameFullscreen() {
	if (isInFullscreen()) exitGameFullscreen();
	else enterGameFullscreen();
}

function fullscreenSupported() {
	var el = document.documentElement;
	return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen);
}

// Keep a `game-fullscreen` body class in sync with the ACTUAL fullscreen state — driven by the browser
// event, not our enter/exit helpers, so pressing Esc (the native exit) reverts the chrome too. The CSS
// hangs the immersive layout (hidden navbar, visible "Exit game" button) off this class.
function syncFullscreenChrome() {
	document.body.classList.toggle("game-fullscreen", isInFullscreen());
}
document.addEventListener("fullscreenchange", syncFullscreenChrome);
document.addEventListener("webkitfullscreenchange", syncFullscreenChrome);

// Wire the in-game fullscreen toggle button, and hide it where the API is unavailable.
(function wireFullscreenButton() {
	if (!fullscreenSupported()) document.body.classList.add("no-fullscreen-support");
	var btn = document.getElementById("fullscreen_btn");
	if (btn) btn.addEventListener("click", toggleGameFullscreen);
})();

// Settings-page toggle for the auto-fullscreen opt-in (see autoFullscreenEnabled above).
function renderGameplaySettings() {
	var card = document.getElementById("gameplay_card");
	if (!card) return;
	card.innerHTML = "";
	var h = document.createElement("h2");
	h.className = "controls-title";
	h.textContent = "Gameplay";
	card.appendChild(h);

	var row = document.createElement("div");
	row.className = "setting-row";
	var text = document.createElement("div");
	text.className = "setting-row-text";
	var label = document.createElement("span");
	label.className = "setting-row-label";
	label.textContent = "Auto fullscreen";
	var note = document.createElement("span");
	note.className = "setting-row-note";
	note.textContent = "Jump into fullscreen the moment a game starts. Off by default — use the in-game fullscreen button any time.";
	text.appendChild(label);
	text.appendChild(note);
	row.appendChild(text);

	var sw = document.createElement("button");
	sw.type = "button";
	sw.className = "toggle-switch" + (autoFullscreenEnabled() ? " on" : "");
	sw.setAttribute("aria-pressed", autoFullscreenEnabled() ? "true" : "false");
	sw.addEventListener("click", function() {
		var next = !autoFullscreenEnabled();
		setAutoFullscreenEnabled(next);
		sw.classList.toggle("on", next);
		sw.setAttribute("aria-pressed", next ? "true" : "false");
	});
	row.appendChild(sw);

	card.appendChild(row);
}
