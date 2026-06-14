// In-match result overlays: the on-board YOU WIN / YOU LOSE banners, the ranked result modal
// (rating change + tier progression), the tournament champion / elimination cards, and the
// ranking-delta UI. Driven by socket events dispatched in the main inline script (game_result,
// series_ended, etc). The per-round and series-standings dialogues were removed; the pre-game
// roster modal too (the search waiting room already shows who's joining).
//
// Depends on Ranking.* helpers (tierFor, tierProgress, medal, buildRankBadge, ordinal,
// formatClearTime) and a handful of live-game globals (account, id, socket, currentRoom,
// ratingChip, findRanked, leaveRoom, ...) defined in the main inline script.

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

function prefersReducedMotion() {
	return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Animate a number element from → to (easeOutCubic), so a rating change lands as a reward
// rather than snapping. Honours reduced-motion.
function countUpNumber(el, from, to, ms) {
	if (!el) return;
	from = Math.round(from); to = Math.round(to);
	if (prefersReducedMotion() || from === to) { el.textContent = String(to); return; }
	var start = null, dur = ms || 900;
	function frame(ts) {
		if (start === null) start = ts;
		var t = Math.min(1, (ts - start) / dur);
		var e = 1 - Math.pow(1 - t, 3);
		el.textContent = String(Math.round(from + (to - from) * e));
		if (t < 1) requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
}

// Rank-up/down fanfare for the results modal if the tier changed. (The win/lose sound itself
// plays earlier, at the on-board YOU WIN / YOU LOSE moment — see series_ended.) `oldRating` is
// captured before the rating badge updates, so we can detect a tier crossing.
function playResultMoment(won, ranked, oldRating, newRating) {
	if (ranked && typeof oldRating === "number" && typeof newRating === "number") {
		var prov = account && account.provisional;
		var crossed = tierFor(oldRating, prov).name !== tierFor(newRating, prov).name;
		if (crossed && typeof sound !== "undefined") (newRating > oldRating ? sound.rankUp : sound.rankDown)();
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

// (Per-round and series-standings result dialogues were removed — the on-board YOU WIN/YOU LOSE
// banners convey the outcome, and ranked shows the rating/tier-progression modal below.)

// Apply our own ranked rating change to the badge (server already persisted it).
// `opts.suppressBanner` skips the centered RANK UP / DOWN banner — useful when
// the series-end panel is already showing the old → new icon swap in its
// rank column, so the two indicators don't fight for attention.
// Each ranked mode key (sprint_duo, standard_six, tournament, territory_quad…)
// is prefixed by its playstyle; the home chips + mode-card badges read the
// per-style rating, so the played style's field must be updated too.
function styleFieldFromMode(mode) {
	if (!mode) return null;
	if (mode.indexOf("sprint") === 0) return "ratingSprint";
	if (mode.indexOf("standard") === 0) return "ratingStandard";
	if (mode.indexOf("tournament") === 0) return "ratingTournament";
	if (mode.indexOf("territory") === 0) return "ratingTerritory";
	return null;
}

function updateRatingFromStandings(standings, opts) {
	opts = opts || {};
	if (!account) return;
	var mine = standings.find(function(s) { return s.id === id; });
	if (!mine || typeof mine.rating !== "number") return;
	// The topbar chip shows your overall (best-across-modes) rank; capture it before the update.
	var oldOverall = overallRating(account);
	var oldTier = tierFor(oldOverall, account.provisional);
	if (mine.provisional != null) account.provisional = mine.provisional;
	// Update the played style's rating so the home chips/badges + the overall reflect the result
	// without a reload (the per-style fields are the source of truth — there's no legacy rating).
	var styleField = styleFieldFromMode(opts.mode || (typeof currentRankedMode !== "undefined" ? currentRankedMode : null));
	if (styleField) account[styleField] = mine.rating;
	if (typeof renderHomeRankChips === "function") renderHomeRankChips();
	var newOverall = overallRating(account);
	var newTier = tierFor(newOverall, account.provisional);
	renderRatingBadge();
	// Pulse the topbar rank badge on a change (the chip text was removed — the badge is the indicator).
	if (ratingBadgeSlot) {
		ratingBadgeSlot.classList.remove("rating-chip-bump");
		void ratingBadgeSlot.offsetWidth;
		ratingBadgeSlot.classList.add("rating-chip-bump");
	}
	// Float + banner track the headline (overall) rating; a gain in a non-best mode is shown in the
	// result modal's own delta, not on the topbar.
	var delta = newOverall - oldOverall;
	if (delta !== 0 && !opts.suppressDelta) showRatingDelta(delta);
	if (newTier.name !== oldTier.name && !opts.suppressBanner) showRankChangeBanner(newOverall > oldOverall, newTier);
}

// Floating "+15"/"-15" that drifts up from below the topbar rank badge, so
// the animation always travels into the viewport even when the badge is near
// the top of the screen.
function showRatingDelta(delta) {
	var anchor = (ratingBadgeSlot && ratingBadgeSlot.firstChild) ? ratingBadgeSlot : ratingChip;
	var rect = anchor.getBoundingClientRect();
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

// Entry point at series end. Tournament keeps its champion celebration; ranked shows the
// rating / tier-progression modal; casual gets a minimal rematch/leave card.
function showResultModal(data) {
	if (data.mode === "tournament") { showTournamentChampionPanel(data); return; }
	if (data.ranked) { showRankedResult(data); return; }
	showCasualResult(data);
}

// Ranked result: your rating change and progress toward the next tier — not a standings list.
// Rank badge, rating count-up + delta, a fill bar toward the next sub-tier, and Play another / Leave.
function showRankedResult(data) {
	var won = data.winnerId === id;
	var mine = (data.standings || []).find(function(s) { return s.id === id; }) || {};
	// The card shows THIS mode's rating. Capture the old per-style value before updateRatingFromStandings
	// overwrites it below, so the number can count up from old → new.
	var styleField = styleFieldFromMode(data.mode || (typeof currentRankedMode !== "undefined" ? currentRankedMode : null));
	var oldRating = (account && styleField && typeof account[styleField] === "number") ? account[styleField]
		: (account ? overallRating(account) : null);
	var newRating = (typeof mine.rating === "number") ? mine.rating : (oldRating != null ? oldRating : 0);

	var panel = document.createElement("div");
	panel.className = "result-panel ranked-result " + (won ? "ranked-result-win" : "ranked-result-lose");

	var heading = document.createElement("div");
	heading.className = "ranked-result-heading";
	heading.textContent = won ? "Victory" : "Defeat";
	panel.appendChild(heading);

	var badge = buildRankBadge(newRating);
	badge.classList.add("ranked-result-badge");
	panel.appendChild(badge);

	var tier = tierFor(newRating, mine.provisional);
	var ratingLine = document.createElement("div");
	ratingLine.className = "ranked-result-rating";
	var tierName = document.createElement("span");
	tierName.className = "ranked-result-tier";
	tierName.style.color = tier.color;
	tierName.textContent = tier.name;
	ratingLine.appendChild(tierName);
	var num = document.createElement("span");
	num.className = "ranked-result-num";
	num.textContent = String(oldRating != null ? oldRating : newRating);
	ratingLine.appendChild(num);
	if (typeof mine.ratingDelta === "number") {
		var d = document.createElement("span");
		d.className = "ranked-result-delta " + (mine.ratingDelta > 0 ? "gain" : mine.ratingDelta < 0 ? "loss" : "flat");
		d.textContent = (mine.ratingDelta > 0 ? "▲ +" : mine.ratingDelta < 0 ? "▼ " : "± ") + Math.abs(mine.ratingDelta);
		ratingLine.appendChild(d);
	}
	panel.appendChild(ratingLine);

	// Progress toward the next sub-tier.
	var oldProg = tierProgress(oldRating != null ? oldRating : newRating);
	var newProg = tierProgress(newRating);
	var track = document.createElement("div");
	track.className = "ranked-result-progress";
	var fill = document.createElement("span");
	fill.className = "ranked-result-progress-fill";
	fill.style.width = Math.round(oldProg.fill * 100) + "%";
	track.appendChild(fill);
	panel.appendChild(track);
	var progLabel = document.createElement("div");
	progLabel.className = "ranked-result-progress-label";
	progLabel.textContent = newProg.atMax ? "Top tier reached" : (newProg.pointsToNext + " to " + newProg.nextName);
	panel.appendChild(progLabel);

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
	var leave = document.createElement("button");
	leave.className = "btn btn-secondary";
	leave.textContent = "Leave";
	leave.addEventListener("click", function() { leaveRoom(); });
	actions.appendChild(again);
	actions.appendChild(leave);
	panel.appendChild(actions);

	presentPanel(panel, won ? "win" : "lose");

	// Apply the rating to the badge, then animate the number + progress a beat later (reward tick),
	// and play the rank-up/down fanfare if a tier was crossed.
	if (data.standings) updateRatingFromStandings(data.standings, { suppressBanner: true, suppressDelta: true, mode: data.mode });
	setTimeout(function() {
		countUpNumber(num, oldRating != null ? oldRating : newRating, newRating, 950);
		fill.style.width = Math.round(newProg.fill * 100) + "%";
	}, 400);
	playResultMoment(won, data.ranked, oldRating, newRating);
	try { again.focus(); } catch (e) {}
}

// Casual (custom room) — no rating. Minimal outcome card with Rematch (back to the room) / Leave.
function showCasualResult(data) {
	var won = data.winnerId === id;
	var panel = document.createElement("div");
	panel.className = "result-panel";
	var header = document.createElement("div");
	header.className = "result-header result-header-series";
	header.textContent = !data.winnerId ? "Draw" : (won ? "You win!" : (data.winnerName || "Opponent") + " wins");
	panel.appendChild(header);
	var actions = document.createElement("div");
	actions.className = "result-actions";
	var again = document.createElement("button");
	again.className = "btn btn-primary";
	again.textContent = "Rematch";
	again.addEventListener("click", function() { hideOverlay(); }); // room returns to planning; ready up again
	var leave = document.createElement("button");
	leave.className = "btn btn-secondary";
	leave.textContent = "Leave";
	leave.addEventListener("click", function() { leaveRoom(); });
	actions.appendChild(again);
	actions.appendChild(leave);
	panel.appendChild(actions);
	presentPanel(panel, won ? "win" : "lose");
}

// Tournament championship panel — focused entirely on the winner.  No
// ladder, no per-row deltas; the round overlay already showed who got
// cut each round.  The win moment deserves a quiet, single-subject
// celebration: big trophy, the champion's name, their rating bump
// (if ranked), and a couple of CTAs.
function showTournamentChampionPanel(data) {
	var won = data.winnerId === id;
	var resultOldRating = account ? account.ratingTournament : null; // tournament rating, before the update
	var entries = (data.standings || []);
	var winnerEntry = entries.find(function(s) { return s.id === data.winnerId; })
		|| { id: data.winnerId, name: data.winnerName };
	var meEntry = entries.find(function(s) { return s.id === id; });

	var panel = document.createElement("div");
	panel.className = "result-panel champion-panel" + (won ? " champion-panel-mine" : "");

	var trophy = document.createElement("div");
	trophy.className = "champion-trophy";
	trophy.textContent = "🏆";
	panel.appendChild(trophy);

	var tagline = document.createElement("div");
	tagline.className = "champion-tagline";
	tagline.textContent = won ? "Tournament Champion" : "Tournament Champion";
	panel.appendChild(tagline);

	var nameLine = document.createElement("div");
	nameLine.className = "champion-name";
	nameLine.textContent = won ? "You" : (winnerEntry.name || "Unknown");
	panel.appendChild(nameLine);

	if (typeof winnerEntry.rating === "number") {
		var tier = tierFor(winnerEntry.rating, winnerEntry.provisional);
		var rating = document.createElement("div");
		rating.className = "champion-rating";
		rating.innerHTML = '<span class="champion-tier" style="color:' + tier.color + '">'
			+ tier.name + "</span> · " + winnerEntry.rating;
		if (typeof winnerEntry.ratingDelta === "number" && winnerEntry.ratingDelta !== 0) {
			var d = document.createElement("span");
			d.className = "champion-delta " + (winnerEntry.ratingDelta > 0 ? "up" : "down");
			d.textContent = (winnerEntry.ratingDelta > 0 ? " ▲+" : " ▼") + Math.abs(winnerEntry.ratingDelta);
			rating.appendChild(d);
		}
		panel.appendChild(rating);
	}

	// Sub-line for the player who didn't win — surfaces their own outcome
	// in one line without dragging the whole leaderboard back in.
	if (!won && meEntry) {
		var yourLine = document.createElement("div");
		yourLine.className = "champion-yours";
		var deltaStr = "";
		if (typeof meEntry.ratingDelta === "number" && meEntry.ratingDelta !== 0) {
			deltaStr = " · " + (meEntry.ratingDelta > 0 ? "▲+" : "▼") + Math.abs(meEntry.ratingDelta);
		}
		yourLine.textContent = "You finished #" + (meEntry.rank || "?") + deltaStr;
		panel.appendChild(yourLine);
	}

	// Apply ranked rating updates from standings (same as the series flow).
	if (data.standings) updateRatingFromStandings(data.standings, { suppressBanner: true, mode: data.mode || "tournament" });

	var actions = document.createElement("div");
	actions.className = "result-actions champion-actions";
	var again = document.createElement("button");
	again.className = "btn btn-primary";
	again.textContent = "Play another";
	again.addEventListener("click", function() {
		socket.emit("leave_room");
		findRanked("tournament");
	});
	actions.appendChild(again);
	var back = document.createElement("button");
	back.className = "btn btn-secondary";
	back.textContent = "Back to menu";
	back.addEventListener("click", function() {
		leaveRoom(); // leaving for good — exits fullscreen (Play another stays fullscreen)
	});
	actions.appendChild(back);
	panel.appendChild(actions);

	presentPanel(panel, won ? "win" : "lose");
	playResultMoment(won, data.ranked, resultOldRating, account ? account.ratingTournament : null);
	try { again.focus(); } catch (e) {}
}
