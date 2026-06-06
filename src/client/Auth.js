// Authentication, account state, and the user-badge UI.
//
// MSBattle plays guest-by-nickname (set_name) and signed-in (Google, GitHub,
// or a dev backdoor when DEV_AUTH=1 on the server). The OAuth callback round-
// trips a session token through a URL hash, which the IIFE below strips and
// stashes in localStorage so it survives reloads. socket.on("connected") is
// the moment we re-authenticate with the cached token.
//
// The actual socket.on registrations stay in the main inline script — they
// need access to the `socket` var that's created there. This file exports
// applyAuth* helpers the inline script delegates to.

// A session token arrives back from OAuth/dev login as a URL hash; stash it.
(function() {
	var m = /(?:^|[#&])token=([a-f0-9]+)/.exec(location.hash || "");
	if (m) {
		localStorage.setItem("ms_session", m[1]);
		history.replaceState(null, "", location.pathname + location.search);
	}
})();

var myName = "";
var account = null; // { name, rating, ... } when signed in

var nameForm = document.getElementById("name_form");
var nameInput = document.getElementById("name_input");
var nameError = document.getElementById("name_error");
var userBadge = document.getElementById("user_badge");
var userBadgeName = document.getElementById("user_badge_name");
var changeNameButton = document.getElementById("change_name_button");
var signOutButton = document.getElementById("sign_out_button");
var ratingChip = document.getElementById("rating_chip");
var signinOptions = document.getElementById("signin_options");
var githubSigninButton = document.getElementById("github_signin");
var googleSigninButton = document.getElementById("google_signin");
var devSigninButton = document.getElementById("dev_signin");

function renderRatingBadge() {
	renderHomeRankChips();
	if (!account) return;
	var t = tierFor(account.rating, account.provisional);
	ratingChip.textContent = t.name + " · " + (account.provisional ? "~" : "") + account.rating;
	ratingChip.style.color = t.color;
	ratingChip.style.background = t.color + "22";
	ratingChip.style.display = "";
}

nameForm.addEventListener("submit", function(e) {
	e.preventDefault();
	var name = (nameInput.value || "").trim();
	if (!name) {
		showNameError("Please enter a nickname.");
		return;
	}
	socket.emit("set_name", { name: name });
});

changeNameButton.addEventListener("click", function() {
	if (inRoom) {
		socket.emit("leave_room");
	}
	nameInput.value = myName;
	showNameView();
});

githubSigninButton.addEventListener("click", function() {
	window.location.href = "/auth/github/login";
});

googleSigninButton.addEventListener("click", function() {
	window.location.href = "/auth/google/login";
});

devSigninButton.addEventListener("click", function() {
	var name = (prompt("Dev sign-in name:", "Dev") || "").trim();
	if (name) window.location.href = "/auth/dev?name=" + encodeURIComponent(name);
});

signOutButton.addEventListener("click", function() {
	socket.emit("sign_out");
	localStorage.removeItem("ms_session");
	account = null;
	if (inRoom) socket.emit("leave_room");
	myName = "";
	userBadge.style.display = "none";
	showNameView();
});

// Socket handler bodies — inline registers the events and calls these.
function applyConnected(data) {
	id = data.id;
	var oauth = (data && data.oauth) || {};
	githubSigninButton.style.display = oauth.github ? "" : "none";
	googleSigninButton.style.display = oauth.google ? "" : "none";
	devSigninButton.style.display = oauth.dev ? "" : "none";
	signinOptions.style.display = (oauth.github || oauth.google || oauth.dev) ? "" : "none";
	if (typeof noteServerDev === "function") noteServerDev(!!oauth.dev);
	var token = localStorage.getItem("ms_session");
	if (token) socket.emit("authenticate", { token: token });
}

function applyAuthenticated(data) {
	account = data;
	myName = data.name;
	userBadgeName.textContent = myName;
	ratingChip.title = "Ranked rating" + (data.provisional ? " (provisional)" : "");
	renderRatingBadge();
	changeNameButton.style.display = "none";
	signOutButton.style.display = "";
	userBadge.style.display = "";
	if (typeof refreshAdminNavLink === "function") refreshAdminNavLink();
	// Prefetch the daily-puzzle state so the lobby hero card can render
	// today's board immediately.
	if (typeof socket !== "undefined") socket.emit("puzzle_daily_status");
	if (!inRoom) applyRouteFromHash();
}

function applyAuthFailed() {
	localStorage.removeItem("ms_session");
	account = null;
}

function applyNameRejected(data) {
	showNameError((data && data.reason) || "That name was not accepted.");
}

function applyNameAccepted(data) {
	myName = data.name;
	userBadgeName.textContent = myName;
	ratingChip.style.display = "none";
	changeNameButton.style.display = "";
	signOutButton.style.display = "none";
	userBadge.style.display = "";
	if (!inRoom) applyRouteFromHash();
}
