// In-match result overlays: pre-round "Match reveal" panel, tournament round
// elimination card, per-round result, series end, and the ranking-delta UI
// (banner + floating delta on the ratingChip). Driven by socket events
// dispatched in the main inline script (match_reveal, round_ended,
// series_ended, etc).
//
// Depends on Ranking.* helpers (tierFor, medal, buildRankBadge,
// buildRankSwapColumn, ordinal, formatClearTime) and a handful of live-game
// globals (account, id, socket, currentRoom, ratingChip, formatGameProgress,
// presentPanel, ...) defined in the main inline script.

// Ranked pre-match reveal. Each mode gets its own body layout — 1v1 is a big
// VS card with both players' rank + name; 6-player is a grid of medium cards;
// tournament keeps the existing flat list since 16 rows benefits from the
// compact format.
function showMatchRevealPanel(delayMs) {
	var panel = document.createElement("div");
	panel.className = "result-panel pre-match";

	var header = document.createElement("div");
	header.className = "result-header result-header-series";
	var modeLabel = (MODE_LABELS[currentRankedMode] || "Ranked");
	header.textContent = modeLabel + " match found";
	panel.appendChild(header);

	var players = (currentRoom && currentRoom.players ? currentRoom.players.slice() : []);
	if (currentRankedMode === "duo") {
		panel.appendChild(buildOneVOneBody(players));
	} else if (currentRankedMode === "six") {
		panel.appendChild(buildSixPlayerBody(players));
	} else {
		// tournament (or unrecognised) — keep the compact roster list.
		var sub = document.createElement("div");
		sub.className = "result-foot";
		sub.textContent = players.length + " players";
		panel.appendChild(sub);
		panel.appendChild(buildRosterList(players));
	}

	presentPanel(panel);
}

function buildRosterList(players) {
	var list = document.createElement("ol");
	list.className = "result-list";
	var sorted = players.slice().sort(function(a, b) {
		var ar = typeof a.rating === "number" ? a.rating : 0;
		var br = typeof b.rating === "number" ? b.rating : 0;
		return br - ar;
	});
	sorted.forEach(function(p, idx) {
		var tier = typeof p.rating === "number" ? tierFor(p.rating, p.provisional) : null;
		var row = resultRow(String(idx + 1) + ".", p.id === id ? "You" : p.name, "", "",
			{ me: p.id === id, top: idx === 0, tier: tier });
		row.style.animationDelay = (idx * 35) + "ms";
		list.appendChild(row);
	});
	return list;
}

// Big two-card VS layout for ranked 1v1: rank badge + name + tier label per
// side, with a giant "VS" wedge between them.
function buildOneVOneBody(players) {
	var me = null, opp = null;
	for (var i = 0; i < players.length; i++) {
		if (players[i].id === id) me = players[i];
		else if (!opp) opp = players[i];
	}
	var wrap = document.createElement("div");
	wrap.className = "vs-display";
	if (me) wrap.appendChild(buildVSCard(me, true));
	var divider = document.createElement("div");
	divider.className = "vs-divider";
	divider.textContent = "VS";
	wrap.appendChild(divider);
	if (opp) wrap.appendChild(buildVSCard(opp, false));
	return wrap;
}

function buildVSCard(player, isMe) {
	var card = document.createElement("div");
	card.className = "vs-card" + (isMe ? " vs-card-me" : "");
	if (typeof player.rating === "number") {
		card.appendChild(buildRankBadge(player.rating));
	}
	var name = document.createElement("div");
	name.className = "vs-name";
	name.textContent = isMe ? "You" : (player.name || "Anonymous");
	card.appendChild(name);
	if (typeof player.rating === "number") {
		var t = tierFor(player.rating, player.provisional);
		var rating = document.createElement("div");
		rating.className = "vs-rating";
		rating.style.color = t.color;
		rating.textContent = t.name + " · " + (player.provisional ? "~" : "") + player.rating;
		card.appendChild(rating);
	}
	return card;
}

