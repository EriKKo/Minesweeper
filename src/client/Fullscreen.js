// Fullscreen.js — go into browser fullscreen when a game starts (any mode) and
// release it when leaving the game.
//
// requestFullscreen() needs a transient user gesture, so enterGameFullscreen()
// is called straight from the click handlers that commit the player to a game
// (Ready, findRanked, startSolo, renderPuzzlePlay, territory create), never
// from a later socket/board callback. It's idempotent and fails silently if the
// browser blocks or doesn't support it — the game just stays windowed.

function isInFullscreen() {
	return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function enterGameFullscreen() {
	try {
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

// Keep a `game-fullscreen` body class in sync with the ACTUAL fullscreen state — driven by the browser
// event, not our enter/exit helpers, so pressing Esc (the native exit) reverts the chrome too. The CSS
// hangs the immersive layout (hidden navbar, visible "Exit game" button) off this class.
function syncFullscreenChrome() {
	document.body.classList.toggle("game-fullscreen", isInFullscreen());
}
document.addEventListener("fullscreenchange", syncFullscreenChrome);
document.addEventListener("webkitfullscreenchange", syncFullscreenChrome);
