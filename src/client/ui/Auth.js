// Authentication, account state, and the user-badge UI.
//
// MSBattle starts everyone as a guest and lets them upgrade by signing in (Google, Discord,
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
var userIdentity = document.getElementById("user_identity");
var userProviderLogo = document.getElementById("user_provider_logo");
var userBadgeName = document.getElementById("user_badge_name");
var changeNameButton = document.getElementById("change_name_button");
var signOutButton = document.getElementById("sign_out_button");
var signinButton = document.getElementById("signin_button");

// When we're a guest, carry the guest session token into the OAuth flow so the callback upgrades that
// guest in place (keeping its rating/stats) instead of minting a brand-new account.
function guestUpgradeQuery(sep) {
	var token = localStorage.getItem("ms_session");
	return (account && account.guest && token) ? (sep + "upgrade=" + encodeURIComponent(token)) : "";
}
var signinOptions = document.getElementById("signin_options");
var googleSigninButton = document.getElementById("google_signin");
var discordSigninButton = document.getElementById("discord_signin");
var devSigninButton = document.getElementById("dev_signin");

// The topbar no longer carries a rank badge — it just shows your name + the auth provider you signed
// in with (rank lives on the home dashboard chips). This keeps those home chips in sync.
function renderRatingBadge() {
	renderHomeRankChips();
}

// Small auth-provider mark shown beside the name in the topbar. Guests have no logo (their identity
// is hidden entirely); dev / github logins fall through to no logo.
function providerLogoSVG(provider) {
	if (provider === "google") {
		return '<svg viewBox="0 0 48 48" aria-hidden="true">'
			+ '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
			+ '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
			+ '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
			+ '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
	}
	if (provider === "discord") {
		return '<svg viewBox="0 0 24 24" fill="#5865F2" aria-hidden="true"><path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.211.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.371-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.245.198.372.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>';
	}
	return "";
}

// Topbar identity: a real account shows its provider logo + name and a Sign out button; a guest shows
// nothing but the Sign in button (no name, no logo).
function applyUserIdentity(data) {
	var isGuest = !!(data && data.guest);
	if (isGuest) {
		if (userIdentity) userIdentity.style.display = "none";
	} else {
		if (userBadgeName) userBadgeName.textContent = (data && data.name) || myName;
		var logo = providerLogoSVG(data && data.provider);
		if (userProviderLogo) {
			userProviderLogo.innerHTML = logo;
			userProviderLogo.style.display = logo ? "" : "none";
		}
		if (userIdentity) userIdentity.style.display = "";
	}
	signinButton.style.display = isGuest ? "" : "none";
	signOutButton.style.display = isGuest ? "none" : "";
	if (userBadge) userBadge.style.display = "";
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

googleSigninButton.addEventListener("click", function() {
	window.location.href = "/auth/google/login" + guestUpgradeQuery("?");
});

discordSigninButton.addEventListener("click", function() {
	window.location.href = "/auth/discord/login" + guestUpgradeQuery("?");
});

devSigninButton.addEventListener("click", function() {
	var name = (prompt("Dev sign-in name:", "Dev") || "").trim();
	if (name) window.location.href = "/auth/dev?name=" + encodeURIComponent(name) + guestUpgradeQuery("&");
});

// Guests tap "Sign in" to open the sign-in / rename card.
signinButton.addEventListener("click", function() {
	if (inRoom) socket.emit("leave_room");
	showNameView();
});

signOutButton.addEventListener("click", function() {
	socket.emit("sign_out");
	localStorage.removeItem("ms_session");
	account = null;
	if (inRoom) socket.emit("leave_room");
	myName = "";
	userBadge.style.display = "none";
	socket.emit("guest_session"); // drop back to a fresh guest rather than a login wall
});

// Socket handler bodies — inline registers the events and calls these.
function applyConnected(data) {
	id = data.id;
	var oauth = (data && data.oauth) || {};
	googleSigninButton.style.display = oauth.google ? "" : "none";
	discordSigninButton.style.display = oauth.discord ? "" : "none";
	devSigninButton.style.display = oauth.dev ? "" : "none";
	signinOptions.style.display = (oauth.google || oauth.discord || oauth.dev) ? "" : "none";
	if (typeof noteServerDev === "function") noteServerDev(!!oauth.dev);
	var token = localStorage.getItem("ms_session");
	// Stored token → resume that account/guest. No token → start a guest session automatically
	// (no login wall); the server mints a "GuestNNNNN" user and returns a token we persist.
	if (token) socket.emit("authenticate", { token: token });
	else socket.emit("guest_session");
}

function applyAuthenticated(data) {
	account = data;
	myName = data.name;
	// A freshly-minted guest session ships its token back so it survives reloads.
	if (data.token) localStorage.setItem("ms_session", data.token);
	renderRatingBadge();
	// Topbar: real accounts show name + provider logo + Sign out; guests show only the Sign in button.
	applyUserIdentity(data);
	changeNameButton.style.display = "none";
	if (typeof refreshAdminNavLink === "function") refreshAdminNavLink();
	// Prefetch the daily-puzzle state so the lobby hero card can render
	// today's board immediately.
	if (typeof socket !== "undefined") socket.emit("puzzle_daily_status");
	if (!inRoom) applyRouteFromHash();
}

function applyAuthFailed() {
	localStorage.removeItem("ms_session");
	account = null;
	socket.emit("guest_session"); // stale/expired token → start fresh as a guest
}

function applyNameRejected(data) {
	showNameError((data && data.reason) || "That name was not accepted.");
}

function applyNameAccepted(data) {
	myName = data.name;
	if (account) account.name = data.name; // everyone has an account now (guest or real) — just relabel
	// Re-apply the topbar identity so a real account's relabel shows, while a guest stays hidden there.
	applyUserIdentity(account || { guest: true, name: myName });
	if (!inRoom) applyRouteFromHash();
}