// 6-player grid: 3×2 cards, each with the rank badge + name + tier.
function buildSixPlayerBody(players) {
	var sorted = players.slice().sort(function(a, b) {
		var ar = typeof a.rating === "number" ? a.rating : 0;
		var br = typeof b.rating === "number" ? b.rating : 0;
		return br - ar;
	});
	var wrap = document.createElement("div");
	wrap.className = "six-grid";
	sorted.forEach(function(p, idx) {
		var card = document.createElement("div");
		card.className = "six-card" + (p.id === id ? " six-card-me" : "");
		card.style.animationDelay = (idx * 50) + "ms";
		if (typeof p.rating === "number") {
			card.appendChild(buildRankBadge(p.rating));
		}
		var name = document.createElement("div");
		name.className = "six-name";
		name.textContent = p.id === id ? "You" : (p.name || "Anonymous");
		card.appendChild(name);
		if (typeof p.rating === "number") {
			var t = tierFor(p.rating, p.provisional);
			var rating = document.createElement("div");
			rating.className = "six-rating";
			rating.style.color = t.color;
			rating.textContent = t.name + " · " + (p.provisional ? "~" : "") + p.rating;
			card.appendChild(rating);
		}
		wrap.appendChild(card);
	});
	return wrap;
}

function showTournamentEliminationPanel(data) {
	var panel = document.createElement("div");
	panel.className = "result-panel";

	var header = document.createElement("div");
	header.className = "result-header";
	header.textContent = "You're out — round " + data.round + " of " + (data.totalRounds || "?");
	panel.appendChild(header);

	var place = document.createElement("div");
	place.className = "tournament-place";
	place.textContent = "Final place #" + data.place + " / " + data.totalParticipants;
	panel.appendChild(place);

	if (typeof data.ratingDelta === "number") {
		var delta = document.createElement("div");
		delta.className = "tournament-delta " + (data.ratingDelta >= 0 ? "tournament-delta-up" : "tournament-delta-down");
		delta.textContent = (data.ratingDelta >= 0 ? "▲ +" : "▼ ") + data.ratingDelta + " rating";
		panel.appendChild(delta);
	}

	var foot = document.createElement("div");
	foot.className = "result-foot";
	foot.textContent = "Spectate the rest of the tournament, or bounce.";
	panel.appendChild(foot);

	var actions = document.createElement("div");
	actions.className = "result-actions";

	// Primary CTA = spectate. Most players want to watch the bracket play
	// out, especially after an early elimination.
	var watch = document.createElement("button");
	watch.className = "btn btn-primary";
	watch.textContent = "Spectate";
	watch.addEventListener("click", function() {
		elimPanelDismissed = true;
		hideOverlay();
	});
	actions.appendChild(watch);

	var again = document.createElement("button");
	again.className = "btn btn-secondary";
	again.textContent = "Find new match";
	again.addEventListener("click", function() {
		socket.emit("leave_room");
		findRanked("tournament");
	});
	actions.appendChild(again);

	var back = document.createElement("button");
	back.className = "btn btn-ghost";
	back.textContent = "Back to menu";
	back.addEventListener("click", function() {
		socket.emit("leave_room");
	});
	actions.appendChild(back);

	panel.appendChild(actions);

	// No auto-hide — replaced when series_ended fires, dismissed via Spectate, or when the player leaves.
	presentPanel(panel, "lose");
}
function resultRow(rankLabel, nameText, detailText, pointsText, opts) {
	opts = opts || {};
	var row = document.createElement("li");
	row.className = "result-row";
	if (opts.me) row.classList.add("result-row-me");
	if (opts.top) row.classList.add("result-row-top");

	var place = document.createElement("span");
	place.className = "result-place";
	place.textContent = rankLabel;
	row.appendChild(place);

	var name = document.createElement("span");
	name.className = "result-name";
	name.textContent = nameText;
	if (opts.tier) {
		var tierChip = document.createElement("span");
		tierChip.className = "result-tier";
		tierChip.textContent = opts.tier.name;
		tierChip.style.color = opts.tier.color;
		name.appendChild(document.createTextNode(" "));
		name.appendChild(tierChip);
	}
	row.appendChild(name);

	var detail = document.createElement("span");
	detail.className = "result-detail";
	detail.textContent = detailText;
	row.appendChild(detail);

	var pts = document.createElement("span");
	pts.className = "result-points";
	pts.textContent = pointsText;
	row.appendChild(pts);
	return row;
}

