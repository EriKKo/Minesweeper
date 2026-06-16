// Profile view: rating + tier + win-rate summary card.
//
// Renders from `account` (populated by the server on sign-in) and the cached
// rating fields the server updates after each ranked match. The rank chips on
// the home page (renderHomeRankChips) read the same data.

// Board-skin picker (local, like keybindings). Each option shows a tiny swatch built
// from the skin's palette; clicking applies it live via setBoardSkin (BoardRender.js).
function renderBoardSkins() {
	var card = document.getElementById("skins_card");
	if (!card || typeof BOARD_SKINS === "undefined") return;
	// Admin-only option for now (visible in local dev too, matching the Admin nav link).
	var dev = window.serverInfo && window.serverInfo.dev;
	var admin = (typeof account !== "undefined" && account && account.isAdmin);
	if (!dev && !admin) { card.innerHTML = ""; card.style.display = "none"; return; }
	card.style.display = "";
	card.innerHTML = "";
	var h = document.createElement("h2");
	h.className = "controls-title";
	h.textContent = "Board skin";
	card.appendChild(h);
	var sub = document.createElement("p");
	sub.className = "section-stub-note";
	sub.style.marginTop = "0";
	sub.textContent = "Choose how your board looks. More texture packs coming.";
	card.appendChild(sub);

	var grid = document.createElement("div");
	grid.className = "skin-options";
	BOARD_SKIN_LIST.forEach(function(id) {
		var s = BOARD_SKINS[id];
		var btn = document.createElement("button");
		btn.type = "button";
		btn.className = "skin-option" + (id === localBoardSkin ? " active" : "");
		var prev = document.createElement("span");
		prev.className = "skin-preview";
		var unknown = document.createElement("span");
		unknown.className = "skin-cell";
		unknown.style.background = "linear-gradient(180deg," + s.unknownTop + "," + s.unknownBottom + ")";
		unknown.style.borderColor = s.unknownEdge;
		prev.appendChild(unknown);
		[1, 2, 3].forEach(function(n) {
			var c = document.createElement("span");
			c.className = "skin-cell skin-cell-num";
			c.style.background = s.knownBg;
			c.style.borderColor = s.knownEdge;
			c.style.color = s.numbers[n];
			c.style.fontFamily = s.font;
			if (s.glow) c.style.textShadow = "0 0 5px " + s.numbers[n];
			c.textContent = n;
			prev.appendChild(c);
		});
		btn.appendChild(prev);
		var meta = document.createElement("span");
		meta.className = "skin-meta";
		var name = document.createElement("span"); name.className = "skin-name"; name.textContent = s.label;
		var blurb = document.createElement("span"); blurb.className = "skin-blurb"; blurb.textContent = s.blurb;
		meta.appendChild(name); meta.appendChild(blurb);
		btn.appendChild(meta);
		btn.addEventListener("click", function() { if (typeof setBoardSkin === "function") setBoardSkin(id); });
		grid.appendChild(btn);
	});
	card.appendChild(grid);
}

// Profile renders from the account cache plus the most recent leaderboard snapshot.
// The profile is split into three tabs (the page had grown large): Overview (identity + lifetime/
// ranked/puzzle stats), Matches (rating graph + recent games/replays), and Achievements.
var PROFILE_TABS = [
	{ id: "overview", label: "Overview", panel: "profile_tab_overview" },
	{ id: "matches", label: "Matches", panel: "profile_tab_matches" },
	{ id: "achievements", label: "Achievements", panel: "profile_tab_achievements" }
];
var profileTab = "overview"; // remembered across re-renders within a session

function buildProfileTabs() {
	var bar = document.getElementById("profile_tabs");
	if (!bar || bar.dataset.built) return;
	PROFILE_TABS.forEach(function(t) {
		var b = document.createElement("button"); b.type = "button"; b.className = "lb-tab"; b.textContent = t.label;
		b.dataset.tab = t.id;
		b.addEventListener("click", function() { selectProfileTab(t.id); });
		bar.appendChild(b);
	});
	bar.dataset.built = "1";
}

// Show one panel, hide the others, and mark the matching tab button active.
function selectProfileTab(id) {
	profileTab = id;
	PROFILE_TABS.forEach(function(t) {
		var panel = document.getElementById(t.panel);
		if (panel) panel.style.display = t.id === id ? "" : "none";
	});
	var bar = document.getElementById("profile_tabs");
	if (bar) { var btns = bar.querySelectorAll(".lb-tab"); for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].dataset.tab === id); }
}

