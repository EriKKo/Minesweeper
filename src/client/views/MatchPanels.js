// In-match result overlays: tournament round elimination card, per-round result,
// series end, and the ranking-delta UI (banner + floating delta on the ratingChip).
// Driven by socket events dispatched in the main inline script (round_ended,
// series_ended, etc). The pre-game roster modal was removed — the search waiting
// room already shows who's joining, so a match drops straight into the game layout.
//
// Depends on Ranking.* helpers (tierFor, medal, buildRankBadge,
// buildRankSwapColumn, ordinal, formatClearTime) and a handful of live-game
// globals (account, id, socket, currentRoom, ratingChip, formatGameProgress,
// presentPanel, ...) defined in the main inline script.

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
function playResultMoment(won, ranked, oldRating) {
	if (ranked && account && typeof oldRating === "number" && typeof account.rating === "number") {
		var crossed = tierFor(oldRating, account.provisional).name !== tierFor(account.rating, account.provisional).name;
		if (crossed && typeof sound !== "undefined") (account.rating > oldRating ? sound.rankUp : sound.rankDown)();
	}
}

// TetrisFriends-style on-board outcome banners: a big "YOU WIN" over the winner's board and
// "YOU LOSE" over the loser's, shown the instant the duel ends — before the results modal.
function showDuelOutcome(iWon) {
	clearDuelOutcomes();
	addDuelOutcome(document.getElementById("player_div"), iWon);
	addDuelOutcome(document.querySelector("#all_opponents_div .opponent_div"), !iWon);
}
function addDuelOutcome(card, won) {
	if (!card) return;
	var b = document.createElement("div");
	b.className = "duel-outcome " + (won ? "duel-outcome-win" : "duel-outcome-lose");
	b.textContent = won ? "YOU WIN" : "YOU LOSE";
	card.appendChild(b);
}
function clearDuelOutcomes() {
	var els = document.querySelectorAll(".duel-outcome");
	for (var i = 0; i < els.length; i++) els[i].remove();
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
	// Tournament gets its own panel — just the champion, no full ladder.
	// The round-by-round eliminations already gave you the whole story.
	if (data.mode === "tournament") {
		showTournamentChampionPanel(data);
		return;
	}
	// Prefer the new `standings` (with Elo deltas + tiers); fall back to plain
	// `scores` for casual rooms that don't produce standings.
	var entries = (data.standings && data.standings.length)
		? data.standings.slice()
		: (data.scores || []).slice().sort(function(a, b) { return b.score - a.score; });
	var won = data.winnerId === id;
	var resultOldRating = account ? account.rating : null; // capture before updateRatingFromStandings mutates it
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
			leaveRoom(); // leaving for good — exits fullscreen (Play another stays fullscreen)
		});
		actions.appendChild(back);

		panel.appendChild(actions);
		presentPanel(panel, won ? "win" : "lose"); // no auto-hide — player decides
		// Focus "Play another" so Enter re-queues without reaching for the mouse.
		try { again.focus(); } catch (e) {}
	} else {
		presentPanel(panel, won ? "win" : "lose", 5500);
	}
	playResultMoment(won, data.ranked, resultOldRating);
}

// Tournament championship panel — focused entirely on the winner.  No
// ladder, no per-row deltas; the round overlay already showed who got
// cut each round.  The win moment deserves a quiet, single-subject
// celebration: big trophy, the champion's name, their rating bump
// (if ranked), and a couple of CTAs.
function showTournamentChampionPanel(data) {
	var won = data.winnerId === id;
	var resultOldRating = account ? account.rating : null; // capture before the badge updates
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
			+ tier.name + "</span> · " + (winnerEntry.provisional ? "~" : "") + winnerEntry.rating;
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
	if (data.standings) updateRatingFromStandings(data.standings, { suppressBanner: true });

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
	playResultMoment(won, data.ranked, resultOldRating);
	try { again.focus(); } catch (e) {}
}
