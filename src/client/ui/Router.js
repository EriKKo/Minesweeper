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
	// Default to "not in a game"; the game entry points (showGameView / solo / puzzle) re-add
	// `in-game` right after. Drives chrome that should vanish during play (e.g. the site footer).
	document.body.classList.remove("in-game");
}

function showNameView() {
	hideAllViews();
	nameView.style.display = "";
	nameError.style.display = "none";
	// A signed-in account is here to RENAME (it already has an identity), so drop the provider sign-in
	// options and retitle the card; a guest is here to sign in (or set a guest name), so show them.
	var renaming = !!(account && !account.guest);
	var titleEl = document.getElementById("name_view_title");
	if (titleEl) titleEl.textContent = renaming ? "Change your name" : "Sign in";
	if (typeof signinOptions !== "undefined" && signinOptions) {
		signinOptions.style.display = (!renaming && signinOptionsAvailable) ? "" : "none";
	}
	setSiteNavActive(null);
	setTimeout(function() { nameInput.focus(); }, 0);
}

// Sub-page that lets you pick 1v1 or 6P after choosing a Sprint /
// Standard playstyle on the lobby. Tournament skips this and queues
// directly; Custom has its own lobby.
var RANKED_PICKER_META = {
	sprint:   { title: "Sprint",   sub: "10% mines · fast race",
		pitch: "Wide cascades, blink-fast clears. Read the open spaces and out-click your opponent.",
		duoSub: "Head-to-head sprint", sixSub: "Free-for-all sprint", color: "#fbbf24",
		iconPath: "M13 2L3 14h7l-1 8 10-12h-7l1-8z" },
	standard: { title: "Standard", sub: "20% mines · deduction",
		pitch: "Dense boards reward careful reading. Bad guesses end your match — every flag matters.",
		duoSub: "Head-to-head deduction", sixSub: "Dense free-for-all", color: "#a78bfa",
		iconPath: "M12 3a9 9 0 109 9 9 9 0 00-9-9zm0 4a5 5 0 11-5 5 5 5 0 015-5zm0 3a2 2 0 102 2 2 2 0 00-2-2z" },
	territory: { title: "Territory", sub: "claim a shared board",
		pitch: "Grow from your corner and claim more cells than anyone. Mines re-cover your ground — wall opponents off to capture it.",
		duoTitle: "1v1", duoSub: "Two corners, head-to-head",
		sixTitle: "4-player", sixSub: "One per corner, free-for-all", color: "#22d3ee",
		iconPath: "M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" }
};

function showRankedPickerView(style) {
	var meta = RANKED_PICKER_META[style];
	if (!meta) { navigate("/"); return; }
	hideAllViews();
	document.getElementById("ranked_picker_view").style.display = "";
	setSiteNavActive("home");
	var iconEl = document.getElementById("ranked_picker_icon");
	if (iconEl) {
		iconEl.style.color = meta.color;
		iconEl.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + meta.iconPath + '" fill="currentColor"/></svg>';
	}
	document.getElementById("ranked_picker_title").textContent = meta.title;
	document.getElementById("ranked_picker_sub").textContent = meta.sub;
	document.getElementById("ranked_picker_pitch").textContent = meta.pitch;
	document.getElementById("ranked_picker_duo_sub").textContent = meta.duoSub;
	document.getElementById("ranked_picker_six_sub").textContent = meta.sixSub;
	document.getElementById("ranked_picker_duo_title").textContent = meta.duoTitle || "1v1";
	document.getElementById("ranked_picker_six_title").textContent = meta.sixTitle || "6-player";
	// Rating displayed up top reflects this playstyle's Elo so the
	// player sees what's on the line for the match they're about to queue.
	var rating = null;
	if (account) {
		if (style === "sprint") rating = account.ratingSprint;
		else if (style === "standard") rating = account.ratingStandard;
		else if (style === "territory") rating = account.ratingTerritory;
	}
	var tierEl = document.getElementById("ranked_picker_tier");
	var ratingEl = document.getElementById("ranked_picker_num");
	if (rating != null && typeof tierFor === "function") {
		var t = tierFor(rating, account && account.provisional);
		tierEl.textContent = t.name; tierEl.style.color = t.color;
		ratingEl.textContent = rating;
	} else {
		tierEl.textContent = "—"; ratingEl.textContent = "";
	}
	var duoBtn = document.getElementById("ranked_picker_duo");
	var sixBtn = document.getElementById("ranked_picker_six");
	// Territory's larger match is 4-player (territory_quad), not the "_six" used by the racing styles.
	var bigMode = style === "territory" ? "territory_quad" : style + "_six";
	// Racing modes drop straight into the battle UI (findRanked shows the game view) — stay there.
	// Territory/tournament show the search as an overlay over the lobby, so return to the lobby.
	function startRanked(mode) {
		findRanked(mode);
		if (!(typeof isRaceRankedMode === "function" && isRaceRankedMode(mode))) navigate("/");
	}
	duoBtn.onclick = function() { startRanked(style + "_duo"); };
	sixBtn.onclick = function() { startRanked(bigMode); };
	document.getElementById("ranked_picker_back").onclick = function() { navigate("/"); };
}