function renderProfile() {
	// Board skin + controls moved to the Settings page (showSettingsView renders them).
	var card = document.getElementById("profile_card");
	if (!card) return;
	var tabsBar = document.getElementById("profile_tabs");
	if (!account) {
		// Signed out: no tabs — just the overview panel with a sign-in prompt.
		if (tabsBar) tabsBar.style.display = "none";
		selectProfileTab("overview");
		card.innerHTML = "";
		var p = document.createElement("p");
		p.textContent = "Sign in to see your rating, win rate, and recent matches.";
		card.appendChild(p);
		var ac0 = document.getElementById("achievements_card");
		if (ac0) ac0.innerHTML = "";
		["rating_history_card", "recent_games_card"].forEach(function(id) {
			var el = document.getElementById(id); if (el) el.style.display = "none";
		});
		return;
	}
	buildProfileTabs();
	if (tabsBar) tabsBar.style.display = "";
	card.innerHTML = "";

	// --- Identity: avatar + country flag, overall rank badge + name + tier/rating + member since ---
	var summary = document.createElement("div");
	summary.className = "profile-summary";
	if (typeof buildAvatarChip === "function") {
		var chip = buildAvatarChip(account.avatarColor || DEFAULT_AVATAR_COLOR, account.country || null, 64);
		chip.classList.add("profile-avatar");
		summary.appendChild(chip);
	}
	var overall = overallRating(account); // best across modes — the headline rank
	summary.appendChild(buildRankBadge(overall));
	var text = document.createElement("div");
	text.className = "profile-summary-text";
	var nameLine = document.createElement("div");
	nameLine.className = "profile-summary-name";
	nameLine.textContent = myName || (account.name || "You");
	text.appendChild(nameLine);
	var ratingLine = document.createElement("div");
	ratingLine.className = "profile-summary-rating";
	var t = tierFor(overall, account.provisional);
	ratingLine.textContent = t.name + " · " + overall;
	ratingLine.style.color = t.color;
	text.appendChild(ratingLine);
	if (account.createdAt) {
		var since = document.createElement("div");
		since.className = "profile-summary-since";
		since.textContent = "Member since " + formatMemberSince(account.createdAt);
		text.appendChild(since);
	}
	summary.appendChild(text);
	card.appendChild(summary);

	// --- Lifetime stats ---
	var played = account.played || 0, wins = account.wins || 0;
	var winRate = played > 0 ? Math.round((wins / played) * 100) + "%" : "—";
	var stats = document.createElement("div");
	stats.className = "profile-stats";
	stats.appendChild(profileStat("Played", String(played)));
	stats.appendChild(profileStat("Wins", String(wins)));
	stats.appendChild(profileStat("Win rate", winRate));
	stats.appendChild(profileStat("Daily streak", "🔥 " + (account.dailyStreak || 0)));
	card.appendChild(stats);

	// --- Ranked ladders (one card per mode) ---
	card.appendChild(profileSectionTitle("Ranked ladders"));
	var ladders = document.createElement("div");
	ladders.className = "profile-ladders";
	ladders.appendChild(profileLadderCard("Sprint", account.ratingSprint || 0));
	ladders.appendChild(profileLadderCard("Standard", account.ratingStandard || 0));
	card.appendChild(ladders);

	// --- Puzzles ---
	card.appendChild(profileSectionTitle("Puzzles"));
	var pz = document.createElement("div");
	pz.className = "profile-stats";
	pz.appendChild(profileStat("Rating", String(account.puzzleRating != null ? account.puzzleRating : 800)));
	pz.appendChild(profileStat("Solved", (account.puzzlesSolved || 0) + " / " + (account.puzzlesAttempted || 0)));
	pz.appendChild(profileStat("Best streak", String(account.streakBest || 0)));
	pz.appendChild(profileStat("Best storm", String(account.stormBest || 0)));
	card.appendChild(pz);

	// --- Free-play best times (per board size × mine density) ---
	card.appendChild(profileSectionTitle("Free-play best times"));
	card.appendChild(profileBestsGrid(account.soloBests || {}));

	// --- Appearance: avatar flag colour + country ---
	card.appendChild(profileSectionTitle("Appearance"));
	card.appendChild(renderAppearance());

	profileStats = {}; // cleared until this account's history aggregates arrive (avoids cross-account staleness)
	renderAchievements();
	// Rating graph + recent games (incl. replay links) + achievement aggregates come from
	// get_match_history → renderMatchHistory.
	if (typeof socket !== "undefined") socket.emit("get_match_history");
	selectProfileTab(profileTab); // restore the active tab (defaults to Overview)
}

// Avatar (recolored flag) palette + country dropdown. Choices persist via set_avatar / set_country and
// update the header chip in place (no full re-render → no refetch/toast churn).
function renderAppearance() {
	var wrap = document.createElement("div");
	wrap.className = "appearance";

	// Country first — its flag becomes the avatar. The colour below is the fallback when no country is set.
	var cLabel = document.createElement("div"); cLabel.className = "appearance-sub"; cLabel.textContent = "Country"; wrap.appendChild(cLabel);
	var sel = document.createElement("select"); sel.className = "country-select";
	var none = document.createElement("option"); none.value = ""; none.textContent = "— None —"; sel.appendChild(none);
	var cur = (account.country || "").toLowerCase();
	countryList().forEach(function(c) {
		var o = document.createElement("option"); o.value = c.code; o.textContent = c.name;
		if (c.code === cur) o.selected = true;
		sel.appendChild(o);
	});
	sel.addEventListener("change", function() { setCountry(sel.value); });
	wrap.appendChild(sel);

	var aLabel = document.createElement("div"); aLabel.className = "appearance-sub"; aLabel.textContent = "Avatar"; wrap.appendChild(aLabel);
	var swatches = document.createElement("div"); swatches.className = "avatar-swatches";
	var current = (account.avatarColor || DEFAULT_AVATAR_COLOR).toLowerCase();
	function swatch(value) {
		var b = document.createElement("button"); b.type = "button";
		b.className = "avatar-swatch" + (value.toLowerCase() === current ? " active" : "");
		b.dataset.color = value;
		b.appendChild(buildAvatarCanvas(value, 44));
		b.addEventListener("click", function() { setAvatarColor(value); });
		swatches.appendChild(b);
	}
	// Image avatar presets first, then the flag-colour pennants (the colour is the fallback when no country).
	if (typeof AVATAR_IMAGES !== "undefined") Object.keys(AVATAR_IMAGES).forEach(function(id) { swatch("img:" + id); });
	AVATAR_COLORS.forEach(function(col) { swatch(col); });
	wrap.appendChild(swatches);
	var note = document.createElement("div"); note.className = "appearance-note";
	note.textContent = "Flag colours are used when no country is set; an image avatar replaces the flag.";
	wrap.appendChild(note);
	return wrap;
}

// Avatar editor modal — reuses the Appearance picker; opened by clicking the home/profile avatar.
function openAvatarEditor() {
	if (!account) return;
	var modal = document.getElementById("avatar_modal");
	if (!modal) {
		modal = document.createElement("div");
		modal.id = "avatar_modal";
		modal.className = "cr-modal";
		modal.setAttribute("hidden", "");
		modal.innerHTML =
			'<div class="cr-backdrop" data-avatar-close></div>' +
			'<div class="cr-dialog" role="dialog" aria-modal="true" aria-labelledby="avatar_modal_title">' +
				'<div class="cr-dialog-head"><h2 id="avatar_modal_title">Your avatar</h2>' +
				'<button class="cr-close" type="button" data-avatar-close aria-label="Close">×</button></div>' +
				'<div id="avatar_modal_body"></div>' +
			'</div>';
		document.body.appendChild(modal);
		modal.addEventListener("click", function(e) { if (e.target.closest("[data-avatar-close]")) modal.setAttribute("hidden", ""); });
		document.addEventListener("keydown", function(e) { if (e.key === "Escape" && !modal.hasAttribute("hidden")) modal.setAttribute("hidden", ""); });
	}
	var body = modal.querySelector("#avatar_modal_body");
	body.innerHTML = "";
	var preview = document.createElement("div"); preview.className = "avatar-editor-preview";
	if (typeof buildAvatarChip === "function") preview.appendChild(buildAvatarChip(account.avatarColor || DEFAULT_AVATAR_COLOR, account.country || null, 80));
	body.appendChild(preview);
	body.appendChild(renderAppearance());
	modal.removeAttribute("hidden");
}