function presentPanel(panel, kind, autoHideMs) {
	boardOverlay.style.display = "";
	boardOverlay.className = "board-overlay board-overlay-panel" + (kind ? " board-overlay-" + kind : "");
	boardOverlay.innerHTML = "";
	boardOverlay.appendChild(panel);
	if (autoHideMs) {
		setTimeout(function() {
			if (boardOverlay.contains(panel)) hideOverlay();
		}, autoHideMs);
	}
}

// While a result panel is open, Enter triggers the primary action (the
// first .btn-primary in the overlay). Every "play again" dialog —
// puzzle run outcome, solo outcome, multiplayer series end, tournament
// elimination — keeps its main CTA as the first btn-primary, so this
// single handler covers all of them.
document.addEventListener("keydown", function(e) {
	if (e.key !== "Enter") return;
	if (!boardOverlay || boardOverlay.style.display === "none") return;
	var tag = (e.target && e.target.tagName) || "";
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	var btn = boardOverlay.querySelector(".btn-primary");
	if (!btn) return;
	e.preventDefault();
	btn.click();
});

function showRoundResultPanel(data) {
	var standings = data.standings || [];
	var won = data.winnerId === id;
	var panel = document.createElement("div");
	panel.className = "result-panel";

	var header = document.createElement("div");
	header.className = "result-header";
	if (won) header.textContent = "🏆 You won round " + data.gameNumber + "!";
	else if (data.winnerName) header.textContent = "🏆 " + data.winnerName + " takes round " + data.gameNumber;
	else header.textContent = "Round " + data.gameNumber + " — tie!";
	panel.appendChild(header);

	var list = document.createElement("ol");
	list.className = "result-list";
	standings.forEach(function(s, idx) {
		var detail = s.finished
			? (s.finishMs != null ? "Cleared " + formatClearTime(s.finishMs) : "Cleared")
			: s.safeCount + " cells";
		if (s.ratingDelta != null) {
			detail += "  " + (s.ratingDelta >= 0 ? "▲" : "▼") + Math.abs(s.ratingDelta);
		}
		var tier = typeof s.rating === "number" ? tierFor(s.rating, s.provisional) : null;
		var row = resultRow(medal(s.rank), s.id === id ? "You" : s.name, detail, "+" + s.points,
			{ me: s.id === id, top: s.rank === 1, tier: tier });
		row.style.animationDelay = (idx * 55) + "ms";
		list.appendChild(row);
	});
	panel.appendChild(list);

	var foot = document.createElement("div");
	foot.className = "result-foot";
	foot.textContent = formatGameProgress(data.gameNumber, data.gameCount, (currentRoom && currentRoom.scoreTarget) || data.scoreTarget);
	panel.appendChild(foot);

	// Ranked rating now only changes once at series end, so the per-round panel
	// doesn't apply the bump anymore — see series_ended → showSeriesResultPanel.

	presentPanel(panel, won ? "win" : "lose");
}

// Apply our own ranked rating change to the badge (server already persisted it).
// `opts.suppressBanner` skips the centered RANK UP / DOWN banner — useful when
// the series-end panel is already showing the old → new icon swap in its
// rank column, so the two indicators don't fight for attention.
function updateRatingFromStandings(standings, opts) {
	opts = opts || {};
	if (!account) return;
	var mine = standings.find(function(s) { return s.id === id; });
	if (!mine || typeof mine.rating !== "number") return;
	var oldRating = account.rating;
	var oldTier = tierFor(oldRating, account.provisional);
	account.rating = mine.rating;
	if (mine.provisional != null) account.provisional = mine.provisional;
	var newTier = tierFor(account.rating, account.provisional);
	renderRatingBadge();
	ratingChip.classList.remove("rating-chip-bump");
	void ratingChip.offsetWidth;
	ratingChip.classList.add("rating-chip-bump");
	var delta = account.rating - oldRating;
	if (delta !== 0 && !opts.suppressDelta) showRatingDelta(delta);
	if (newTier.name !== oldTier.name && !opts.suppressBanner) showRankChangeBanner(account.rating > oldRating, newTier);
}

// Floating "+15"/"-15" that drifts up from below the topbar rating chip, so
// the animation always travels into the viewport even when the chip is near
// the top of the screen.
function showRatingDelta(delta) {
	var rect = ratingChip.getBoundingClientRect();
	var el = document.createElement("span");
	el.className = "rating-delta " + (delta > 0 ? "rating-delta-gain" : "rating-delta-loss");
	el.textContent = (delta > 0 ? "+" : "") + delta;
	el.style.left = (rect.left + rect.width / 2 - 18) + "px";
	el.style.top = (rect.bottom + 6) + "px";
	document.body.appendChild(el);
	setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 1900);
}