// Puzzle mode chooser (mirrors the ranked picker): Rated / Streak / Storm each link to their run.
function showPuzzlePickerView() {
	hideAllViews();
	document.getElementById("puzzle_picker_view").style.display = "";
	setSiteNavActive("home");
	var el = document.getElementById("puzzle_picker_rating");
	if (el) el.textContent = account ? (account.puzzleRating != null ? account.puzzleRating : 800) : "—";
	document.getElementById("puzzle_picker_back").onclick = function() { navigate("/"); };
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

function showBotsView() {
	hideAllViews();
	document.getElementById("bots_view").style.display = "";
	setSiteNavActive("admin");
	renderBotsList();
}

function showStartingPositionsView() {
	hideAllViews();
	document.getElementById("starting_positions_view").style.display = "";
	setSiteNavActive("admin");
	renderStartingPositions();
}

function showPatternsView() {
	hideAllViews();
	document.getElementById("patterns_view").style.display = "";
	setSiteNavActive("admin");
	renderPatterns();
}

function showStartPatternsView() {
	hideAllViews();
	document.getElementById("start_patterns_view").style.display = "";
	setSiteNavActive("admin");
	renderStartPatterns();
}

function showCombinedPuzzlesView() {
	hideAllViews();
	document.getElementById("combined_puzzles_view").style.display = "";
	setSiteNavActive("admin");
	renderCombinedPuzzles();
}

function showDesignView() {
	hideAllViews();
	document.getElementById("design_view").style.display = "";
	setSiteNavActive("admin");
	renderDesign();
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

// Legal pages render as normal in-app views (navbar stays); not a main-nav item, so no link is marked active.
function showPrivacyView() {
	hideAllViews();
	document.getElementById("privacy_view").style.display = "";
	setSiteNavActive(null);
	window.scrollTo(0, 0);
}

function showTermsView() {
	hideAllViews();
	document.getElementById("terms_view").style.display = "";
	setSiteNavActive(null);
	window.scrollTo(0, 0);
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
var lastAppliedHash = ""; // path+search currently routed to — used to restore the URL on a cancelled leave

function applyRouteFromHash() {
	// Legal pages are public — viewable before sign-in/name entry (handled before the name gate below).
	var path = location.pathname;
	if (path === "/privacy") { lastAppliedHash = path; return showPrivacyView(); }
	if (path === "/terms") { lastAppliedHash = path; return showTermsView(); }
	if (nameView && nameView.style.display !== "none" && !account && !myName) return;
	if (inRoom) {
		var inPlay = currentRoom && currentRoom.phase === "playing";
		if (inPlay) {
			// Confirm via the app modal (native confirm() is suppressed in fullscreen). The URL
			// already changed to the target; we keep it there while asking (the game stays shown
			// behind the modal). On confirm, leaveRoom() tears the game UI down immediately and
			// re-routes to the still-current target URL. On cancel we restore the game's URL.
			showConfirm("Leaving now counts as a loss.", {
				title: "Leave game?", okText: "Leave", cancelText: "Stay", danger: true
			}).then(function(ok) {
				if (!ok) {
					if (location.pathname + location.search !== lastAppliedHash) history.pushState(null, "", lastAppliedHash || "/");
					return;
				}
				leaveRoom();
			});
			return;
		}
		leaveRoom();
		return;
	}
	if (puzzleSession) {
		exitGameFullscreen();
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
		exitGameFullscreen();
		soloSession = null;
		stopSoloTimer();
		hideOverlay();
		myState = null;
		prevPlayerState = null;
		boardDecoder = null;
	}
	var hash = location.pathname; // match routes on the path; views that take filters read location.search
	lastAppliedHash = location.pathname + location.search;
	// Music only plays in actual play views — lobby/menu/admin stay quiet. `/custom` is NOT a play
	// view: it's the room list, and even inside a custom room the URL stays `/custom` through the
	// (silent) waiting lobby. Custom + ranked matches start the music from the `start_game` handler
	// instead, so it only kicks in once a game is actually live.
	var inGameRoutes = ["/practice"];
	var inGame = inGameRoutes.indexOf(hash) !== -1;
	if (typeof music !== "undefined") {
		if (inGame) music.resume(); else music.pause();
	}
	// Ranked picker: /ranked/sprint, /ranked/standard, /ranked/tournament.
	// Tournament has no size choice so it just queues immediately.
	if (hash.indexOf("/ranked/") === 0) {
		var style = hash.slice("/ranked/".length);
		if (style === "tournament") { if (typeof findRanked === "function") findRanked("tournament"); navigate("/"); return; }
		if (typeof showRankedPickerView === "function") return showRankedPickerView(style);
	}
	if (hash === "/" || hash === "") return showLobbyView();
	if (hash === "/learn") return showLearnView();
	if (hash === "/practice") return showPracticeView();
	if (hash === "/custom") return showCustomView();
	if (hash === "/puzzles") return showPuzzlePickerView();
	if (hash === "/puzzles/play") return showPuzzlePlayView();
	if (hash === "/puzzles/streak") return showPuzzleStreakView();
	if (hash === "/puzzles/storm") return showPuzzleStormView();
	if (hash === "/puzzles/daily") return showPuzzleDailyView();
	if (hash === "/admin") return showAdminView();
	if (hash === "/admin/lab") return showPuzzleLabView();
	// /admin/puzzles can carry filter state as a query string
	// (e.g. ?diff=3&method=overlap&sort=desc&page=2) so reloads persist.
	if (hash === "/admin/puzzles" || hash.indexOf("/admin/puzzles?") === 0) return showPuzzlesListView();
	if (hash === "/admin/bots" || hash.indexOf("/admin/bots?") === 0) return showBotsView();
	if (hash === "/admin/starting-positions" || hash.indexOf("/admin/starting-positions?") === 0) return showStartingPositionsView();
	if (hash === "/admin/patterns" || hash.indexOf("/admin/patterns?") === 0) return showPatternsView();
	if (hash === "/admin/start-patterns") return showStartPatternsView();
	if (hash === "/admin/combined-puzzles") return showCombinedPuzzlesView();
	if (hash === "/admin/design") return showDesignView();
	if (hash === "/leaderboard") return showLeaderboardView();
	if (hash === "/profile") return showProfileView();
	if (hash === "/privacy") return showPrivacyView();
	if (hash === "/terms") return showTermsView();
	showLobbyView();
}

// Clean-path navigation via the History API (no "#/"). navigate() pushes a new path then routes;
// back/forward fire popstate; and a delegated click handler turns same-origin <a href="/…"> clicks into
// client-side navigations so ordinary links Just Work without per-link wiring.
function navigate(to) {
	if (!to) to = "/";
	if (to[0] !== "/") to = "/" + to;
	if (to !== location.pathname + location.search) history.pushState(null, "", to);
	applyRouteFromHash();
}
window.addEventListener("popstate", applyRouteFromHash);
document.addEventListener("click", function(e) {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	var a = e.target && e.target.closest ? e.target.closest("a") : null;
	if (!a) return;
	var href = a.getAttribute("href");
	// Only intercept internal absolute-path links; leave external, hash, download, new-tab, and
	// server routes (/auth/…) to the browser.
	if (!href || href[0] !== "/" || href.indexOf("/auth/") === 0) return;
	if (a.target === "_blank" || a.hasAttribute("download")) return;
	e.preventDefault();
	navigate(href);
});