// Repaint every place the local user's avatar shows after a change (profile header + home identity).
function refreshAvatarDisplays() {
	var head = document.querySelector("#profile_card .profile-avatar");
	if (head && typeof buildAvatarChip === "function") {
		var chip = buildAvatarChip(account.avatarColor || DEFAULT_AVATAR_COLOR, account.country || null, 64);
		chip.classList.add("profile-avatar");
		head.replaceWith(chip);
	}
	if (typeof renderDashIdentity === "function") renderDashIdentity();
	var prev = document.querySelector("#avatar_modal .avatar-editor-preview");
	if (prev && typeof buildAvatarChip === "function") { prev.innerHTML = ""; prev.appendChild(buildAvatarChip(account.avatarColor || DEFAULT_AVATAR_COLOR, account.country || null, 80)); }
}
function setAvatarColor(col) {
	account.avatarColor = col;
	if (typeof socket !== "undefined") socket.emit("set_avatar", { color: col });
	refreshAvatarDisplays();
	var btns = document.querySelectorAll(".avatar-swatch");
	for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", (btns[i].dataset.color || "").toLowerCase() === col.toLowerCase());
}
function setCountry(code) {
	account.country = code || null;
	if (typeof socket !== "undefined") socket.emit("set_country", { country: code });
	refreshAvatarDisplays();
}

function formatMemberSince(ms) {
	var d = new Date(ms);
	if (isNaN(d.getTime())) return "—";
	return d.toLocaleString(undefined, { month: "short", year: "numeric" });
}

function profileSectionTitle(textStr) {
	var h = document.createElement("h3");
	h.className = "profile-section-title";
	h.textContent = textStr;
	return h;
}

// One ranked mode's standing: mini rank badge + mode name + tier + rating.
function profileLadderCard(label, rating) {
	var c = document.createElement("div");
	c.className = "profile-ladder";
	var badge = buildRankBadge(rating);
	badge.classList.add("profile-ladder-badge");
	c.appendChild(badge);
	var info = document.createElement("div");
	info.className = "profile-ladder-info";
	var nm = document.createElement("div"); nm.className = "profile-ladder-mode"; nm.textContent = label; info.appendChild(nm);
	var tr = tierFor(rating);
	var tl = document.createElement("div"); tl.className = "profile-ladder-tier"; tl.textContent = tr.name; tl.style.color = tr.color; info.appendChild(tl);
	c.appendChild(info);
	var rt = document.createElement("div"); rt.className = "profile-ladder-rating"; rt.textContent = rating; c.appendChild(rt);
	return c;
}

// Free-play best-time matrix: board size (cols) × mine density (rows). soloBests is
// keyed "<size>_<density%>" (see Solo.js soloComboKey).
var PROFILE_SIZES = [["small", "Small"], ["medium", "Medium"], ["large", "Large"]];
var PROFILE_DENS = [[10, "Low"], [15, "Med"], [20, "High"]];
function profileBestsCell(textStr, cls) {
	var c = document.createElement("div"); c.className = cls; c.textContent = textStr; return c;
}
function profileBestsGrid(bests) {
	var grid = document.createElement("div");
	grid.className = "profile-bests";
	grid.appendChild(profileBestsCell("", "profile-bests-head"));
	PROFILE_SIZES.forEach(function(s) { grid.appendChild(profileBestsCell(s[1], "profile-bests-head")); });
	var any = false;
	PROFILE_DENS.forEach(function(d) {
		grid.appendChild(profileBestsCell(d[1], "profile-bests-rowhead"));
		PROFILE_SIZES.forEach(function(s) {
			var ms = bests[s[0] + "_" + d[0]];
			if (ms != null) any = true;
			var txt = ms == null ? "—" : (typeof formatSoloTime === "function" ? formatSoloTime(ms) : (Math.round(ms / 100) / 10 + "s"));
			grid.appendChild(profileBestsCell(txt, "profile-bests-val" + (ms == null ? " profile-bests-empty" : "")));
		});
	});
	if (any) return grid;
	var wrap = document.createElement("div");
	wrap.appendChild(grid);
	var note = document.createElement("p");
	note.className = "section-stub-note";
	note.style.margin = "0.5rem 0 0";
	note.textContent = "No clears yet — set a time in Solo.";
	wrap.appendChild(note);
	return wrap;
}

// --- Achievements ---------------------------------------------------------------------------
// Data-driven catalogue evaluated against a flat metrics bag = the player's account fields merged
// with the server's `achievementStats` (history aggregates). Each entry is a TIERED counter
// (`value` + `tiers`) or a single BOOLEAN (`bool` + `progress`). Rank/streak achievements read PEAK/
// BEST metrics so they never un-earn. **Adding an achievement is one entry here** (and, if it needs a
// number we don't track yet, one metric in db.achievementStats). Persisting earned-dates / unlock
// toasts is a future layer.
var ACH_ROMAN = ["", "I", "II", "III", "IV", "V"];
function achTierName(rating) { return tierFor(rating).name.replace(/ I+$/, ""); } // bare tier (Silver/Gold/…)
function modeWins(m, s) { return (m.perModeWins && m.perModeWins[s]) || 0; }
function peakOf(m, s) { return (m.peak && m.peak[s]) || m["rating" + s.charAt(0).toUpperCase() + s.slice(1)] || 0; }
function peakOverallOf(m) { return (m.peak && m.peak.overall) || Math.max(m.ratingSprint || 0, m.ratingStandard || 0, m.ratingTournament || 0, m.ratingTerritory || 0); }
function minSolo(m, sizePrefix) {
	var b = m.soloBests, min = Infinity;
	if (b) Object.keys(b).forEach(function(k) { if ((!sizePrefix || k.indexOf(sizePrefix + "_") === 0) && b[k] < min) min = b[k]; });
	return min;
}
function fmtSec(ms) { return (typeof formatSoloTime === "function") ? formatSoloTime(ms) : (Math.round(ms / 100) / 10 + "s"); }