// Centered banner shown when crossing a sub-tier boundary.
function showRankChangeBanner(promoted, tier) {
	var el = document.createElement("div");
	el.className = "rank-banner " + (promoted ? "promoted" : "demoted");
	var label = document.createElement("div");
	label.className = "rank-banner-label";
	label.textContent = promoted ? "RANK UP" : "RANK DOWN";
	el.appendChild(label);
	var tierEl = document.createElement("div");
	tierEl.className = "rank-banner-tier";
	tierEl.textContent = tier.name;
	el.appendChild(tierEl);
	document.body.appendChild(el);
	setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 2900);
}

function showSeriesResultPanel(data) {
	// Prefer the new `standings` (with Elo deltas + tiers); fall back to plain
	// `scores` for casual rooms that don't produce standings.
	var entries = (data.standings && data.standings.length)
		? data.standings.slice()
		: (data.scores || []).slice().sort(function(a, b) { return b.score - a.score; });
	var won = data.winnerId === id;
	var panel = document.createElement("div");
	panel.className = "result-panel";

	var header = document.createElement("div");
	header.className = "result-header result-header-series";
	if (!data.winnerId) header.textContent = "Series tied!";
	else if (won) header.textContent = "🏆 You win the series!";
	else header.textContent = "🏆 " + data.winnerName + " wins the series!";
	panel.appendChild(header);

	var list = document.createElement("ol");
	list.className = "result-list";
	entries.forEach(function(s, idx) {
		var rank = s.rank != null ? s.rank : (idx + 1);
		var detail = "";
		if (s.ratingDelta != null) detail = (s.ratingDelta >= 0 ? "▲" : "▼") + Math.abs(s.ratingDelta);
		var tier = typeof s.rating === "number" ? tierFor(s.rating, s.provisional) : null;
		var row = resultRow(medal(rank), s.id === id ? "You" : s.name, detail, String(s.score),
			{ me: s.id === id, top: rank === 1, tier: tier });
		row.style.animationDelay = (idx * 55) + "ms";
		list.appendChild(row);
	});

	// Body wraps the rank-swap column (if ranked) and the standings list side
	// by side. For casual rooms (no rating change), just append the list.
	var mine = (data.standings || []).find(function(s) { return s.id === id; });
	if (data.ranked && account && mine && typeof mine.rating === "number") {
		var body = document.createElement("div");
		body.className = "result-body";
		body.appendChild(buildRankSwapColumn(account.rating, mine.rating, mine.ratingDelta));
		body.appendChild(list);
		panel.appendChild(body);
	} else {
		panel.appendChild(list);
	}

	var foot = document.createElement("div");
	foot.className = "result-foot";
	foot.textContent = "Final standings";
	panel.appendChild(foot);

	// Apply the ranked rating change once, at series end. The rank-swap column
	// already shows the old → new icon animation, so suppress the centered
	// banner; the topbar bump + floating delta still fire.
	if (data.standings) updateRatingFromStandings(data.standings, { suppressBanner: true });

	// Ranked single-match flow: players explicitly choose to re-queue or leave.
	// Casual rooms keep the existing auto-hide behaviour.
	if (data.ranked) {
		var actions = document.createElement("div");
		actions.className = "result-actions";

		var again = document.createElement("button");
		again.className = "btn btn-primary";
		again.textContent = "Play another";
		again.addEventListener("click", function() {
			var mode = data.mode || currentRankedMode || "duo";
			socket.emit("leave_room");
			findRanked(mode);
		});
		actions.appendChild(again);

		var back = document.createElement("button");
		back.className = "btn btn-secondary";
		back.textContent = "Back to menu";
		back.addEventListener("click", function() {
			socket.emit("leave_room");
		});
		actions.appendChild(back);

		panel.appendChild(actions);
		presentPanel(panel, won ? "win" : "lose"); // no auto-hide — player decides
		// Focus "Play another" so Enter re-queues without reaching for the mouse.
		try { again.focus(); } catch (e) {}
	} else {
		presentPanel(panel, won ? "win" : "lose", 5500);
	}
}
