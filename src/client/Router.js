// Hash-based SPA router and view show/hide helpers.
//
// Each show*View hides everything and reveals one of the top-level cards
// (#name_view, #game_view, #learn_view, #practice_view, #leaderboard_view,
// #profile_view, #lobby_view) plus marks the matching nav link active.
// applyRouteFromHash is the central dispatcher — registered on hashchange,
// called directly by code paths that change layout mode (mobile <-> desktop).
//
// Loaded before the inline script so renderLearn, renderProfile, etc. are
// available when the user navigates.

function hideAllViews() {
	for (var i = 0; i < allViews.length; i++) {
		var el = document.getElementById(allViews[i]);
		if (el) el.style.display = "none";
	}
}

function showNameView() {
	hideAllViews();
	nameView.style.display = "";
	nameError.style.display = "none";
	setSiteNavActive(null);
	setTimeout(function() { nameInput.focus(); }, 0);
}

function showLobbyView() {
	hideAllViews();
	lobbyView.style.display = "";
	lobbyMessage.style.display = "none";
	// Ranked cards only make sense for signed-in players; custom lobby card is
	// always visible so guests can still create casual rooms.
	var rankedCards = document.querySelectorAll(".home-card-ranked");
	for (var i = 0; i < rankedCards.length; i++) {
		rankedCards[i].style.display = account ? "" : "none";
	}
	renderHomeRankChips();
	setSiteNavActive("home");
	socket.emit("get_leaderboard");
}

// Learn page lives in Learn.js (loaded via a separate <script> tag).

function showLearnView() {
	hideAllViews();
	document.getElementById("learn_view").style.display = "";
	setSiteNavActive("learn");
	renderLearn();
}

function showPracticeView() {
	hideAllViews();
	document.getElementById("practice_view").style.display = "";
	setSiteNavActive("practice");
}

function showCustomView() {
	hideAllViews();
	document.getElementById("custom_view").style.display = "";
	setSiteNavActive("home");
	socket.emit("list_rooms");
}

function showAdminView() {
	hideAllViews();
	document.getElementById("admin_view").style.display = "";
	setSiteNavActive("admin");
	renderAdminLanding();
}

function showPuzzleLabView() {
	hideAllViews();
	document.getElementById("puzzles_view").style.display = "";
	setSiteNavActive("admin");
	renderPuzzleLab();
}

function showPuzzlesListView() {
	hideAllViews();
	document.getElementById("puzzles_list_view").style.display = "";
	setSiteNavActive("admin");
	renderPuzzlesList();
}

function showPuzzlePlayView() {
	hideAllViews();
	document.getElementById("puzzle_play_view").style.display = "";
	setSiteNavActive("");
	renderPuzzlePlay("rated");
}

function showPuzzleStreakView() {
	hideAllViews();
	document.getElementById("puzzle_play_view").style.display = "";
	setSiteNavActive("");
	renderPuzzlePlay("streak");
}

function showPuzzleStormView() {
	hideAllViews();
	document.getElementById("puzzle_play_view").style.display = "";
	setSiteNavActive("");
	renderPuzzlePlay("storm");
}

function showPuzzleDailyView() {
	hideAllViews();
	document.getElementById("puzzle_play_view").style.display = "";
	setSiteNavActive("");
	renderPuzzlePlay("daily");
}

function showLeaderboardView() {
	hideAllViews();
	document.getElementById("leaderboard_view").style.display = "";
	setSiteNavActive("leaderboard");
	socket.emit("get_leaderboard");
}

function showProfileView() {
	hideAllViews();
	document.getElementById("profile_view").style.display = "";
	setSiteNavActive("profile");
	renderProfile();
}

function setSiteNavActive(route) {
	var links = document.querySelectorAll(".site-nav-link");
	for (var i = 0; i < links.length; i++) {
		links[i].classList.toggle("active", links[i].getAttribute("data-route") === route);
	}
}

// Hash router. If the user is mid-game when they navigate away, we leave
// the room (multiplayer) or tear down the solo session first, then route.
// For an active (phase === "playing") multiplayer match, we first confirm —
// leaving counts as a loss server-side. If they cancel, restore the prior
// hash so the URL stays in sync with the still-current view.
var lastAppliedHash = "";
var suppressNextRoute = false;

function applyRouteFromHash() {
	if (suppressNextRoute) { suppressNextRoute = false; return; }
	if (nameView && nameView.style.display !== "none" && !account && !myName) return;
	if (inRoom) {
		var inPlay = currentRoom && currentRoom.phase === "playing";
		if (inPlay && !confirm("Leaving now counts as a loss. Are you sure you want to leave?")) {
			// Roll the hash back to whatever was showing the game view.
			suppressNextRoute = true;
			location.hash = lastAppliedHash || "#/";
			return;
		}
		socket.emit("leave_room");
		return;
	}
	if (puzzleSession) {
		// Rated: leaving is free — server keeps current_puzzle_id and
		// re-serves the same board next time. Streak/Storm: tell the
		// server to wrap up so the score is recorded as a personal-best
		// update if it qualifies.
		if ((puzzleSession.mode === "streak" || puzzleSession.mode === "storm") && !puzzleSession.finished) {
			socket.emit("puzzle_run_abandon");
		}
		stopStormTicker();
		togglePuzzleChrome(false);
		if (gameView) gameView.classList.remove("puzzle");
		puzzleSession = null;
		puzzleRunMode = null;
		hideOverlay();
		myState = null;
		prevPlayerState = null;
		boardDecoder = null;
	}
	if (soloSession) {
		soloSession = null;
		stopSoloTimer();
		hideOverlay();
		myState = null;
		prevPlayerState = null;
		boardDecoder = null;
	}
	var hash = (location.hash || "#/").replace(/^#/, "");
	lastAppliedHash = location.hash || "#/";
	// Music only plays in actual play views — lobby/menu/admin stay quiet.
	// Active ranked / 1v1 / tournament matches start music separately
	// from the game-state event handlers.
	var inGameRoutes = ["/custom", "/practice", "/puzzles/play", "/puzzles/streak", "/puzzles/storm", "/puzzles/daily"];
	var inGame = inGameRoutes.indexOf(hash) !== -1;
	if (typeof music !== "undefined") {
		if (inGame) music.resume(); else music.pause();
	}
	if (hash === "/" || hash === "") return showLobbyView();
	if (hash === "/learn") return showLearnView();
	if (hash === "/practice") return showPracticeView();
	if (hash === "/custom") return showCustomView();
	if (hash === "/puzzles/play") return showPuzzlePlayView();
	if (hash === "/puzzles/streak") return showPuzzleStreakView();
	if (hash === "/puzzles/storm") return showPuzzleStormView();
	if (hash === "/puzzles/daily") return showPuzzleDailyView();
	if (hash === "/admin") return showAdminView();
	if (hash === "/admin/lab") return showPuzzleLabView();
	// /admin/puzzles can carry filter state as a query string
	// (e.g. ?diff=3&method=overlap&sort=desc&page=2) so reloads persist.
	if (hash === "/admin/puzzles" || hash.indexOf("/admin/puzzles?") === 0) return showPuzzlesListView();
	if (hash === "/leaderboard") return showLeaderboardView();
	if (hash === "/profile") return showProfileView();
	showLobbyView();
}

window.addEventListener("hashchange", applyRouteFromHash);