var ACHIEVEMENTS = [
	// Ranked milestones
	{ icon: "🏆", name: "Victories", value: function(m) { return m.wins || 0; }, tiers: [1, 10, 50, 250, 1000], desc: function(t) { return "Win " + t + " ranked match" + (t > 1 ? "es" : ""); } },
	{ icon: "🛡️", name: "Battle-tested", value: function(m) { return m.played || 0; }, tiers: [10, 50, 200, 1000, 5000], desc: function(t) { return "Play " + t + " ranked matches"; } },
	{ icon: "🎯", name: "Specialist", value: function(m) { return m.maxModeWins || 0; }, tiers: [25, 100], desc: function(t) { return "Win " + t + " matches in a single mode"; } },
	{ icon: "⚔️", name: "Two-Sport Star", bool: function(m) { return modeWins(m, "sprint") > 0 && modeWins(m, "standard") > 0; }, progress: function(m) { return ((modeWins(m, "sprint") > 0 ? 1 : 0) + (modeWins(m, "standard") > 0 ? 1 : 0)) + " / 2 modes"; }, desc: function() { return "Win in both Sprint and Standard"; } },
	// Rank — peak-based so they never un-earn
	{ icon: "📈", name: "Ascendant", value: function(m) { return peakOverallOf(m); }, tiers: [600, 1200, 1800, 2400, 3000], desc: function(t) { return "Reach " + achTierName(t) + " (" + t + ")"; } },
	{ icon: "🌟", name: "Well-rounded", bool: function(m) { return peakOf(m, "sprint") >= 1200 && peakOf(m, "standard") >= 1200; }, progress: function(m) { return ((peakOf(m, "sprint") >= 1200 ? 1 : 0) + (peakOf(m, "standard") >= 1200 ? 1 : 0)) + " / 2 at Gold"; }, desc: function() { return "Reach Gold in both Sprint and Standard"; } },
	// Performance
	{ icon: "🔥", name: "On Fire", value: function(m) { return m.winStreakBest || 0; }, tiers: [3, 5, 10, 20], desc: function(t) { return "Win " + t + " matches in a row"; } },
	{ icon: "🌀", name: "Grinder", value: function(m) { return m.bestDayWins || 0; }, tiers: [5, 10], desc: function(t) { return "Win " + t + " matches in one day"; } },
	{ icon: "⚡", name: "Surge", value: function(m) { return m.bestDayGain || 0; }, tiers: [150, 300], desc: function(t) { return "Climb +" + t + " rating in one day"; } },
	{ icon: "💥", name: "Big Swing", value: function(m) { return m.bigSwing || 0; }, tiers: [40], desc: function(t) { return "Gain +" + t + " from a single match"; } },
	{ icon: "🤺", name: "Duelist", value: function(m) { return m.wins1v1 || 0; }, tiers: [10, 50, 200], desc: function(t) { return "Win " + t + " 1v1 matches"; } },
	{ icon: "👑", name: "Free-for-all King", value: function(m) { return m.wins6p || 0; }, tiers: [1, 10], desc: function(t) { return t === 1 ? "Win a 6-player free-for-all" : "Win " + t + " 6-player free-for-alls"; } },
	// Style challenges — solo + racing only (never puzzles); backed by player_stats clear counters.
	{ icon: "🧠", name: "No Flags", value: function(m) { return m.noFlagClears || 0; }, tiers: [1, 10, 50], desc: function(t) { return t === 1 ? "Clear a board without placing a flag" : "Clear " + t + " boards without a flag"; } },
	{ icon: "🎹", name: "Chord Master", value: function(m) { return m.noRevealClears || 0; }, tiers: [1, 10, 50], desc: function(t) { return t === 1 ? "Clear a board without a left-click (chords only)" : "Clear " + t + " boards chord-only"; } },
	{ icon: "🎖️", name: "Sharpshooter", bool: function(m) { return (m.played || 0) >= 20 && (m.wins || 0) / (m.played || 1) >= 0.6; }, progress: function(m) { var p = m.played || 0; return p >= 20 ? (Math.round((m.wins || 0) / p * 100) + "% win rate") : (p + " / 20 matches"); }, desc: function() { return "60%+ win rate over 20+ matches"; } },
	// Speed (free play)
	{ icon: "⏱️", name: "Sub-minute", bool: function(m) { return minSolo(m) < 60000; }, progress: function(m) { var v = minSolo(m); return isFinite(v) ? ("best " + fmtSec(v)) : "no clears yet"; }, desc: function() { return "Clear any free-play board under 1:00"; } },
	{ icon: "🚀", name: "Quick Sweep", bool: function(m) { return minSolo(m, "small") < 30000; }, progress: function(m) { var v = minSolo(m, "small"); return isFinite(v) ? ("best " + fmtSec(v)) : "no Small clears"; }, desc: function() { return "Clear a Small board under 0:30"; } },
	{ icon: "🧭", name: "Free Spirit", value: function(m) { return m.soloBests ? Object.keys(m.soloBests).length : 0; }, tiers: [1, 5, 9], desc: function(t) { return t >= 9 ? "Clear all 9 free-play boards" : "Clear " + t + " free-play board" + (t > 1 ? "s" : ""); } },
	// Puzzles
	{ icon: "🧩", name: "Deductionist", value: function(m) { return m.puzzlesSolved || 0; }, tiers: [10, 100, 500, 2000, 5000], desc: function(t) { return "Solve " + t + " puzzles"; } },
	{ icon: "🧠", name: "Puzzle Rank", value: function(m) { return Math.max(m.peakPuzzleRating || 0, m.puzzleRating || 0); }, tiers: [1000, 1500, 2000, 2500], desc: function(t) { return "Reach a puzzle rating of " + t; } },
	{ icon: "🎲", name: "On a Roll", value: function(m) { return m.streakBest || 0; }, tiers: [5, 10, 25, 50], desc: function(t) { return "Hit an " + t + "-puzzle streak"; } },
	{ icon: "⛈️", name: "Storm Chaser", value: function(m) { return m.stormBest || 0; }, tiers: [15, 30, 50, 75], desc: function(t) { return "Solve " + t + " in one Storm"; } },
	// Daily
	{ icon: "📅", name: "Daily Devotee", value: function(m) { return Math.max(m.dailyStreakBest || 0, m.dailyStreak || 0); }, tiers: [3, 7, 30, 100], desc: function(t) { return "Reach a " + t + "-day daily streak"; } },
	{ icon: "🗓️", name: "Daily Regular", value: function(m) { return m.dailiesSolved || 0; }, tiers: [10, 50, 200], desc: function(t) { return "Solve " + t + " daily puzzles"; } },
	// Dedication
	{ icon: "🎂", name: "Veteran", value: function(m) { return m.createdAt ? Math.floor((Date.now() - m.createdAt) / 86400000) : 0; }, tiers: [30, 180, 365], desc: function(t) { return "Be a member for " + t + " days"; } },
	{ icon: "📆", name: "Regular", value: function(m) { return m.distinctDays || 0; }, tiers: [7, 30, 100], desc: function(t) { return "Play on " + t + " different days"; } },
	{ icon: "🌐", name: "Tried It All", bool: function(m) { return (m.played || 0) > 0 && (m.puzzlesAttempted || 0) > 0 && m.soloBests && Object.keys(m.soloBests).length > 0; }, progress: function(m) { var n = ((m.played || 0) > 0 ? 1 : 0) + ((m.puzzlesAttempted || 0) > 0 ? 1 : 0) + ((m.soloBests && Object.keys(m.soloBests).length > 0) ? 1 : 0); return n + " / 3"; }, desc: function() { return "Play ranked, puzzles, and free play"; } }
];

