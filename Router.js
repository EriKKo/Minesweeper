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

// Hash router. Only takes effect when the player is NOT in a room — in-room
// always means the game view, regardless of hash.
function applyRouteFromHash() {
	if (inRoom || soloSession) return;
	if (nameView && nameView.style.display !== "none" && !account && !myName) return;
	var hash = (location.hash || "#/").replace(/^#/, "");
	if (hash === "/" || hash === "") return showLobbyView();
	if (hash === "/learn") return showLearnView();
	if (hash === "/practice") return showPracticeView();
	if (hash === "/leaderboard") return showLeaderboardView();
	if (hash === "/profile") return showProfileView();
	showLobbyView();
}

window.addEventListener("hashchange", applyRouteFromHash);
