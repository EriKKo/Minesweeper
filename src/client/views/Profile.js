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
function renderProfile() {
	// Board skin + keybindings are local (not tied to an account), so render them
	// regardless of sign-in state.
	if (typeof renderBoardSkins === "function") renderBoardSkins();
	if (typeof renderKeybindings === "function") renderKeybindings();
	var card = document.getElementById("profile_card");
	if (!card) return;
	if (!account) {
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
	card.innerHTML = "";

	// --- Identity: overall rank badge + name + tier/rating + member since ---
	var summary = document.createElement("div");
	summary.className = "profile-summary";
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
	ladders.appendChild(profileLadderCard("Tournament", account.ratingTournament || 0));
	ladders.appendChild(profileLadderCard("Territory", account.ratingTerritory || 0));
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

	renderAchievements();
	// Rating graph + recent games come from a separate request (match_history handler → renderMatchHistory).
	if (typeof socket !== "undefined") socket.emit("get_match_history");
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
// Data-driven catalogue evaluated against the player's live stats (the same trusted numbers the
// server sends). Each entry is either a TIERED counter (value + tiers thresholds) or a single
// BOOLEAN (bool + progress text). Persisting earned-dates / unlock toasts is a future layer.
var ACH_ROMAN = ["", "I", "II", "III", "IV", "V"];
function achTierName(rating) { return tierFor(rating).name.replace(/ I+$/, ""); } // bare tier (Silver/Gold/…)

var ACHIEVEMENTS = [
	{ id: "wins", icon: "🏆", name: "Victories", value: function(a) { return a.wins || 0; }, tiers: [1, 10, 50, 250], desc: function(t) { return "Win " + t + " ranked match" + (t > 1 ? "es" : ""); } },
	{ id: "played", icon: "⚔️", name: "Battle-tested", value: function(a) { return a.played || 0; }, tiers: [10, 50, 200, 1000], desc: function(t) { return "Play " + t + " ranked matches"; } },
	{ id: "climb", icon: "📈", name: "Ascendant", value: function(a) { return overallRating(a); }, tiers: [600, 1200, 1800, 2400, 3000], desc: function(t) { return "Reach " + achTierName(t) + " (" + t + ")"; } },
	{ id: "allmodes", icon: "🎯", name: "All-Rounder", value: function(a) { return ["ratingSprint", "ratingStandard", "ratingTournament", "ratingTerritory"].filter(function(k) { return (a[k] || 0) > 0; }).length; }, tiers: [4], desc: function() { return "Earn a rating in all 4 ranked modes"; } },
	{ id: "winrate", icon: "🎖️", name: "Sharpshooter", bool: function(a) { return (a.played || 0) >= 20 && (a.wins || 0) / (a.played || 1) >= 0.6; }, progress: function(a) { var p = a.played || 0; return p >= 20 ? (Math.round((a.wins || 0) / p * 100) + "% win rate") : (p + " / 20 matches"); }, desc: function() { return "60%+ win rate over 20+ matches"; } },
	{ id: "solved", icon: "🧩", name: "Deductionist", value: function(a) { return a.puzzlesSolved || 0; }, tiers: [10, 100, 500, 2000], desc: function(t) { return "Solve " + t + " puzzles"; } },
	{ id: "streak", icon: "🔥", name: "On a Roll", value: function(a) { return a.streakBest || 0; }, tiers: [5, 10, 25], desc: function(t) { return t + "-puzzle streak"; } },
	{ id: "storm", icon: "⛈️", name: "Storm Chaser", value: function(a) { return a.stormBest || 0; }, tiers: [15, 30, 50], desc: function(t) { return "Solve " + t + " in one Storm"; } },
	{ id: "daily", icon: "📅", name: "Daily Devotee", value: function(a) { return a.dailyStreak || 0; }, tiers: [3, 7, 30], desc: function(t) { return t + "-day daily streak"; } },
	{ id: "freeplay", icon: "⏱️", name: "Free Spirit", value: function(a) { return a.soloBests ? Object.keys(a.soloBests).length : 0; }, tiers: [1, 5, 9], desc: function(t) { return t >= 9 ? "Clear all 9 free-play boards" : "Clear " + t + " free-play board" + (t > 1 ? "s" : ""); } }
];

function computeAchievement(a, account) {
	if (a.tiers) {
		var v = a.value(account);
		var reached = 0;
		for (var i = 0; i < a.tiers.length; i++) if (v >= a.tiers[i]) reached++;
		var maxed = reached >= a.tiers.length;
		var next = maxed ? a.tiers[a.tiers.length - 1] : a.tiers[reached];
		return {
			icon: a.icon,
			name: a.name + (a.tiers.length > 1 && reached > 0 ? " " + ACH_ROMAN[reached] : ""),
			desc: a.desc(next),
			unlocked: reached > 0,
			frac: maxed ? 1 : (next ? Math.min(1, v / next) : 1),
			progText: maxed ? "Complete" : (v + " / " + next)
		};
	}
	var on = a.bool(account);
	return { icon: a.icon, name: a.name, desc: a.desc(), unlocked: on, frac: on ? 1 : 0, progText: on ? "Unlocked" : a.progress(account) };
}

function achTile(c) {
	var tile = document.createElement("div");
	tile.className = "ach-tile " + (c.unlocked ? "ach-earned" : "ach-locked");
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
	var computed = ACHIEVEMENTS.map(function(a) { return computeAchievement(a, account); });
	var unlockedCount = computed.filter(function(c) { return c.unlocked; }).length;

	var head = document.createElement("div");
	head.className = "ach-head";
	var h = document.createElement("h2"); h.className = "controls-title"; h.textContent = "Achievements"; head.appendChild(h);
	var count = document.createElement("span"); count.className = "ach-count"; count.textContent = unlockedCount + " / " + computed.length + " unlocked"; head.appendChild(count);
	card.appendChild(head);

	var grid = document.createElement("div");
	grid.className = "ach-grid";
	computed.forEach(function(c) { grid.appendChild(achTile(c)); });
	card.appendChild(grid);
}

// --- Match history: rating graph + recent games (from the server's get_match_history) -----------
var matchHistory = { matches: [], ratings: [] };
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
	var ratingsCard = document.getElementById("rating_history_card");
	var gamesCard = document.getElementById("recent_games_card");
	var hasRatings = matchHistory.ratings && matchHistory.ratings.length > 0;
	var hasMatches = matchHistory.matches && matchHistory.matches.length > 0;
	if (ratingsCard) { ratingsCard.style.display = hasRatings ? "" : "none"; if (hasRatings) renderRatingGraphCard(); }
	if (gamesCard) { gamesCard.style.display = hasMatches ? "" : "none"; if (hasMatches) renderRecentGamesCard(); }
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
	var row = document.createElement("div"); row.className = "game-row";
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
	var overall = overallRating(account);
	var t = tierFor(overall, account.provisional);
	if (badgeEl) { badgeEl.innerHTML = ""; badgeEl.appendChild(buildRankBadge(overall)); }
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