// Tiered-achievement evaluator (shared by the catalogue and the meta "Collector").
// `reached`/`tierCount` drive the tier-aware "X / Y" header count; `complete` (all tiers done)
// colours the tile green vs. blue for partial progress.
function computeTiered(icon, name, value, tiers, descFn) {
	var reached = 0;
	for (var i = 0; i < tiers.length; i++) if (value >= tiers[i]) reached++;
	var maxed = reached >= tiers.length;
	var next = maxed ? tiers[tiers.length - 1] : tiers[reached];
	return {
		icon: icon,
		name: name + (tiers.length > 1 && reached > 0 ? " " + ACH_ROMAN[reached] : ""),
		desc: descFn(next),
		unlocked: reached > 0, complete: maxed,
		reached: reached, tierCount: tiers.length,
		frac: maxed ? 1 : (next ? Math.min(1, value / next) : 1),
		progText: maxed ? "Complete" : (Math.round(value) + " / " + next)
	};
}

function computeAchievement(a, m) {
	if (a.tiers) return computeTiered(a.icon, a.name, a.value(m), a.tiers, a.desc);
	var on = a.bool(m);
	return { icon: a.icon, name: a.name, desc: a.desc(), unlocked: on, complete: on, reached: on ? 1 : 0, tierCount: 1, frac: on ? 1 : 0, progText: on ? "Unlocked" : a.progress(m) };
}

function achTile(c) {
	var tile = document.createElement("div");
	// complete (all tiers) → green; partly done → blue; not started → dimmed.
	tile.className = "ach-tile " + (c.complete ? "ach-complete" : (c.unlocked ? "ach-partial" : "ach-locked"));
	var icon = document.createElement("span"); icon.className = "ach-icon"; icon.textContent = c.icon; tile.appendChild(icon);
	var body = document.createElement("div"); body.className = "ach-body";
	var nm = document.createElement("div"); nm.className = "ach-name"; nm.textContent = c.name; body.appendChild(nm);
	var ds = document.createElement("div"); ds.className = "ach-desc"; ds.textContent = c.desc; body.appendChild(ds);
	var bar = document.createElement("div"); bar.className = "ach-prog";
	var fill = document.createElement("span"); fill.className = "ach-prog-bar"; fill.style.width = Math.round(c.frac * 100) + "%"; bar.appendChild(fill);
	body.appendChild(bar);
	var pt = document.createElement("div"); pt.className = "ach-prog-text"; pt.textContent = c.progText; body.appendChild(pt);
	tile.appendChild(body);
	return tile;
}

function renderAchievements() {
	var card = document.getElementById("achievements_card");
	if (!card) return;
	if (!account) { card.innerHTML = ""; card.style.display = "none"; return; }
	card.style.display = "";
	card.innerHTML = "";
	// Account fields + the server's history aggregates (empty until get_match_history returns,
	// at which point this re-renders — so account-derived ones show instantly, history ones fill in).
	var metrics = Object.assign({}, account, profileStats);
	var computed = ACHIEVEMENTS.map(function(a) { return computeAchievement(a, metrics); });
	// Meta: "Collector" tracks how many distinct achievements you've unlocked (≥1 tier).
	var unlockedCount = computed.filter(function(c) { return c.unlocked; }).length;
	computed.push(computeTiered("🏅", "Collector", unlockedCount, [10, 20, ACHIEVEMENTS.length], function(t) { return "Unlock " + t + " achievements"; }));

	// Header count is tier-aware: total tiers reached across everything (so multi-tier achievements count).
	var tiersReached = computed.reduce(function(s, c) { return s + c.reached; }, 0);
	var tiersTotal = computed.reduce(function(s, c) { return s + c.tierCount; }, 0);
	var head = document.createElement("div");
	head.className = "ach-head";
	var h = document.createElement("h2"); h.className = "controls-title"; h.textContent = "Achievements"; head.appendChild(h);
	var count = document.createElement("span"); count.className = "ach-count";
	count.textContent = tiersReached + " / " + tiersTotal + " unlocked";
	head.appendChild(count);
	card.appendChild(head);

	var grid = document.createElement("div");
	grid.className = "ach-grid";
	computed.forEach(function(c) { grid.appendChild(achTile(c)); });
	card.appendChild(grid);
}

// --- Match history: rating graph + recent games (from the server's get_match_history) -----------
var matchHistory = { matches: [], ratings: [] };
var profileStats = {}; // server's achievementStats bag, merged into the achievement metrics
var ratingChartStyle = null; // which ladder the rating graph is showing
var STYLE_LABELS = { sprint: "Sprint", standard: "Standard", tournament: "Tournament", territory: "Territory" };
function styleLabelOf(s) { return STYLE_LABELS[s] || s; }
function ordinal(n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function relTime(ms) {
	var secs = Math.floor((Date.now() - ms) / 1000);
	if (secs < 60) return "just now";
	var m = Math.floor(secs / 60); if (m < 60) return m + "m ago";
	var h = Math.floor(m / 60); if (h < 24) return h + "h ago";
	var d = Math.floor(h / 24); if (d < 30) return d + "d ago";
	return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Server reply: cache + render the graph (only if there's rating data) and the games list.
function renderMatchHistory(data) {
	matchHistory = data || { matches: [], ratings: [] };
	profileStats = (data && data.stats) || {};
	var ratingsCard = document.getElementById("rating_history_card");
	var gamesCard = document.getElementById("recent_games_card");
	var hasRatings = matchHistory.ratings && matchHistory.ratings.length > 0;
	var hasMatches = matchHistory.matches && matchHistory.matches.length > 0;
	if (ratingsCard) { ratingsCard.style.display = hasRatings ? "" : "none"; if (hasRatings) renderRatingGraphCard(); }
	if (gamesCard) { gamesCard.style.display = hasMatches ? "" : "none"; if (hasMatches) renderRecentGamesCard(); }
	// Matches tab placeholder when there's nothing to show yet.
	var emptyEl = document.getElementById("matches_empty");
	if (emptyEl) emptyEl.style.display = (!hasRatings && !hasMatches) ? "" : "none";
	// History aggregates just arrived — re-render achievements so the history-based ones fill in,
	// and toast anything that crossed a tier since the last check.
	if (typeof renderAchievements === "function") renderAchievements();
	checkAchievementUnlocks();
}

// --- Achievement unlock toasts ----------------------------------------------------------------
// Diff each achievement's reached-tier count against the last snapshot. The FIRST check after
// (re)connect just baselines silently; later checks (after a match/puzzle/daily/solo result, which
// re-request stats) toast any tier that newly crossed. Driven entirely off the metrics bag.
var achReached = null; // index -> tiers reached, or null until baselined
function checkAchievementUnlocks() {
	if (!account) { achReached = null; return; }
	var metrics = Object.assign({}, account, profileStats);
	var computed = ACHIEVEMENTS.map(function(a) { return computeAchievement(a, metrics); });
	var now = computed.map(function(c) { return c.reached; });
	if (achReached) {
		for (var i = 0; i < computed.length; i++) {
			if (now[i] > (achReached[i] || 0)) showAchievementToast(computed[i]);
		}
	}
	achReached = now;
}

function showAchievementToast(c) {
	var stack = document.getElementById("toast_stack");
	if (!stack) { stack = document.createElement("div"); stack.id = "toast_stack"; stack.className = "toast-stack"; document.body.appendChild(stack); }
	var t = document.createElement("div");
	t.className = "ach-toast" + (c.complete ? " ach-toast-complete" : "");
	var icon = document.createElement("span"); icon.className = "ach-toast-icon"; icon.textContent = c.icon;
	var txt = document.createElement("div"); txt.className = "ach-toast-text";
	var label = document.createElement("div"); label.className = "ach-toast-label"; label.textContent = c.complete ? "Achievement complete" : "Achievement unlocked";
	var name = document.createElement("div"); name.className = "ach-toast-name"; name.textContent = c.name;
	txt.appendChild(label); txt.appendChild(name);
	t.appendChild(icon); t.appendChild(txt);
	stack.appendChild(t);
	if (typeof sound !== "undefined" && sound && sound.beep) { try { sound.beep(c.complete ? 1175 : 988); } catch (e) {} }
	requestAnimationFrame(function() { t.classList.add("ach-toast-in"); });
	setTimeout(function() {
		t.classList.remove("ach-toast-in"); t.classList.add("ach-toast-out");
		setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 450);
	}, 5000);
}

function renderRatingGraphCard() {
	var card = document.getElementById("rating_history_card");
	if (!card) return;
	card.innerHTML = "";
	var buckets = {};
	matchHistory.ratings.forEach(function(p) { (buckets[p.style] = buckets[p.style] || []).push(p); });
	var styles = Object.keys(buckets);
	if (!styles.length) { card.style.display = "none"; return; }
	// Default to the most-played ladder; keep the user's pick if still valid.
	if (!ratingChartStyle || styles.indexOf(ratingChartStyle) < 0) {
		ratingChartStyle = styles.reduce(function(best, s) { return buckets[s].length > buckets[best].length ? s : best; }, styles[0]);
	}
	var h = document.createElement("h2"); h.className = "controls-title"; h.textContent = "Rating history"; card.appendChild(h);
	if (styles.length > 1) {
		var tabs = document.createElement("div"); tabs.className = "lb-tabs rating-chart-tabs";
		styles.forEach(function(s) {
			var b = document.createElement("button"); b.type = "button";
			b.className = "lb-tab" + (s === ratingChartStyle ? " active" : "");
			b.textContent = styleLabelOf(s);
			b.addEventListener("click", function() { ratingChartStyle = s; renderRatingGraphCard(); });
			tabs.appendChild(b);
		});
		card.appendChild(tabs);
	}
	var rows = buckets[ratingChartStyle];
	var points = [];
	if (rows.length) points.push({ t: rows[0].created_at, r: rows[0].rating_before }); // seed from the entry rating
	rows.forEach(function(p) { points.push({ t: p.created_at, r: p.rating_after }); });
	var wrap = document.createElement("div"); wrap.className = "rating-chart-wrap";
	wrap.innerHTML = buildRatingChartSVG(points);
	card.appendChild(wrap);
}

// A simple responsive SVG line chart of rating over time.
function buildRatingChartSVG(points) {
	if (points.length < 2) return '<div class="rating-chart-empty">Current rating: ' + (points[0] ? points[0].r : "—") + " — play more matches to chart your progress.</div>";
	var W = 600, H = 170, L = 42, Rp = 14, Tp = 14, Bp = 22;
	var rs = points.map(function(p) { return p.r; }), ts = points.map(function(p) { return p.t; });
	var rMin = Math.min.apply(null, rs), rMax = Math.max.apply(null, rs);
	if (rMax === rMin) { rMin = Math.max(0, rMin - 50); rMax = rMax + 50; }
	var span = rMax - rMin;
	rMin = Math.max(0, Math.floor((rMin - span * 0.1) / 10) * 10);
	rMax = Math.ceil((rMax + span * 0.1) / 10) * 10;
	var tMin = ts[0], tMax = ts[ts.length - 1]; if (tMax === tMin) tMax = tMin + 1;
	function X(t) { return L + (W - L - Rp) * (t - tMin) / (tMax - tMin); }
	function Y(r) { return Tp + (H - Tp - Bp) * (1 - (r - rMin) / (rMax - rMin)); }
	var d = points.map(function(p, i) { return (i ? "L" : "M") + X(p.t).toFixed(1) + " " + Y(p.r).toFixed(1); }).join(" ");
	var area = d + " L " + X(tMax).toFixed(1) + " " + (H - Bp) + " L " + X(tMin).toFixed(1) + " " + (H - Bp) + " Z";
	var last = points[points.length - 1];
	var svg = '<svg viewBox="0 0 ' + W + " " + H + '" class="rating-chart">';
	[rMin, Math.round((rMin + rMax) / 2), rMax].forEach(function(rv) {
		var y = Y(rv).toFixed(1);
		svg += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - Rp) + '" y2="' + y + '" class="rc-grid"/>';
		svg += '<text x="' + (L - 6) + '" y="' + (parseFloat(y) + 3.5) + '" class="rc-label" text-anchor="end">' + rv + "</text>";
	});
	svg += '<path d="' + area + '" class="rc-area"/>';
	svg += '<path d="' + d + '" class="rc-line"/>';
	svg += '<circle cx="' + X(last.t).toFixed(1) + '" cy="' + Y(last.r).toFixed(1) + '" r="3.5" class="rc-dot"/>';
	svg += "</svg>";
	return svg;
}

function renderRecentGamesCard() {
	var card = document.getElementById("recent_games_card");
	if (!card) return;
	card.innerHTML = "";
	var h = document.createElement("h2"); h.className = "controls-title"; h.textContent = "Recent games"; card.appendChild(h);
	var list = document.createElement("div"); list.className = "games-list";
	matchHistory.matches.slice(0, 20).forEach(function(m) { list.appendChild(gameRow(m)); });
	card.appendChild(list);
}
function gameRow(m) {
	// Rows with a stored replay become a link to the player; the rest stay plain.
	var hasReplay = !!m.replay_id;
	var row = document.createElement(hasReplay ? "a" : "div");
	row.className = "game-row" + (hasReplay ? " game-row-replay" : "");
	if (hasReplay) row.href = "/replay?id=" + m.replay_id;
	var chip = document.createElement("span"); chip.className = "game-chip game-chip-" + m.style; chip.textContent = styleLabelOf(m.style); row.appendChild(chip);
	var res = document.createElement("span"); res.className = "game-result " + (m.won ? "game-won" : "game-lost");
	res.textContent = m.players <= 2 ? (m.won ? "Won" : "Lost") : (ordinal(m.placement) + " of " + m.players);
	row.appendChild(res);
	var opp = document.createElement("span"); opp.className = "game-opp";
	opp.textContent = m.opponent ? ("vs " + m.opponent) : (m.players > 2 ? (m.players + " players") : "");
	row.appendChild(opp);
	var delta = (m.rating_after || 0) - (m.rating_before || 0);
	var d = document.createElement("span"); d.className = "game-delta " + (delta >= 0 ? "game-delta-pos" : "game-delta-neg");
	d.textContent = (delta >= 0 ? "+" : "") + delta; row.appendChild(d);
	var t = document.createElement("span"); t.className = "game-time"; t.textContent = relTime(m.created_at); row.appendChild(t);
	// Watch affordance (only when a replay exists) — keeps the grid's last column consistent.
	var watch = document.createElement("span"); watch.className = "replay-watch";
	if (hasReplay) watch.textContent = "▶ Watch";
	row.appendChild(watch);
	return row;
}

function profileStat(label, value) {
	var box = document.createElement("div");
	box.className = "profile-stat";
	var l = document.createElement("div");
	l.className = "profile-stat-label";
	l.textContent = label;
	box.appendChild(l);
	var v = document.createElement("div");
	v.className = "profile-stat-value";
	v.textContent = value;
	box.appendChild(v);
	return box;
}

function renderHomeRankChips() {
	function applyTo(tierEl, ratingEl, rating, badgeId) {
		var badgeEl = badgeId ? document.getElementById(badgeId) : null;
		if (badgeEl) {
			badgeEl.innerHTML = "";
			if (account && typeof rating === "number") badgeEl.appendChild(buildRankBadge(rating));
		}
		if (!tierEl || !ratingEl) return;
		if (!account) { tierEl.textContent = "—"; tierEl.style.color = ""; ratingEl.textContent = ""; return; }
		var t = tierFor(rating, account.provisional);
		tierEl.textContent = t.name;
		tierEl.style.color = t.color;
		ratingEl.textContent = rating;
	}
	var sprint = account ? account.ratingSprint : null;
	var standard = account ? account.ratingStandard : null;
	// Only Sprint + Standard are surfaced on the home page now; Tournament/Territory live under Admin.
	applyTo(rankTierSprint, rankRatingSprint, sprint, "rank_badge_sprint");
	applyTo(rankTierStandard, rankRatingStandard, standard, "rank_badge_standard");

	var puzzleRatingEl = document.getElementById("puzzle_rating_value");
	var puzzleSolvedEl = document.getElementById("puzzle_solved_count");
	if (puzzleRatingEl) {
		puzzleRatingEl.textContent = account ? (account.puzzleRating || 800) : "—";
	}
	if (puzzleSolvedEl) {
		puzzleSolvedEl.textContent = account
			? (account.puzzlesSolved || 0) + " / " + (account.puzzlesAttempted || 0)
			: "";
	}
	var streakBestEl = document.getElementById("puzzle_streak_best");
	var stormBestEl = document.getElementById("puzzle_storm_best");
	if (streakBestEl) streakBestEl.textContent = account ? (account.streakBest || 0) : "—";
	if (stormBestEl) stormBestEl.textContent = account ? (account.stormBest || 0) : "—";
	var dailyStreakEl = document.getElementById("puzzle_daily_streak");
	var dailyStatusEl = document.getElementById("puzzle_daily_status");
	if (dailyStreakEl) dailyStreakEl.textContent = account ? (account.dailyStreak || 0) : "—";
	if (dailyStatusEl) {
		if (!account) { dailyStatusEl.textContent = ""; }
		else if (!account.dailyAttempt) { dailyStatusEl.textContent = "Not played"; }
		else if (account.dailyAttempt.solved) { dailyStatusEl.textContent = "Solved today"; }
		else { dailyStatusEl.textContent = "Missed today"; }
	}
	renderLobbyDailyBoard();
	renderLobbyDailyState();
	renderDashIdentity();
	renderModeBoardPreviews();
}

// ---- Home dashboard: the "you" banner + the per-mode board previews ----

// The "you" banner: rank badge (overall = best across modes), name, overall tier/rating, and a
// few real lifetime stats. No fabricated "this week" trend — we don't track it yet.
function renderDashIdentity() {
	var nameEl = document.getElementById("dash_you_name");
	if (!nameEl) return; // dashboard markup not present
	var badgeEl = document.getElementById("dash_you_badge");
	var lineEl = document.getElementById("dash_you_line");
	var statsEl = document.getElementById("dash_you_stats");
	nameEl.textContent = (typeof myName !== "undefined" && myName) || (account && account.name) || "Player";
	if (!account) {
		if (badgeEl) badgeEl.innerHTML = "";
		if (lineEl) lineEl.textContent = "Sign in to track your rank.";
		if (statsEl) statsEl.innerHTML = "";
		return;
	}
	// Dota-style identity: a tall avatar portrait on the left, name on top, rank/tier on the line beneath.
	var nameRow = nameEl.parentNode;
	if (nameRow) { var stale = nameRow.querySelector(".dash-avatar"); if (stale) stale.remove(); } // drop the old inline avatar
	var overall = overallRating(account);
	var t = tierFor(overall, account.provisional);
	if (badgeEl) {
		badgeEl.innerHTML = "";
		if (typeof buildAvatarChip === "function") badgeEl.appendChild(buildAvatarChip(account.avatarColor || DEFAULT_AVATAR_COLOR, account.country || null, 52));
		// Click the home avatar to edit it.
		badgeEl.classList.add("dash-avatar-edit");
		badgeEl.title = "Edit avatar";
		badgeEl.onclick = function() { if (typeof openAvatarEditor === "function") openAvatarEditor(); };
	}
	if (lineEl) lineEl.innerHTML = "Overall <b style=\"color:" + t.color + "\">" + t.name + "</b> · " + overall;
	if (statsEl) {
		var played = account.played || 0, wins = account.wins || 0;
		var wr = played ? Math.round(wins / played * 100) + "%" : "—";
		function cell(label, val) { return "<span class=\"dash-stat\"><b>" + val + "</b><span>" + label + "</span></span>"; }
		statsEl.innerHTML = cell("Played", played) + cell("Win rate", wr) + cell("Daily streak", "🔥 " + (account.dailyStreak || 0));
	}
}

// Fixed board previews for each mode, in the standard board format the game renderer
// (buildLearnPuzzle) consumes: lists of [row, col] for `mines` and `flagged` (flags pre-placed). The
// open area is given as a single `revealStart` cell — the renderer cascades from there exactly like a
// real click. Sprint is a sparse, wide-open field; Standard a tight opening in a denser minefield;
// Custom a medium board. Puzzles is a crafted deduction position with no 0-cell to cascade from, so it
// lists its revealed cells explicitly. Rendered once per load and frozen (pointer-events: none).
var DASH_MODE_BOARDS = {
	sprint: {
		rows: 6, cols: 10,
		mines: [[0,0],[0,3],[1,1],[3,3],[3,7],[3,8]],
		revealStart: [3, 5],
		flagged: [[3,3],[3,7],[3,8]]
	},
	standard: {
		rows: 6, cols: 9,
		mines: [[0,2],[0,3],[1,1],[1,6],[2,0],[2,6],[2,8],[3,0],[3,6],[3,7],[3,8],[4,1],[4,8],[5,2]],
		revealStart: [3, 4],
		flagged: [[1,6],[2,6],[3,6],[3,7],[5,2]]
	},
	solo: {
		// Relaxed free-play board: a wide-open cascade with a couple of flags placed — the
		// no-pressure feel of practice, distinct from the racing modes' tighter openings.
		rows: 6, cols: 9,
		mines: [[0,0],[0,8],[1,4],[3,1],[3,7],[5,3],[5,5]],
		revealStart: [3, 4],
		flagged: [[1,4],[3,7]]
	},
	puzzles: {
		rows: 6, cols: 6,
		mines: [[0,3],[1,0],[1,2],[2,0],[3,5],[4,3],[5,2]],
		revealed: [[1,1],[1,3],[1,4],[2,1],[2,2],[2,3],[2,4],[3,1],[3,2],[3,3],[3,4],[4,1],[4,2],[4,4]],
		flagged: []
	}
};
function renderModeBoardPreviews() {
	if (typeof buildLearnPuzzle !== "function") return;
	Object.keys(DASH_MODE_BOARDS).forEach(function(key) {
		var slot = document.getElementById("dash_board_" + key);
		if (!slot || slot.firstChild) return;
		var b = DASH_MODE_BOARDS[key];
		var el = buildLearnPuzzle({
			title: "", rows: b.rows, cols: b.cols, mines: b.mines,
			revealed: b.revealed, revealStart: b.revealStart, flagged: b.flagged,
			skin: "classic" // home-page previews always show the default skin, not the player's pick
		}, false, function() {});
		el.classList.add("dash-board-preview");
		slot.appendChild(el);
	});
}

// Drives state-aware styling on the daily hero (solved / missed / new),
// the button text, and the corner badge over the board preview.
function renderLobbyDailyState() {
	var hero = document.querySelector(".lobby-daily-hero");
	if (!hero) return;
	hero.classList.remove("daily-solved", "daily-missed", "daily-fresh");
	var btn = document.getElementById("open_daily_button");
	var attempt = account && account.dailyAttempt;
	if (!account) {
		if (btn) { btn.textContent = "Sign in to play"; btn.disabled = true; }
		return;
	}
	if (!attempt) {
		hero.classList.add("daily-fresh");
		if (btn) { btn.textContent = "Play today's puzzle"; btn.disabled = false; }
	} else if (attempt.solved) {
		hero.classList.add("daily-solved");
		if (btn) { btn.textContent = "Solved — back tomorrow"; btn.disabled = true; }
	} else {
		hero.classList.add("daily-missed");
		if (btn) { btn.textContent = "Missed — back tomorrow"; btn.disabled = true; }
	}
}

// Paints the daily puzzle's starting position into the lobby hero card.
// Read-only — clicks fall through to the "Play today's puzzle" button.
function renderLobbyDailyBoard() {
	var container = document.getElementById("lobby_daily_board");
	if (!container) return;
	var dateEl = document.getElementById("lobby_daily_date");
	var board = account && account.dailyBoard;
	if (!board) {
		container.innerHTML = '<div class="lobby-daily-board-empty">Sign in to see today’s puzzle.</div>';
		if (dateEl) dateEl.textContent = "";
		return;
	}
	if (dateEl) dateEl.textContent = account.dailyDate || "";
	if (container.dataset.boardKey === board.rows + "x" + board.cols + "@" + account.dailyDate) return;
	container.dataset.boardKey = board.rows + "x" + board.cols + "@" + account.dailyDate;
	container.innerHTML = "";
	var pseudo = {
		title: "",
		rows: board.rows,
		cols: board.cols,
		mines: board.mines,
		revealed: board.revealed,
		skin: "classic" // daily-puzzle hero on the home page always uses the default skin
	};
	var puzzleEl = buildLearnPuzzle(pseudo, false, function() {});
	puzzleEl.classList.add("lobby-daily-preview");
	container.appendChild(puzzleEl);
}
