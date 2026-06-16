
var MINE = BoardLogic.MINE;
var FLAGGED = BoardLogic.FLAGGED;
var UNKNOWN = BoardLogic.UNKNOWN;
var KNOWN = BoardLogic.KNOWN;

var rows = 15;
var cols = 20;

var PLAYER_CELL = 34;          // desktop player cell CSS px (fallback when the board area can't be measured)
var MOBILE_PLAYER_CELL = 42;   // mobile cell CSS px — finger-friendly, board may exceed viewport
var OPP_CELL = 13;             // smaller cells for opponent boards
// Desktop board scales to fill the available board area between these bounds, so a
// big board uses the screen instead of sitting at a fixed small size (see sizePlayerCanvas).
var DESKTOP_CELL_MIN = 22;
var DESKTOP_CELL_MAX = 54;
// DPR lives in BoardRender.js so canvas factories there can use it too.
// Mobile layout helpers + canvas sizing moved to MobileLayout.js.

// Size a board canvas from the cell grid: render at devicePixelRatio for crispness,
// display at the logical size, and let it shrink responsively on narrow screens.

var playerCanvas = document.getElementById("game0");
var boardScroll = document.getElementById("board_scroll");

// Player canvas is sized differently on mobile: a fixed bigger cell size, no max-width
// clamp — the surrounding .board-scroll handles pan when the board exceeds the screen.

// --- Battle layout state -------------------------------------------------------------------------
// The duo/multi battle layout is driven by EITHER a live room OR an in-progress ranked search: hitting
// "Find match" for a racing mode drops you straight into this layout and slots opponents in as the
// search fills, so search and play share one screen. `rankedSearch` holds the pending field.
var rankedSearch = null; // { mode, size, race:true, members:[] } while searching a racing ranked mode
function rankedModeSize(mode) { return /_six$/.test(mode) ? 6 : /_quad$/.test(mode) ? 4 : 2; }
function isRaceRankedMode(mode) { return /^(sprint|standard)_(duo|six)$/.test(mode || ""); }
// The number of racing boards in the current battle — from the live room if there is one, else the
// size of the racing search we're in. 0 when neither applies (so the battle layout stays off).
function battleSize() {
	if (currentRoom && currentRoom.players && (currentRoom.gameMode || "race") === "race") return currentRoom.players.length;
	if (rankedSearch && rankedSearch.race) return rankedSearch.size;
	return 0;
}
// A 1v1 racing match uses the side-by-side "duel" layout (both boards equal size); a 3-6 player
// match uses the TetrisFriends-style grid. Driven by a `duo`/`multi` class on the game view.
function isDuoRacing() { return battleSize() === 2; }
function isMultiRacing() { var n = battleSize(); return n >= 3 && n <= 6; }
function isBattleRacing() { return isDuoRacing() || isMultiRacing(); }
function applyDuoClass() {
	// Battle layout while playing (the countdown counts as playing). Ranked matches also use it during
	// the brief planning/reveal window so you see the field immediately on joining; custom rooms
	// keep the normal layout in planning so their config controls stay visible.
	var playing = !!currentRoom && (currentRoom.phase === "playing" || currentRoom.ranked);
	var searching = !!(rankedSearch && rankedSearch.race); // in-battle search shows the field too
	var on = playing || searching;
	if (typeof gameView !== "undefined" && gameView) {
		gameView.classList.toggle("duo", isDuoRacing() && on);
		gameView.classList.toggle("multi", isMultiRacing() && on);
		// The battle layout changes the column widths, so the own board has to be re-fit to the new
		// game-left track — otherwise it stays at the small fallback cell size it was built with before
		// the layout settled. Re-measure on the next frame once the new layout has been applied
		// (own board + opponent thumbnails, which fit to their grid cards in the 6-player layout).
		if (on && typeof sizePlayerCanvas === "function") requestAnimationFrame(function() {
			sizePlayerCanvas();
			if (typeof sizeOpponentCanvases === "function") sizeOpponentCanvases();
		});
	}
}
// In the battle layouts each board's name header doubles as its progress readout ("Alice · 47%").
function playerLabel(name, progress) {
	if (!isBattleRacing()) return name || "";
	return (name || "") + "  ·  " + Math.round((progress || 0) * 100) + "%";
}

// Set an in-game name tag from a broadcast game-snapshot, with an avatar chip (flag + country). The
// chip canvas is cached on the element and only rebuilt when the player/avatar/country changes — this
// runs every draw_board frame, so we must not recreate a canvas per frame. Pass a falsy `g` to clear.
function setHudName(el, g) {
	if (!el) return;
	if (!g) { el.innerHTML = ""; el._chipKey = null; el._textNode = null; return; }
	var key = (g.id || "") + "|" + (g.avatar || "") + "|" + (g.country || "");
	if (el._chipKey !== key || !el._textNode) {
		el._chipKey = key;
		el.innerHTML = "";
		if (typeof buildAvatarChip === "function") {
			var ch = buildAvatarChip(g.avatar || DEFAULT_AVATAR, g.country || null, 22);
			ch.classList.add("hud-avatar");
			el.appendChild(ch);
		}
		var t = document.createElement("span"); t.className = "hud-name-text";
		el.appendChild(t); el._textNode = t;
	}
	el._textNode.textContent = playerLabel(g.playerName, g.progress);
}

// --- 1v1 duel battle HUD: identity panels (rank badge + name + tier), per-board progress bars,
// and the center tug-of-war bar + leader glow. ---
function fillDuelId(el, p, isYou) {
	if (!el) return;
	el.innerHTML = "";
	if (!p) return;
	// Dota-style: a tall avatar portrait, then name on top + tier/rating beneath (no separate rank badge).
	if (typeof buildAvatarChip === "function") {
		var chip = buildAvatarChip(p.avatar || DEFAULT_AVATAR, p.country || null, 44);
		chip.classList.add("duel-id-avatar");
		el.appendChild(chip);
	}
	var info = document.createElement("div");
	info.className = "duel-id-info";
	var nm = document.createElement("div");
	nm.className = "duel-id-name";
	nm.textContent = isYou ? "You" : (p.name || "Anonymous");
	info.appendChild(nm);
	if (typeof p.rating === "number" && typeof tierFor === "function") {
		var t = tierFor(p.rating, p.provisional);
		var rt = document.createElement("div");
		rt.className = "duel-id-rating";
		rt.style.color = t.color;
		rt.textContent = t.name + "  ·  " + p.rating;
		info.appendChild(rt);
	}
	el.appendChild(info);
}
// Build the identity panel(s) from the room roster (run when the battle layout turns on / roster
// changes). The duel fills both you + opponent; the 6-player battle fills just your own panel
// above the big board (each opponent's name rides on its board card instead).
// The battle roster is the live room's players if a match has formed, else the pending search field.
// Both carry { id, name, rating, provisional, isYou? } so the identity panels + boards read either.
function battleRoster() {
	if (currentRoom && currentRoom.players) return currentRoom.players;
	if (rankedSearch && rankedSearch.members) return rankedSearch.members;
	return [];
}
function buildDuelIdentity() {
	if (!isBattleRacing()) return;
	var roster = battleRoster();
	var me = null, opp = null;
	for (var i = 0; i < roster.length; i++) {
		var p = roster[i];
		if (p.id === id || p.isYou) { if (!me) me = p; } else if (!opp) opp = p;
	}
	fillDuelId(document.getElementById("duel_id_you"), me, true);
	if (isDuoRacing()) fillDuelId(document.getElementById("duel_id_opp"), opp, false);
}
function setDuelBar(barId, progress) {
	var bar = document.getElementById(barId);
	if (!bar) return;
	var pct = Math.round((progress || 0) * 100);
	var fill = bar.querySelector(".duel-bar-fill");
	var label = bar.querySelector(".duel-bar-pct");
	if (fill) fill.style.width = pct + "%";
	if (label) label.textContent = pct + "%";
}
// Live battle HUD from the current frame: each board's progress bar, the center tug-of-war fill
// (your share of the combined progress), and the leader glow on the board cards.
function updateDuelHud(meGame, oppGame) {
	if (!isDuoRacing()) return;
	var myP = meGame ? (meGame.progress || 0) : 0;
	var opP = oppGame ? (oppGame.progress || 0) : 0;
	setDuelBar("duel_bar_you", myP);
	setDuelBar("duel_bar_opp", opP);
	var total = myP + opP;
	var tug = document.getElementById("duel_tug_fill");
	if (tug) tug.style.height = Math.round((total > 0 ? myP / total : 0.5) * 100) + "%";
	var youCard = document.getElementById("player_div");
	var oppCard = document.querySelector("#all_opponents_div .opponent_div");
	if (youCard) youCard.classList.toggle("leading", myP > opP + 0.0001);
	if (oppCard) oppCard.classList.toggle("leading", opP > myP + 0.0001);
}
// 6-player battle: glow whichever board is currently in front (you or the top opponent), and
// mark finished opponents. Opponent slots are filled in sorted order, so slot[i] ↔ opponents[i].
function updateMultiHud(meGame, opponents) {
	if (!isMultiRacing()) return;
	function prog(g) { return g ? (g.finished ? 1 : (g.progress || 0)) : 0; }
	var myP = prog(meGame);
	var bestOpp = 0;
	for (var k = 0; k < opponents.length; k++) bestOpp = Math.max(bestOpp, prog(opponents[k]));
	var youLead = myP > 0 && myP >= bestOpp;
	var youCard = document.getElementById("player_div");
	if (youCard) youCard.classList.toggle("leading", youLead);
	var slots = document.querySelectorAll("#all_opponents_div .opponent_div");
	for (var i = 0; i < slots.length; i++) {
		var opp = opponents[i];
		var p = prog(opp);
		// Boards are fixed by rating, so the leader can sit in any slot — glow whoever's actually ahead.
		slots[i].classList.toggle("leading", !youLead && p > 0 && p >= bestOpp);
		slots[i].classList.toggle("finished", !!(opp && opp.finished));
	}
}
// Battle layouts (1v1 + 6-player): stamp each finished board with its finish place (1st, 2nd, …)
// the moment that player clears. Place is the live finish order (by finishedAt); boards still
// racing show nothing. Cleared between rounds (clearPlaceBadges).
function updateMultiPlacements(games) {
	// Skip once the round result is in — applyMultiFinalPlaces has stamped every board from the
	// final standings, and a trailing live frame would otherwise wipe the non-finishers' places.
	if (!isBattleRacing() || roundResultShown) return;
	var finishers = (games || []).filter(function(g) { return g && g.finished; })
		.sort(function(a, b) { return (a.finishedAt || 0) - (b.finishedAt || 0); });
	var placeOf = {};
	finishers.forEach(function(g, idx) { if (g.id) placeOf[g.id] = idx + 1; });
	setPlaceBadge(document.getElementById("player_div"), games[0] && games[0].id ? placeOf[games[0].id] : null);
	var slots = document.querySelectorAll("#all_opponents_div .opponent_div");
	for (var i = 0; i < slots.length; i++) {
		var pid = slots[i].dataset.pid;
		setPlaceBadge(slots[i], pid ? placeOf[pid] : null);
	}
}
// At round end, stamp EVERY board with its final place from the standings (rank-ordered) — so
// players who never finished (hit mines / ran out of time) still get their number, not just the
// finishers the live updater placed.
function applyMultiFinalPlaces(standings) {
	if (!isBattleRacing() || !standings) return;
	var placeOf = {};
	standings.forEach(function(s, idx) { if (s && s.id) placeOf[s.id] = idx + 1; });
	setPlaceBadge(document.getElementById("player_div"), placeOf[id] || null);
	var slots = document.querySelectorAll("#all_opponents_div .opponent_div");
	for (var i = 0; i < slots.length; i++) {
		var pid = slots[i].dataset.pid;
		setPlaceBadge(slots[i], pid ? (placeOf[pid] || null) : null);
	}
}
function setPlaceBadge(card, place) {
	if (!card) return;
	var existing = card.querySelector(".board-place");
	if (!place) { if (existing) existing.remove(); return; }
	if (existing && Number(existing.dataset.place) === place) return;
	if (existing) existing.remove();
	var b = document.createElement("div");
	b.className = "board-place board-place-" + (place <= 3 ? place : "n");
	b.dataset.place = place;
	b.textContent = (typeof ordinal === "function") ? ordinal(place) : place + "";
	card.appendChild(b);
}
function clearPlaceBadges() {
	var els = document.querySelectorAll(".board-place");
	for (var i = 0; i < els.length; i++) els[i].remove();
}
// Fill the rank insignia in an opponent card's name row (6-player battle layout — the duel shows the
// full badge in its identity panel instead). The `.opp-rank-badge` holder lives in the card markup,
// inline before the name, so it aligns cleanly. Pass a null rating to clear it.
function setOppRankBadge(card, rating) {
	if (!card) return;
	var holder = card.querySelector(".opp-rank-badge");
	if (!holder) return;
	if (typeof rating !== "number" || typeof buildRankBadge !== "function") {
		holder.innerHTML = ""; holder.removeAttribute("data-rating"); return;
	}
	if (Number(holder.dataset.rating) === rating && holder.firstChild) return; // already this rating
	holder.innerHTML = "";
	holder.dataset.rating = rating;
	holder.appendChild(buildRankBadge(rating));
}
// Size the opponent boards. In the duel, the single opponent (game1) is sized to the SAME cell
// size as the player board so the two boards match; the other slots (and all of 6-player) stay
// small thumbnails.
function sizeOpponentCanvases() {
	var duo = isDuoRacing();
	var multi = isMultiRacing();
	var duoCell = duo ? (playerCanvas.width / DPR / cols) : OPP_CELL;
	// In 6-player, fit each thumbnail to the width of its grid card so the boards use the column
	// instead of sitting at the tiny fixed OPP_CELL. Measure a card; fall back to OPP_CELL before the
	// layout is ready, and cap the cell so a wide screen doesn't blow the thumbnails up to full size.
	var multiCell = OPP_CELL;
	if (multi) {
		var od = document.querySelector(".game-view.multi .opponent_div");
		var avail = od ? od.clientWidth - 24 : 0; // minus the card's horizontal padding
		if (avail > 0) multiCell = Math.max(OPP_CELL, Math.min(26, Math.floor(avail / cols)));
	}
	for (var gi = 1; gi <= 5; gi++) {
		var cv = document.getElementById("game" + gi);
		if (cv) sizeBoardCanvas(cv, (gi === 1 && duo) ? duoCell : (multi ? multiCell : OPP_CELL));
	}
}

sizePlayerCanvas();
sizeOpponentCanvases();

var playerCanvasHeight = playerCanvas.height;
var playerCanvasWidth = playerCanvas.width;
var playerCanvasSquareWidth = playerCanvasWidth / cols;
var playerCanvasSquareHeight = playerCanvasHeight / rows;

// Touch input: set body.touch so the flag-mode toggle becomes visible, and
// install tap/long-press handlers below. boardClicked is mouse-only — synthesized
// mouse events that follow a touch are suppressed via lastTouchAt.
var touchInput = ("ontouchstart" in window) || (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
if (touchInput) document.body.classList.add("touch");

var lastTouchAt = 0;
var flagMode = false;
var flagModeButton = document.getElementById("flag_mode_button");
var flagModeLabel = flagModeButton.querySelector(".flag-mode-label");

function updateFlagModeButton() {
	flagModeButton.setAttribute("aria-pressed", flagMode ? "true" : "false");
	flagModeLabel.textContent = flagMode ? "Flag mode" : "Tap to flag";
}
updateFlagModeButton();

flagModeButton.addEventListener("click", function() {
	flagMode = !flagMode;
	updateFlagModeButton();
	if (navigator.vibrate) navigator.vibrate(8);
});

playerCanvas.onclick = function(event) {
	if (Date.now() - lastTouchAt < 500) return;
	boardClicked(event);
};
playerCanvas.oncontextmenu = function(event) {
	event.preventDefault();
	if (Date.now() - lastTouchAt < 600) return false;
	boardClicked(event);
	return false;
};

var touchStartX = 0, touchStartY = 0, touchMoved = false, longPressFired = false, longPressTimer = null;
var pressedCell = null; // cell currently under the finger — drawn highlighted for instant feedback
var LONG_PRESS_MS = 420;
var TOUCH_MOVE_TOLERANCE = 12;

// Input dispatch + cellFromCanvas hit-test moved to Input.js.

// Mirror the server's dfs reveal: walks from (r,c) marking unknown cells KNOWN,
// cascading through 0-cells, recording each newly-revealed cell and whether the
// path hit a mine. Mutates myState in place.
// Single point of truth for "the user did a board action": optimistically apply
// it locally and emit to the server. Called from mouse, touch, and keyboard.

playerCanvas.addEventListener("touchstart", function(e) {
	lastTouchAt = Date.now();
	if (e.touches.length !== 1) {
		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
		pressedCell = null;
		return;
	}
	var t = e.touches[0];
	touchStartX = t.clientX;
	touchStartY = t.clientY;
	touchMoved = false;
	longPressFired = false;
	// Immediate visual feedback so taps don't feel "lost" while the server processes.
	pressedCell = cellFromClient(t.clientX, t.clientY);
	if (pressedCell) redrawOwnBoardWithFocus();
	if (longPressTimer) clearTimeout(longPressTimer);
	longPressTimer = setTimeout(function() {
		longPressTimer = null;
		if (touchMoved) return;
		longPressFired = true;
		pressedCell = null;
		emitBoardActionAt(touchStartX, touchStartY, true);
		if (navigator.vibrate) navigator.vibrate(15);
	}, LONG_PRESS_MS);
}, { passive: true });

playerCanvas.addEventListener("touchmove", function(e) {
	lastTouchAt = Date.now();
	if (e.touches.length !== 1) return;
	var t = e.touches[0];
	if (Math.abs(t.clientX - touchStartX) > TOUCH_MOVE_TOLERANCE || Math.abs(t.clientY - touchStartY) > TOUCH_MOVE_TOLERANCE) {
		touchMoved = true;
		if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
		clearPressed();
	}
}, { passive: true });

playerCanvas.addEventListener("touchend", function(e) {
	lastTouchAt = Date.now();
	if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
	pressedCell = null;
	if (longPressFired || touchMoved) {
		e.preventDefault();
		redrawOwnBoardWithFocus();
		return;
	}
	e.preventDefault();
	emitBoardActionAt(touchStartX, touchStartY, flagMode);
}, { passive: false });

playerCanvas.addEventListener("touchcancel", function() {
	if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
	touchMoved = true;
	clearPressed();
});

// Any actual pan kills the pending tap/long-press, even if the finger moved less
// than TOUCH_MOVE_TOLERANCE before the browser started scrolling.
boardScroll.addEventListener("scroll", function() {
	if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
	touchMoved = true;
	clearPressed();
	updateMobileFindNextHint();
});

// Pan / find-next-cell helpers --------------------------------------------------

// "Interesting" cell = unrevealed and adjacent to a revealed numbered cell — the
// puzzle's solvable frontier. Returns nearest such cell, falling back to any
// unknown cell if no frontier exists yet (very early game).


// The directional hint arrow: appears only when the current viewport contains no
// frontier cells (nothing solvable on screen), pointing toward the nearest one.
var findNextArrow = document.getElementById("find_next_arrow");
var arrowGlyph = findNextArrow.querySelector(".find-next-arrow-glyph");
var arrowTargetCell = null;


findNextArrow.addEventListener("click", function(e) {
	e.preventDefault();
	if (!arrowTargetCell) return;
	scrollToCell(arrowTargetCell.r, arrowTargetCell.c, true);
	if (navigator.vibrate) navigator.vibrate(8);
});

// Respond to rotation / viewport changes so the player board re-sizes correctly.

var id;
var currentRoom = null;
var inRoom = false;
// myName + account + the auth IIFE live in Auth.js.

var socket = io({ transports: ["websocket"] });

socket.on("solo_rejected", function(data) {
	showLobbyMessage((data && data.reason) || "Couldn't start solo board.");
	exitSolo();
});

// Rated puzzle board — same shape as solo_board, just driven by the server's
// puzzle picker. Mounts into the game view with puzzle-mode chrome (rating
// header instead of timer + mine count).
socket.on("puzzle_board", function(data) {
	withPendingRunFlash(function() { applyPuzzleBoard(data); });
});

function applyPuzzleBoard(data) {
	rows = data.rows;
	cols = data.cols;
	puzzleSession = {
		puzzleId: data.puzzleId,
		totalSafe: data.totalSafe,
		totalMines: data.mines,
		playerRating: data.playerRating,
		startedAt: Date.now(),
		finished: false,
		mode: data.mode || "rated",
		run: data.run || null
	};
	if (puzzleSession.mode === "storm") startStormTicker(); else stopStormTicker();
	puzzleHintClues = [];
	puzzleHintCovered = [];
	// Reset BEFORE seeding state — resetBoardAnimations nulls prevPlayerState
	// and cellAnims, so doing it after would discard the cascade we just set up.
	resetBoardAnimations();
	installBoardDecoder(data.boardData, data.boardMask, rows, cols);
	myState = new Array(rows);
	for (var r = 0; r < rows; r++) {
		myState[r] = new Array(cols);
		for (var c = 0; c < cols; c++) myState[r][c] = UNKNOWN;
	}
	// Mark the server-provided revealed cells, then cascade-reveal from
	// the neighbours of any 0-clue starting cell. The server SHOULD send
	// a cascade-complete set, but a few legacy inside-out puzzles in
	// the pool slipped through with bare cascade origins. (We can't
	// recurse cascadeReveal on the 0-cell itself — it bails when the
	// cell is already known — so we kick the recursion from each
	// covered neighbour.)
	(data.knownCells || []).forEach(function(rc) { myState[rc[0]][rc[1]] = KNOWN; });
	(data.knownCells || []).forEach(function(rc) {
		if (boardCell(rc[0], rc[1]) !== 0) return;
		for (var dr = -1; dr <= 1; dr++) {
			for (var dc = -1; dc <= 1; dc++) {
				if (dr === 0 && dc === 0) continue;
				BoardLogic.cascadeReveal(rc[0] + dr, rc[1] + dc, rows, cols,
					function(rr, cc) { return myState[rr][cc] === UNKNOWN; },
					function(rr, cc) { myState[rr][cc] = KNOWN; return false; },
					function(rr, cc) { return boardCell(rr, cc); }
				);
			}
		}
	});
	prevPlayerState = cloneState(myState);
	frozenUntil = 0;
	roundResultShown = false;
	focusedR = Math.floor(rows / 2);
	focusedC = Math.floor(cols / 2);
	focusVisible = false;
	lastFinished = {};
	cellAnims = {};
	hideOverlay();
	sizePlayerCanvas();
	playerCanvasWidth = playerCanvas.width;
	playerCanvasHeight = playerCanvas.height;
	playerCanvasSquareWidth = playerCanvasWidth / cols;
	playerCanvasSquareHeight = playerCanvasHeight / rows;
	sizeOpponentCanvases();
	hideAllViews();
	gameView.style.display = "";
	document.body.classList.add("in-game");
	gameView.classList.remove("duo");
	gameView.classList.add("puzzle");
	togglePuzzleChrome(true, puzzleSession.mode);
	if (typeof setRatedFailActions === "function") setRatedFailActions(false);
	updatePuzzleHud();
	renderPlayerBoard();
	if (mobileLayout) scrollToCell(Math.floor(rows / 2), Math.floor(cols / 2), false);
}

socket.on("puzzle_result", function(data) {
	if (!puzzleSession) return;
	// Run modes don't emit puzzle_result — the server transitions directly
	// to the next puzzle_board (on solve) or to puzzle_run_end (on miss).
	if (puzzleSession.mode === "streak" || puzzleSession.mode === "storm") return;
	puzzleSession.finished = true;
	puzzleSession.result = data;
	// Retry attempts (noRating) leave rating + counters + streak untouched —
	// the original attempt already moved them. Skip account mutation so a
	// practice solve doesn't double-count or revive a broken streak.
	if (!data.noRating) {
		puzzleSession.playerRating = data.playerAfter;
		if (data.solved) puzzleStreak++;
		else puzzleStreak = 0;
		if (account) {
			account.puzzleRating = data.playerAfter;
			account.puzzlesAttempted = (account.puzzlesAttempted || 0) + 1;
			if (data.solved) account.puzzlesSolved = (account.puzzlesSolved || 0) + 1;
			if (typeof renderHomeRankChips === "function") renderHomeRankChips();
		}
	}
	updatePuzzleHud();
	showPuzzleOutcome(data);
	refreshAchievementProgress();
});

socket.on("puzzle_daily_status", function(data) {
	// Two cases: arriving on the /puzzles/daily route, OR home-card prefetch.
	if (account) {
		account.dailyStreak = data.streak || 0;
		account.dailyAttempt = data.attempt || null;
		account.dailyBoard = data.board || null;
		account.dailyDate = data.date || null;
		if (typeof renderHomeRankChips === "function") renderHomeRankChips();
	}
	// If we're actively on the daily route, decide whether to play or show result.
	if (location.pathname === "/puzzles/daily") {
		if (data.attempt) {
			// Already attempted today — show the result panel without starting a new game.
			showDailyAlreadyDone(data);
		} else {
			socket.emit("puzzle_daily_start");
		}
	}
});

socket.on("puzzle_daily_result", function(data) {
	if (!puzzleSession) return;
	puzzleSession.finished = true;
	puzzleSession.run = puzzleSession.run || {};
	puzzleSession.run.streak = data.streak;
	puzzleSession.run.lastSolved = data.solved;
	stopStormTicker();
	if (account) {
		account.dailyStreak = data.streak;
		account.dailyAttempt = { solved: data.solved, at: Date.now() };
		if (typeof renderHomeRankChips === "function") renderHomeRankChips();
	}
	withPendingRunFlash(function() {
		updatePuzzleHud();
		showDailyOutcome(data);
	});
	refreshAchievementProgress();
});

socket.on("puzzle_run_end", function(data) {
	withPendingRunFlash(function() {
		if (!puzzleSession) return;
		puzzleSession.finished = true;
		stopStormTicker();
		if (account) {
			if (data.mode === "streak") account.streakBest = data.best;
			else if (data.mode === "storm") account.stormBest = data.best;
			if (typeof renderHomeRankChips === "function") renderHomeRankChips();
		}
		showPuzzleRunOutcome(data);
	});
	refreshAchievementProgress();
});

// Hint pointer: server tells us which cell(s) to look at — clue cells and
// the covered cells whose status they determine. We highlight both on the
// board (drawn from Animations.js); nothing is revealed.
socket.on("puzzle_hint_pointer", function(data) {
	if (!puzzleSession || data.alreadyUsed) return;
	puzzleSession.hintUsed = true;
	updatePuzzleHintButton();
	puzzleHintClues = data.clueCells || [];
	puzzleHintCovered = data.coveredCells || [];
	redrawOwnBoardWithFocus();
});

socket.on("puzzle_error", function(data) {
	var reason = (data && data.reason) || "unknown";
	showLobbyMessage(
		reason === "auth_required" ? "Sign in to play rated puzzles." :
		reason === "no_puzzles" ? "No puzzles available yet — head to the Lab to generate some." :
		"Couldn't load a puzzle: " + reason
	);
	exitPuzzle();
});

// Admin bot-demo frames — routed to the open bot-demo modal (BotsAdmin.js), which
// renders them on its own canvas without touching the live-game globals.
socket.on("bot_demo_board", function(data) { if (typeof onBotDemoBoard === "function") onBotDemoBoard(data); });
socket.on("bot_demo_move", function(data) { if (typeof onBotDemoMove === "function") onBotDemoMove(data); });
socket.on("bot_demo_rejected", function(data) { if (typeof onBotDemoRejected === "function") onBotDemoRejected(data); });

socket.on("solo_board", function(data) {
	rows = data.rows;
	cols = data.cols;
	soloSession = {
		size: data.size,
		density: (typeof data.density === "number") ? data.density : soloSelectedDensity,
		totalSafe: data.totalSafe,
		totalMines: data.mines,
		startTime: null,
		finishTime: null,
		finished: false,
		started: false // becomes true after the pre-game Start countdown; gates board input
	};
	// Reset BEFORE seeding state — resetBoardAnimations nulls prevPlayerState
	// and cellAnims, so doing it after would discard the cascade we just set up.
	resetBoardAnimations();
	installBoardDecoder(data.boardData, data.boardMask, rows, cols);
	myState = new Array(rows);
	for (var r = 0; r < rows; r++) {
		myState[r] = new Array(cols);
		for (var c = 0; c < cols; c++) myState[r][c] = UNKNOWN;
	}
	(data.knownCells || []).forEach(function(rc) { myState[rc[0]][rc[1]] = KNOWN; });
	prevPlayerState = cloneState(myState);
	frozenUntil = 0;
	roundResultShown = false;
	focusedR = Math.floor(rows / 2);
	focusedC = Math.floor(cols / 2);
	focusVisible = false;
	lastFinished = {};
	cellAnims = {};
	resetClearChallenge(); // new solo board → reset the no-flag / chord-only tracking
	hideOverlay();

	// Show the game view (with solo-only chrome) FIRST, then size the board — fitDesktopCellPx measures
	// the .game-left column, which only has its real width once the solo layout is on screen. Sizing
	// before the view is visible would lock the board at the small fallback cell size.
	hideAllViews();
	gameView.style.display = "";
	document.body.classList.add("in-game");
	gameView.classList.remove("duo");
	gameView.classList.add("solo");
	toggleSoloChrome(true);
	sizePlayerCanvas();
	playerCanvasWidth = playerCanvas.width;
	playerCanvasHeight = playerCanvas.height;
	playerCanvasSquareWidth = playerCanvasWidth / cols;
	playerCanvasSquareHeight = playerCanvasHeight / rows;
	sizeOpponentCanvases();
	updateSoloHud();
	if (typeof updateSoloBest === "function") updateSoloBest();
	renderPlayerBoard();
	if (mobileLayout) scrollToCell(Math.floor(rows / 2), Math.floor(cols / 2), false);
	// Gate the board behind a Start button + countdown (board input stays locked until then).
	if (typeof showSoloStart === "function") showSoloStart();
});

// Server's verdict on a just-submitted Free-play clear: cache the new best and refresh the displays
// (the solo card stat + the open outcome panel, which marks a new record).
socket.on("solo_record", function(data) {
	if (!account) return;
	if (!account.soloBests) account.soloBests = {};
	account.soloBests[data.size + "_" + data.density] = data.best;
	if (typeof updateSoloBest === "function") updateSoloBest();
	if (typeof onSoloRecord === "function") onSoloRecord(data);
	refreshAchievementProgress();
});

// After any result, pull fresh stats (cheap PK read server-side) so achievement progress + unlock
// toasts reflect the just-finished game. The match_history handler → renderMatchHistory →
// checkAchievementUnlocks does the diff.
function refreshAchievementProgress() {
	if (account && typeof socket !== "undefined") socket.emit("get_match_history");
}

// "Clear without a flag" / "clear without a direct reveal (chord only)" challenges. Tracked per board
// in solo + racing (Input.js flips these); reset at each board start; reported to the server on a clear.
// Puzzles/territory don't participate. clearReported gates one report per board.
var clearNoFlag = true, clearNoReveal = true, clearReported = false;
function resetClearChallenge() { clearNoFlag = true; clearNoReveal = true; clearReported = false; }
function reportClear() {
	if (clearReported) return;
	clearReported = true;
	if (account && typeof socket !== "undefined") socket.emit("record_clear", { noFlag: clearNoFlag, noReveal: clearNoReveal });
	refreshAchievementProgress(); // pull fresh stats so any unlock toasts
}

// Procedural sound effects (WebAudio, no asset files). Short and soft — these
// fire hundreds of times per game, so everything is brief and low-gain.
// sound system + AudioContext unlock listeners moved to Sound.js

var nameView = document.getElementById("name_view");
var lobbyView = document.getElementById("lobby_view");
var gameView = document.getElementById("game_view");
var openRoomList = document.getElementById("open_room_list");
var busyRoomList = document.getElementById("busy_room_list");
var lobbyMessage = document.getElementById("lobby_message");
var rankedTag = document.getElementById("ranked_tag");
var homeCards = document.getElementById("home_cards");
// Ranked cards are now anchor tags pointing at #/ranked/:style. The
// router translates that into findRanked() (tournament fires
// immediately; sprint/standard show the size picker first).
var rankTierSprint = document.getElementById("rank_tier_sprint");
var rankRatingSprint = document.getElementById("rank_rating_sprint");
var rankTierSprintSix = document.getElementById("rank_tier_sprint_six");
var rankRatingSprintSix = document.getElementById("rank_rating_sprint_six");
var rankTierStandard = document.getElementById("rank_tier_standard");
var rankRatingStandard = document.getElementById("rank_rating_standard");
var rankTierStandardSix = document.getElementById("rank_tier_standard_six");
var rankRatingStandardSix = document.getElementById("rank_rating_standard_six");
var rankTierTournament = document.getElementById("rank_tier_tournament");
var rankRatingTournament = document.getElementById("rank_rating_tournament");
var currentRankedMode = null;
var rankedSearching = document.getElementById("ranked_searching");
var rankedSearchingText = document.getElementById("ranked_searching_text");
var cancelRankedButton = document.getElementById("cancel_ranked_button");
var battleSearchStatus = document.getElementById("battle_search_status");
var battleSearchText = document.getElementById("battle_search_text");
var leaderboardList = document.getElementById("leaderboard_list");
// nameForm / nameInput / nameError / userBadge / userBadgeName / changeNameButton
// / signOutButton / ratingChip / signinOptions / githubSigninButton /
// googleSigninButton / devSigninButton are looked up in Auth.js.
var boardOverlay = document.getElementById("board_overlay");
var roundTimer = document.getElementById("round_timer");
var gameProgressText = document.getElementById("game_progress_text");
var muteButton = document.getElementById("mute_button");
var volumeSlider = document.getElementById("volume_slider");
var musicSlider = document.getElementById("music_slider");
var audioPanel = document.getElementById("audio_panel");
var readyButton = document.getElementById("ready_button");
var readyStatus = document.getElementById("ready_status");
var gameCountSelect = document.getElementById("game_count_select");
var gameCountReadonly = document.getElementById("game_count_readonly");
var roundSecondsSelect = document.getElementById("round_seconds_select");
var roundSecondsReadonly = document.getElementById("round_seconds_readonly");
var deathPenaltySelect = document.getElementById("death_penalty_select");
var deathPenaltyReadonly = document.getElementById("death_penalty_readonly");
var mineDensitySlider = document.getElementById("mine_density_slider");
var mineDensityControl = document.getElementById("mine_density_control");
var mineDensityVal = document.getElementById("mine_density_val");
var mineDensityReadonly = document.getElementById("mine_density_readonly");
var boardSizeSelect = document.getElementById("board_size_select");
var boardSizeReadonly = document.getElementById("board_size_readonly");
var seriesStatus = document.getElementById("series_status");
var seriesCard = document.getElementById("series_card");
var allOpponentsDiv = document.getElementById("all_opponents_div");
var scoreboardCard = document.getElementById("scoreboard_card");
var scoreboardEl = document.getElementById("scoreboard");
var botsCard = document.getElementById("bots_card");
var addBotButton = document.getElementById("add_bot_button");
var removeBotButton = document.getElementById("remove_bot_button");
var botStatus = document.getElementById("bot_status");
var botListEl = document.getElementById("bot_list");

var frozenUntil = 0;
var freezeTickHandle = null;
var roundDeadline = null;
var roundTickHandle = null;
var roundResultShown = false;

var focusedR = Math.floor(rows / 2);
var focusedC = Math.floor(cols / 2);
var focusVisible = false;
// The full board (mines + numbers) arrives once at start_game in obfuscated form
// and lives inside `boardDecoder` as a closure. Module-level code never holds the
// decoded 2D board; everything goes through boardCell(r, c) — readable from the
// boardDecoder + boardCell moved to BoardDecoder.js
var myState = null;
// Live-board animation queue + render loop moved to Animations.js.
var lastScores = {};           // playerId -> last rendered score, to flash gains
var liveProgress = {};         // playerId -> { progress, finished, finishedAt } from draw_board
var lastGames = null;          // last draw_board.games — used to repaint the duel opponent board on resize
var iAmEliminated = null;      // tournament: { round, place, totalParticipants } once cut
var spectatorTarget = null;    // when iAmEliminated, the player id whose board is rendered on slot 0
var spectatorTargetSkin = null; // and the skin to paint that watched board in (their skin, not yours)
// soloSession / soloTimerHandle / soloSelectedSize live in Solo.js.
var elimPanelDismissed = false;// player chose "Keep watching" — don't redraw the panel each round
var roundStartTime = 0;        // ms timestamp when the current round actually went live (after GO!)
var dangerActive = false;      // current red-border state; hysteresis keeps it from flickering
var DANGER_GRACE_MS = 10000;   // don't warn within the first N ms of a round
var dangerTarget = null;       // lazily resolved .player-board element to flash
var lastFinished = {};         // playerId -> whether they had cleared, to cue rival finishes

// Tournament round-end sequence — the COTD-flavoured reveal.
//
// Beats (rough timing budget, ~3.6s total to stay under the 4.5s
// BETWEEN_GAMES_DELAY_TOURNAMENT_CUT on the server):
//   0      scrim + frame fade in (~300ms)
//   200    rows slide in top→bottom (~50ms stagger, ~600ms total)
//   900    cutline divider draws between survivors and cuts (~300ms)
//   1100   eliminated rows flash red bottom→top (~140ms stagger)
//   1100+  survivor rows pulse green together (~700ms)
//   2200   verdict badge on the local player's row slides in
//   3400   scrim fades out, panel cleanup
// onComplete fires at 3400ms.  Returns the timeout id so callers can
// cancel if the room state changes mid-sequence (e.g. series_ended).
function playTournamentRoundEnd(data, onComplete) {
	var overlay = document.getElementById("tournament_round_overlay");
	var rowsEl = document.getElementById("tro_rows");
	var roundLabel = document.getElementById("tro_round_label");
	var subLabel = document.getElementById("tro_sub_label");
	var verdictEl = document.getElementById("tro_verdict");
	if (!overlay || !rowsEl) { if (onComplete) onComplete(); return null; }

	rowsEl.innerHTML = "";
	verdictEl.textContent = "";
	verdictEl.className = "tro-verdict";

	var standings = data.standings || [];
	var eliminated = data.tournamentEliminated || [];
	var elimIds = {};
	eliminated.forEach(function(e) { elimIds[e.id] = true; });

	var survivorsTarget = (typeof data.tournamentSurvivorsTarget === "number")
		? data.tournamentSurvivorsTarget
		: Math.max(0, standings.length - eliminated.length);
	var totalRounds = (currentRoom && currentRoom.tournamentSchedule)
		? currentRoom.tournamentSchedule.length : null;

	// Stage for the escalation skin: early / late / final.
	var stage = "early";
	if (survivorsTarget <= 1) stage = "final";
	else if (survivorsTarget <= 4) stage = "late";
	overlay.dataset.stage = stage;

	roundLabel.textContent = "Round " + data.gameNumber + (totalRounds ? " of " + totalRounds : "");
	subLabel.textContent = eliminated.length + " cut · " + survivorsTarget + " advance";

	// Build rows (already in rank order). Insert the cutline divider
	// after the last survivor row so we can animate it in mid-sequence.
	var rowNodes = []; // parallel array for later highlight passes
	var cutlineEl = null;
	standings.forEach(function(s, idx) {
		// Slide-in stagger keyed off rank so the top of the leaderboard
		// fills first (feels like a results screen, not a list dump).
		if (idx === survivorsTarget && idx > 0) {
			cutlineEl = document.createElement("div");
			cutlineEl.className = "tro-cutline";
			rowsEl.appendChild(cutlineEl);
		}
		var row = document.createElement("div");
		row.className = "tro-row";
		if (s.id === id) row.classList.add("tro-row-me");
		row.style.animationDelay = (200 + idx * 55) + "ms";

		var rankEl = document.createElement("div");
		rankEl.className = "tro-rank";
		rankEl.textContent = "#" + (s.rank || idx + 1);
		row.appendChild(rankEl);

		var nameEl = document.createElement("div");
		nameEl.className = "tro-name";
		nameEl.textContent = (s.id === id) ? "You" : (s.name || "Unknown");
		row.appendChild(nameEl);

		var detailEl = document.createElement("div");
		detailEl.className = "tro-detail";
		if (s.finished && typeof s.finishMs === "number") {
			detailEl.textContent = (s.finishMs / 1000).toFixed(2) + "s";
		} else {
			detailEl.textContent = (s.safeCount || 0) + " safe";
		}
		row.appendChild(detailEl);

		rowsEl.appendChild(row);
		rowNodes.push({ row: row, entry: s });
	});

	overlay.hidden = false;
	// next frame so the .visible transition actually runs
	requestAnimationFrame(function() { overlay.classList.add("visible"); });

	var timers = [];
	function later(ms, fn) { timers.push(setTimeout(fn, ms)); }

	// Cutline reveal
	later(900, function() { if (cutlineEl) cutlineEl.classList.add("visible"); });

	// Eliminated flashes — bottom-up so the last-place cut hits first
	// (cleaner read than top-down which would highlight #5 before #16).
	var cutRows = rowNodes.filter(function(rn) { return elimIds[rn.entry.id]; });
	cutRows.sort(function(a, b) { return (b.entry.rank || 0) - (a.entry.rank || 0); });
	cutRows.forEach(function(rn, i) {
		later(1100 + i * 140, function() { rn.row.classList.add("tro-cut"); });
	});

	// Survivor pulse — fires once, on everyone above the cut, after the
	// cuts have all flashed. The local "you" row gets its verdict on top.
	var survivorRows = rowNodes.filter(function(rn) { return !elimIds[rn.entry.id]; });
	var lastCutDelay = 1100 + Math.max(0, cutRows.length - 1) * 140;
	later(lastCutDelay + 100, function() {
		survivorRows.forEach(function(rn) { rn.row.classList.add("tro-survive"); });
	});

	// Verdict badge — what happened to the local player.
	var meEntry = standings.find(function(s) { return s.id === id; });
	var meCut = meEntry && elimIds[id];
	later(lastCutDelay + 700, function() {
		if (!meEntry) return; // pure spectator (already eliminated previous round)
		if (meCut) {
			verdictEl.innerHTML = "Eliminated <span class=\"tro-verdict-sub\">Finished #" + meEntry.rank + "</span>";
			verdictEl.classList.add("show", "eliminated");
		} else if (survivorsTarget === 1) {
			// Final round survivor — they won the tournament. The
			// "close call" label would be silly here (it's literally
			// the only seat left), and series_ended will follow up
			// with the full championship panel anyway.  Skip verdict.
		} else {
			var rank = meEntry.rank;
			var cushion = survivorsTarget - rank; // 0 means you were the lowest survivor
			var label = "Survived";
			var sub;
			if (cushion === 0) {
				label = "Close call";
				sub = "Last survivor — by one place";
				verdictEl.classList.add("close");
			} else if (cushion === 1) {
				sub = "By one place";
				verdictEl.classList.add("close");
			} else {
				sub = "Safe — " + cushion + " places clear";
			}
			verdictEl.innerHTML = label + " <span class=\"tro-verdict-sub\">" + sub + "</span>";
			verdictEl.classList.add("show", "survived");
		}
	});

	// Tear-down: fade scrim, hide after transition, then notify.
	var totalMs = lastCutDelay + 2200;
	later(totalMs - 300, function() { overlay.classList.remove("visible"); });
	later(totalMs, function() {
		overlay.hidden = true;
		rowsEl.innerHTML = "";
		verdictEl.textContent = "";
		verdictEl.className = "tro-verdict";
		overlay.dataset.stage = "";
		if (onComplete) onComplete();
	});

	return timers;
}

// Name form + sign-in/out button bindings live in Auth.js.

function refreshMuteIcon() {
	// Speaker icon reflects the OVERALL state — silent only when both
	// channels are muted (mute toggle or volume at 0).
	var sfxOff = sound.isMuted() || sound.getVolume() === 0;
	var musOff = !music || music.isMuted() || music.getVolume() === 0;
	muteButton.textContent = (sfxOff && musOff) ? "🔇" : "🔊";
}
volumeSlider.value = String(Math.round(sound.getVolume() * 100));
if (typeof music !== "undefined") musicSlider.value = String(Math.round(music.getVolume() * 100));
refreshMuteIcon();

function setAudioPanelOpen(open) {
	if (open) audioPanel.removeAttribute("hidden");
	else audioPanel.setAttribute("hidden", "");
}
muteButton.addEventListener("click", function(e) {
	e.stopPropagation();
	sound.unlock();
	if (typeof music !== "undefined") music.unlock();
	setAudioPanelOpen(audioPanel.hasAttribute("hidden"));
});
document.addEventListener("click", function(e) {
	if (audioPanel.hasAttribute("hidden")) return;
	if (audioPanel.contains(e.target) || muteButton.contains(e.target)) return;
	setAudioPanelOpen(false);
});
volumeSlider.addEventListener("input", function() {
	sound.unlock();
	var v = parseInt(volumeSlider.value, 10) / 100;
	sound.setVolume(v);
	sound.setMuted(v === 0);
	refreshMuteIcon();
});
musicSlider.addEventListener("input", function() {
	if (typeof music === "undefined") return;
	music.unlock();
	var v = parseInt(musicSlider.value, 10) / 100;
	music.setVolume(v);
	music.setMuted(v === 0);
	refreshMuteIcon();
});

document.getElementById("open_daily_button").addEventListener("click", function() {
	navigate("/puzzles/daily");
});

document.getElementById("puzzle_hint_btn").addEventListener("click", function() {
	if (!puzzleSession || puzzleSession.finished) return;
	socket.emit("puzzle_hint");
});

document.getElementById("puzzle_retry_btn").addEventListener("click", function() {
	if (!puzzleSession) return;
	socket.emit("puzzle_retry", { puzzleId: puzzleSession.puzzleId });
});

document.getElementById("puzzle_skip_btn").addEventListener("click", function() {
	socket.emit("puzzle_next");
});

document.getElementById("puzzle_side_back").addEventListener("click", function() {
	navigate("/");
});

// Spectator: click a scoreboard row to switch which player's board shows
// on the big slot-0 canvas.  Delegated since the scoreboard re-renders on
// every draw_board.  No-op when not eliminated; you can't redirect what
// you yourself are playing.
scoreboardEl.addEventListener("click", function(e) {
	if (!iAmEliminated) return;
	var row = e.target.closest("li.score-row");
	if (!row || !row.dataset.pid) return;
	if (row.dataset.pid === id) return;
	if (spectatorTarget === row.dataset.pid) return;
	spectatorTarget = row.dataset.pid;
	// Repaint slot 0 + the small opponent slots immediately from the last
	// cached frame — without this the big board only switches when the
	// new target makes their next move (which can be many seconds away,
	// or never if they've already finished), so it feels stuck.
	if (latestSpectatorGames) repaintSpectatorView(latestSpectatorGames);
	renderScoreboard(); // refresh the .score-row-watching highlight
});


// --- Create-a-room modal: pick the full ruleset up front, then drop into the room. ---
(function wireCreateRoomModal() {
	var modal = document.getElementById("create_room_modal");
	if (!modal) return;
	function openModal() { modal.removeAttribute("hidden"); }
	function closeModal() { modal.setAttribute("hidden", ""); }

	document.getElementById("create_room_button").addEventListener("click", openModal);
	modal.addEventListener("click", function(e) {
		if (e.target.hasAttribute("data-cr-close")) closeModal();
	});
	document.addEventListener("keydown", function(e) {
		if (e.key === "Escape" && !modal.hasAttribute("hidden")) closeModal();
	});

	// Segmented controls: one active button per group.
	modal.querySelectorAll(".cr-seg").forEach(function(seg) {
		seg.addEventListener("click", function(e) {
			var btn = e.target.closest("button[data-val]");
			if (!btn || !seg.contains(btn)) return;
			seg.querySelectorAll("button").forEach(function(b) { b.classList.remove("active"); });
			btn.classList.add("active");
		});
	});

	function selected(group) {
		var seg = modal.querySelector('.cr-seg[data-cr="' + group + '"] button.active');
		return seg ? seg.dataset.val : null;
	}

	// Mine density is a 10%–30% slider; reflect its value live next to the label.
	var densitySlider = document.getElementById("cr_density");
	var densityVal = document.getElementById("cr_density_val");
	if (densitySlider && densityVal) {
		densitySlider.addEventListener("input", function() { densityVal.textContent = densitySlider.value + "%"; });
	}

	document.getElementById("cr_create").addEventListener("click", function() {
		socket.emit("create_room", {
			players: parseInt(selected("players"), 10),
			boardSize: selected("boardSize"),
			mineDensity: densitySlider ? parseInt(densitySlider.value, 10) / 100 : 0.1,
			roundSeconds: parseInt(selected("roundSeconds"), 10),
			deathPenalty: parseInt(selected("deathPenalty"), 10),
			gameCount: parseInt(selected("gameCount"), 10)
		});
		closeModal();
	});
})();

// --- Help modal: concise rules + controls, opened from the navbar Help button. ---
(function wireHelpModal() {
	var modal = document.getElementById("help_modal");
	var trigger = document.getElementById("help_nav_link");
	if (!modal || !trigger) return;
	// Two small example boards illustrating the rules: the same layout shown first with just
	// its number clues, then with the mines flagged. Rendered once (lazily on first open).
	function renderHelpBoards() {
		if (typeof buildLearnPuzzle !== "function") return;
		var mines = [[0, 1], [1, 0], [1, 1]];
		var key = {}; mines.forEach(function(m) { key[m[0] + "," + m[1]] = 1; });
		var safe = [];
		for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) if (!key[r + "," + c]) safe.push([r, c]);
		function render(id, flagged) {
			var slot = document.getElementById(id);
			if (!slot || slot.firstChild) return; // render once
			var el = buildLearnPuzzle({ title: "", rows: 4, cols: 4, mines: mines, revealed: safe, flagged: flagged }, false, function() {});
			el.style.pointerEvents = "none";
			slot.appendChild(el);
		}
		render("help_board_numbers", []);
		render("help_board_flags", mines);
	}
	function openHelp() {
		// Fill the control-key chips from the live (rebindable) keybindings.
		if (typeof keybindings !== "undefined") {
			var set = function(id, action) {
				var el = document.getElementById(id);
				if (el) el.textContent = keybindings.label(keybindings.get(action));
			};
			set("help_key_reveal", "reveal");
			set("help_key_flag", "flag");
			set("help_key_next", "next");
		}
		renderHelpBoards();
		modal.removeAttribute("hidden");
	}
	function closeHelp() { modal.setAttribute("hidden", ""); }
	trigger.addEventListener("click", openHelp);
	modal.addEventListener("click", function(e) {
		// Close on backdrop, the × button, or the Profile link (which also navigates).
		if (e.target.closest("[data-help-close]")) closeHelp();
	});
	document.addEventListener("keydown", function(e) {
		if (e.key === "Escape" && !modal.hasAttribute("hidden")) closeHelp();
	});
})();

document.getElementById("refresh_button").addEventListener("click", function() {
	socket.emit("list_rooms");
});

// Pre-game Start button over the board → run the countdown, then unlock the board.
document.getElementById("solo_start_btn").addEventListener("click", function() {
	if (typeof beginSolo === "function") beginSolo();
});

// In-game solo sidebar (#solo_card): quick re-rolls — these launch a new board immediately.
document.getElementById("solo_restart").addEventListener("click", function() {
	startSolo(soloSelectedSize);
});

(function wireSoloSizeButtons() {
	var btns = document.querySelectorAll(".solo-size-btn");
	for (var i = 0; i < btns.length; i++) {
		btns[i].addEventListener("click", function(e) {
			var size = e.currentTarget.getAttribute("data-size");
			soloSelectedSize = size;
			for (var j = 0; j < btns.length; j++) btns[j].classList.toggle("active", btns[j] === e.currentTarget);
			startSolo(size);
		});
	}
})();

(function wireSoloDensityButtons() {
	var btns = document.querySelectorAll(".solo-density-btn");
	for (var i = 0; i < btns.length; i++) {
		btns[i].addEventListener("click", function(e) {
			soloSelectedDensity = parseFloat(e.currentTarget.getAttribute("data-density"));
			for (var j = 0; j < btns.length; j++) btns[j].classList.toggle("active", btns[j] === e.currentTarget);
			startSolo(soloSelectedSize);
		});
	}
})();

// Lobby functions moved to Lobby.js.


cancelRankedButton.addEventListener("click", function() {
	socket.emit("cancel_ranked");
	currentRankedMode = null;
	setRankedSearching(false);
	exitGameFullscreen();
});

document.getElementById("leave_button").addEventListener("click", function() {
	if (rankedSearch) { cancelBattleSearch(); return; } // still searching → cancel the queue, leave
	if (soloSession) { exitSolo(); return; }
	if (puzzleSession) { navigate("/"); return; }
	if (currentRoom && currentRoom.phase === "playing") {
		showConfirm("Leaving now counts as a loss.", {
			title: "Leave game?", okText: "Leave", cancelText: "Stay", danger: true
		}).then(function(ok) { if (ok) leaveRoom(); });
		return;
	}
	leaveRoom();
});

readyButton.addEventListener("click", function() {
	enterGameFullscreen();
	socket.emit("player_ready");
});

gameCountSelect.addEventListener("change", function() {
	socket.emit("set_game_count", { count: parseInt(gameCountSelect.value, 10) });
});

roundSecondsSelect.addEventListener("change", function() {
	socket.emit("set_round_seconds", { seconds: parseInt(roundSecondsSelect.value, 10) });
});

deathPenaltySelect.addEventListener("change", function() {
	socket.emit("set_death_penalty", { seconds: parseInt(deathPenaltySelect.value, 10) });
});

if (mineDensitySlider) {
	// Live %, plus a debounced server update so dragging doesn't spam the socket.
	var densityCommit = null;
	mineDensitySlider.addEventListener("input", function() {
		if (mineDensityVal) mineDensityVal.textContent = mineDensitySlider.value + "%";
		clearTimeout(densityCommit);
		densityCommit = setTimeout(function() {
			socket.emit("set_mine_density", { density: parseInt(mineDensitySlider.value, 10) / 100 });
		}, 150);
	});
	mineDensitySlider.addEventListener("change", function() {
		clearTimeout(densityCommit);
		socket.emit("set_mine_density", { density: parseInt(mineDensitySlider.value, 10) / 100 });
	});
}

boardSizeSelect.addEventListener("change", function() {
	socket.emit("set_board_size", { size: boardSizeSelect.value });
});

addBotButton.addEventListener("click", function() {
	socket.emit("add_bot");
});

removeBotButton.addEventListener("click", function() {
	socket.emit("remove_bot");
});

var searchCountText = document.getElementById("search_count_text");
var searchSizeText = document.getElementById("search_size_text");



// Update board dimensions and re-size canvases when the room's size changes.
// a best-of-N. Tournament prints "Round N/M · K remaining".

// renderRatingBadge + auth socket handler bodies live in Auth.js.
// In-room state rendering moved to GameRoom.js.

socket.on("connected", applyConnected);
socket.on("authenticated", applyAuthenticated);

var leaderboardProvisional = 10;
socket.on("leaderboard", function(data) {
	if (data && data.provisionalGames) leaderboardProvisional = data.provisionalGames;
	// Ignore a reply for a mode the user has since switched away from (tab races).
	if (data && data.mode && typeof currentLeaderboardMode !== "undefined" && data.mode !== currentLeaderboardMode) return;
	renderLeaderboard((data && data.players) || []);
});

var leaderboardFullList = document.getElementById("leaderboard_full_list");

// renderLeaderboard moved to Leaderboard.js.

socket.on("auth_failed", applyAuthFailed);
socket.on("name_rejected", applyNameRejected);
socket.on("name_accepted", applyNameAccepted);

socket.on("room_list", function(data) {
	renderRoomList(data.rooms || []);
	if (typeof renderHomeRooms === "function") renderHomeRooms(data.rooms || []);
});

socket.on("match_history", function(data) {
	if (typeof renderMatchHistory === "function") renderMatchHistory(data);
});

socket.on("replay_data", function(data) {
	if (typeof onReplayData === "function") onReplayData(data);
});

socket.on("joined_room", function(data) {
	inRoom = true;
	if (data && data.mode) currentRankedMode = data.mode;
	iAmEliminated = null;
	elimPanelDismissed = false;
	setRankedSearching(false);
	endBattleSearch();        // a match formed — drop the in-battle search state (room_state takes over)
	showGameView();
	resetGameUI();
});

// --- In-battle ranked search ---------------------------------------------------------------------
// For the racing ranked modes (1v1 + 6P Sprint/Standard) we drop the player straight into the battle
// layout and slot opponents into the opponent boards as the search fills, instead of a separate
// waiting-room overlay. Territory/Tournament still use the roster overlay (setRankedSearching).
function startBattleSearch(mode) {
	rankedSearch = { mode: mode, size: rankedModeSize(mode), race: true, members: [] };
	currentRoom = null;
	inRoom = false;
	roundResultShown = false; // fresh search — clear the previous result so the new field re-covers
	applyBoardDims(15, 20);   // ranked race boards are the medium preset — covered-placeholder size
	showGameView();
	resetGameUI();
	readyButton.style.display = "none";   // nothing to ready while searching
	if (rankedTag) rankedTag.style.display = "";
	applyDuoClass();
	setCoveredBoard();        // paints your own board + the opponent slots covered
	updateBattleSearch();
}
function updateBattleSearch() {
	if (!rankedSearch) return;
	applyDuoClass();
	buildDuelIdentity();
	paintOpponentCovered();
	var filled = (rankedSearch.members || []).length;
	if (battleSearchText) battleSearchText.textContent = "Finding match · " + filled + "/" + rankedSearch.size;
	if (battleSearchStatus) battleSearchStatus.style.display = "";
}
// Clear the search state + status (the layout/boards are taken over by room_state, or torn down on cancel).
function endBattleSearch() {
	rankedSearch = null;
	if (battleSearchStatus) battleSearchStatus.style.display = "none";
}
// Leave an in-battle search (the "Exit game" button while still searching): cancel the queue and bail.
function cancelBattleSearch() {
	socket.emit("cancel_ranked");
	currentRankedMode = null;
	endBattleSearch();
	exitGameFullscreen();
	teardownRoomUI();
}

socket.on("ranked_searching", function(data) {
	rankedSearchInfo = data || {};
	// In-battle search for the racing modes; the legacy roster overlay for territory/tournament.
	if (rankedSearch && isRaceRankedMode(rankedSearchInfo.mode || rankedSearch.mode)) {
		rankedSearch.members = rankedSearchInfo.members || [];
		if (rankedSearchInfo.size) rankedSearch.size = rankedSearchInfo.size;
		updateBattleSearch();
	} else {
		setRankedSearching(true);
	}
});

socket.on("ranked_rejected", function(data) {
	setRankedSearching(false);
	showLobbyMessage((data && data.reason) || "Couldn't start ranked search.");
});

// Admin rank-setter (Design page) echoed back the new ratings — apply them to the account and refresh
// the rank UI (topbar badge, home chips, and the Design page's own "your rank" preview).
socket.on("admin_rating_set", function(data) {
	if (!account || !data) return;
	["ratingSprint", "ratingStandard", "ratingTournament", "ratingTerritory"].forEach(function(f) {
		if (typeof data[f] === "number") account[f] = data[f];
	});
	if (typeof renderRatingBadge === "function") renderRatingBadge();
	if (typeof renderHomeRankChips === "function") renderHomeRankChips();
	var dv = document.getElementById("design_view");
	if (typeof renderDesign === "function" && dv && dv.style.display !== "none") renderDesign();
});

// Local teardown of the in-game UI: drop room state, clear danger, reset territory, and
// re-route to the current URL (which hides #game_view). Used both when WE leave (leaveRoom —
// applied immediately) and when the server confirms it (left_room).
function teardownRoomUI() {
	if (typeof territoryReset === "function") territoryReset();
	if (typeof clearPlaceBadges === "function") clearPlaceBadges();
	if (typeof music !== "undefined") music.pause(); // stop the music only when truly leaving the game
	inRoom = false;
	currentRoom = null;
	iAmEliminated = null;
	elimPanelDismissed = false;
	roundStartTime = 0;
	setDanger(false);
	applyRouteFromHash();
}

// Leave the current room. Tears the UI down IMMEDIATELY rather than waiting for the server's
// left_room echo — so the game view never lingers if that echo is slow/dropped or the route
// fails to switch. The echo still arrives and applies any ranked Elo delta.
function leaveRoom() {
	exitGameFullscreen();
	socket.emit("leave_room");
	teardownRoomUI();
}

socket.on("left_room", function(data) {
	// Ranked early-leave penalty: server applied an Elo loss as if we came last
	// in the current series. Update the topbar + show the banner / delta.
	if (data && typeof data.rating === "number") {
		updateRatingFromStandings([{
			id: id,
			rating: data.rating,
			ratingDelta: data.ratingDelta,
			provisional: data.provisional
		}]);
	}
	// "Play another" leaves the finished room and immediately re-queues in the battle UI. The
	// server's left_room echo arrives after we've started that new search — don't tear the view down
	// (which would route us back to the lobby); the new search owns the screen now.
	if (rankedSearch) return;
	teardownRoomUI();
});

socket.on("join_failed", function(data) {
	showLobbyMessage(data && data.reason ? data.reason : "Couldn't join room");
});

socket.on("room_state", function(state) {
	currentRoom = state;
	applyDuoClass();              // 1v1 racing → side-by-side duel layout
	applyBoardDims(state.rows, state.cols);
	sizeOpponentCanvases();       // resize the opponent board for the (new) duo/non-duo layout
	buildDuelIdentity();          // populate the battle identity panels from the roster
	renderRoomState(state);
	// Ranked battle: show the whole field (covered) the moment you join, before the countdown starts.
	// But NOT once a result is showing — the room flips back to "planning" at series end, and
	// re-covering then would wipe the finish-place stamps we want to keep under the result modal.
	if ((gameView.classList.contains("duo") || gameView.classList.contains("multi")) && state.phase === "planning" && !roundResultShown) setCoveredBoard();
});

// Territory (versus) mode — shared-board events handled in Territory.js.
socket.on("territory_start", function(data) { if (typeof territoryStart === "function") territoryStart(data); });
socket.on("territory_board", function(data) { if (typeof territoryBoard === "function") territoryBoard(data); });
socket.on("territory_result", function(data) { if (typeof territoryResult === "function") territoryResult(data); });

// Paint the board as a full grid of covered cells. Shown during the ranked match-reveal
// window and the pre-round countdown so the player sees the board taking shape, not a black
// canvas. Covered cells don't read the board decoder, so this works before it's installed.
function setCoveredBoard() {
	if (!rows || !cols) return;
	clearPlaceBadges(); // a fresh round starts covered — drop the previous round's finish places
	resetClearChallenge(); // new board → reset the no-flag / chord-only tracking

	myState = new Array(rows);
	for (var r = 0; r < rows; r++) {
		myState[r] = new Array(cols);
		for (var c = 0; c < cols; c++) myState[r][c] = UNKNOWN;
	}
	prevPlayerState = cloneState(myState);
	renderPlayerBoard();
	if (isBattleRacing()) paintOpponentCovered(); // battle: show the opponents' boards covered too
}

// Paint the opponent's board (game1) as a full grid of covered cells, and make sure its card is
// visible. Used in the duel so you see the opponent's board immediately on joining and through the
// countdown — before their first real frame arrives (which then overwrites it via draw_board).
function paintOpponentCovered() {
	if (!isBattleRacing() || !rows || !cols) return;
	if (allOpponentsDiv) allOpponentsDiv.style.display = "";
	sizeOpponentCanvases();
	var covered = new Array(rows);
	for (var r = 0; r < rows; r++) {
		covered[r] = new Array(cols);
		for (var c = 0; c < cols; c++) covered[r][c] = UNKNOWN;
	}
	var searching = !!(rankedSearch && rankedSearch.race);
	// Opponents (everyone but me), in roster order, so each card shows a name + covered board.
	var oppPlayers = battleRoster().filter(function(p) { return !(p.id === id || p.isYou); });
	// How many opponent slots to show: during search, the full field minus you (so still-empty seats
	// read as "Searching…" placeholders); in a live room, exactly the opponents present.
	var slotCount = searching ? Math.max(0, battleSize() - 1) : oppPlayers.length;
	var slots = document.querySelectorAll('[data-slot]');
	for (var i = 1; i <= 5; i++) {
		var slot = slots[i - 1];
		var p = oppPlayers[i - 1];
		var cv = document.getElementById("game" + i);
		var nameEl = document.getElementById("player_name" + i);
		if (i <= slotCount) {
			if (slot) {
				slot.style.display = "";
				slot.dataset.pid = p ? (p.id || "") : "";
				slot.classList.toggle("opponent-searching", searching && !p);
			}
			if (nameEl) nameEl.textContent = p ? playerLabel(p.name, 0) : "Searching…";
			if (cv) drawBoardStatic(covered, cv, (p && p.skin) || "classic");
			setOppRankBadge(slot, p && typeof p.rating === "number" ? p.rating : null);
		} else if (slot) {
			slot.style.display = "none";
			slot.classList.remove("opponent-searching");
			setOppRankBadge(slot, null);
		}
	}
}

socket.on("start_game", function(data) {
	if (typeof music !== "undefined") music.resume();
	// Entering play: turn the battle layout on directly (currentRoom.phase may not have flipped to
	// "playing" yet on this client), so the covered countdown board already shows the field.
	if (typeof gameView !== "undefined" && gameView) {
		if (isDuoRacing()) gameView.classList.add("duo");
		else if (isMultiRacing()) gameView.classList.add("multi");
	}
	sizeOpponentCanvases();
	buildDuelIdentity();
	// Eliminated spectators get start_game too (server emits it so their
	// decoder + dims update), but they skip the playable countdown and the
	// myState reset.  We DO install the new round's boardDecoder so the
	// spectated player's reveals render against the correct mine layout —
	// without this, slot-0 paints opponent state against last round's board.
	if (iAmEliminated) {
		hideReadyButton();
		if (data.boardData && data.boardMask) {
			installBoardDecoder(data.boardData, data.boardMask, data.rows || rows, data.cols || cols);
			applyBoardDims(data.rows || rows, data.cols || cols);
		}
		// Reset spectator target so the new round picks a fresh leader on
		// the first draw_board.  Leaving the previous round's target in
		// place would briefly render a player who hasn't started yet.
		spectatorTarget = null;
		// Wipe slot-0 to avoid a one-frame flash of the previous round's
		// final state while we wait for the first draw_board.
		var pc = document.getElementById("game0");
		if (pc) clearCanvas(pc);
		gameProgressText.textContent = formatGameProgress(data.gameNumber, data.gameCount, (currentRoom && currentRoom.scoreTarget) || data.scoreTarget);
		showRoundCutPreview(data);
		if (elimPanelDismissed) hideOverlay();
		else showTournamentEliminationPanel(iAmEliminated);
		return;
	}
	hideReadyButton();
	clearFreeze();
	roundResultShown = false;
	focusedR = Math.floor(rows / 2);
	focusedC = Math.floor(cols / 2);
	focusVisible = false;
	// Clear myState too — not just prev (which resetBoardAnimations handles).
	// The draw_board handler merges optimistic state into incoming server
	// state to survive stale broadcasts (bot tick races); if we leave the
	// previous game's myState in place, the next round's first draw_board
	// gets game-1's KNOWN cells merged onto game-2's fresh board, which
	// then re-renders revealed and (if mines now sit there) explodes.
	myState = null;
	resetBoardAnimations();
	lastFinished = {};
	roundStartTime = 0;
	setDanger(false);
	if (data.boardData && data.boardMask) {
		installBoardDecoder(data.boardData, data.boardMask, data.rows || rows, data.cols || cols);
	}
	gameProgressText.textContent = formatGameProgress(data.gameNumber, data.gameCount, (currentRoom && currentRoom.scoreTarget) || data.scoreTarget);
	showRoundCutPreview(data);
	// Paint the board as a full grid of covered cells so the countdown plays over the board
	// instead of a black canvas; the first draw_board (after GO) reveals the centre.
	setCoveredBoard();
	countDown(data.time);
	if (mobileLayout) scrollToCell(Math.floor(rows / 2), Math.floor(cols / 2), false);
	updateMobileFindNextHint();
});

// Pre-round "X to be eliminated" banner. Floats above the countdown for
// tournament rounds with a cut; auto-hides when the round starts.  Skipped
// for the final round (2 → 1) since the round overlay's series_ended panel
// already frames that as the championship.
function showRoundCutPreview(data) {
	var el = document.getElementById("round_cut_preview");
	if (!el) return;
	el.style.display = "none";
	el.textContent = "";
	var willCut = data.tournamentCutThisRound;
	var survivors = data.tournamentSurvivorsThisRound;
	if (!willCut || willCut <= 0) return;
	if (survivors === 1) {
		// Final round: keep it short and grand.
		el.textContent = "Final · Winner takes the crown";
	} else {
		el.textContent = willCut + " eliminations this round";
	}
	el.style.display = "";
	// Auto-clear once the countdown completes (COUNT_DOWN_TIME + 700ms GO hold).
	setTimeout(function() {
		el.style.display = "none";
		el.textContent = "";
	}, (data.time || 3) * 1000 + 700);
}

// Decode a XOR-masked board blob from the server. The decoded bytes never leave
// this closure; outsiders only get the (r,c) accessor via boardCell().

socket.on("game_result", function(data) {
	roundResultShown = true;
	setDanger(false);
	clearFreeze();
	stopRoundTimer();
	// 6-player battle: fill in every board's final place from the standings (finishers keep the
	// place the live updater gave them; non-finishers now get theirs too).
	applyMultiFinalPlaces(data.standings);
	var eliminatedNow = iAmEliminated && iAmEliminated.round === data.gameNumber;
	var target = (currentRoom && currentRoom.scoreTarget) || data.scoreTarget;
	var seriesOver = target
		? (currentRoom && currentRoom.players.some(function(p) { return (p.score || 0) >= target; }))
		: data.gameNumber >= data.gameCount;

	// Tournament rounds with a cut get the full COTD-style sequence —
	// scrim, standings, cutline draw, staggered red flashes, survivor
	// pulse, verdict badge. The just-eliminated player's elim panel is
	// held until after the reveal so they actually see the moment they
	// got cut, not a panel that obscures it.
	if (data.tournamentEliminated && data.tournamentEliminated.length) {
		if (eliminatedNow) hideOverlay();
		playTournamentRoundEnd(data, function() {
			// For the just-eliminated player, open the rich elim panel
			// *after* the reveal — unless the series is also ending this
			// round, in which case series_ended will already have shown
			// its own panel and we don't want to fight it.
			if (eliminatedNow && !seriesOver) {
				showTournamentEliminationPanel(iAmEliminated);
			}
		});
		// Survivors don't get a round-result panel mid-tournament; the
		// next round starts inside the BETWEEN_GAMES_DELAY budget.
		if (!seriesOver) {
			if (data.winnerId === id) sound.win(); else sound.lose();
		}
		return;
	}

	// No per-round result dialogue anymore; just the win/lose feedback sound for intermediate
	// rounds of a best-of-N. The final round's outcome is owned by series_ended.
	if (!seriesOver) {
		if (data.winnerId === id) sound.win(); else sound.lose();
	}
});

socket.on("mine_hit", function(data) {
	frozenUntil = data.frozenUntil;
	startFreezeTick();
});

socket.on("series_ended", function(data) {
	setDanger(false);
	gameProgressText.textContent = "";
	stopRoundTimer();
	// Music keeps playing under the result modal — and straight through "Play another" into the next
	// match. It's only stopped when you actually leave the game (teardownRoomUI).
	var iWon = data.winnerId === id;
	if (typeof sound !== "undefined") (iWon ? sound.seriesWin : sound.lose)();
	// Both 1v1 and 6-player show the same flow: the finish-place stamps (1st/2nd/…) are already on
	// the boards, then the shared ranked result card.
	showResultModal(data);
	refreshAchievementProgress();
});

// Match found: no pre-game modal — the search waiting room already showed who's joining.
// Drop straight into the game layout with a covered board; the server starts the countdown
// (start_game) a beat later.
socket.on("match_reveal", function() {
	setCoveredBoard();
	if (typeof sound !== "undefined") sound.matchFound();
});

// Sent only to the player(s) cut at the end of a tournament round. They stay
// in the room (sockets joined) so they still receive series_ended at the end.
// The Elo update is applied server-side at elimination time, and the rating
// delta is carried in this event so the topbar bump + rank banner fire now.
socket.on("tournament_eliminated", function(data) {
	iAmEliminated = data;
	elimPanelDismissed = false;
	if (typeof data.rating === "number") {
		updateRatingFromStandings([{
			id: id,
			rating: data.rating,
			ratingDelta: data.ratingDelta,
			provisional: data.provisional
		}]);
	}
	// Don't open the elim panel here — game_result is about to fire and
	// will run the round-end reveal sequence; the panel pops afterwards
	// (via onComplete) so the player actually witnesses the moment they
	// got cut instead of an immediate panel covering the board.
	stopRoundTimer();
});

var latestSpectatorGames = null; // last draw_board.games while iAmEliminated — used to repaint slot 0 on a target switch

// Paint the big slot-0 canvas with the currently-spectated player's state.
// If spectatorTarget is unset / stale, default to the live leader.
function paintSpectatorBigBoard(games) {
	var liveGames = games.slice(1).filter(function(g) { return g; });
	if (!spectatorTarget || !liveGames.some(function(g) { return g.id === spectatorTarget; })) {
		var sorted = liveGames.slice().sort(function(a, b) {
			if (a.finished !== b.finished) return a.finished ? -1 : 1;
			if (a.finished && b.finished) return (a.finishedAt || 0) - (b.finishedAt || 0);
			return (b.progress || 0) - (a.progress || 0);
		});
		if (sorted[0]) spectatorTarget = sorted[0].id;
	}
	var target = spectatorTarget ? liveGames.find(function(g) { return g.id === spectatorTarget; }) : null;
	var nameEl0 = document.getElementById("player_name0");
	if (target) {
		nameEl0.textContent = "Spectating " + target.playerName;
		myState = target.state;
		prevPlayerState = cloneState(target.state);
		spectatorTargetSkin = target.skin || "classic"; // watched board paints in its owner's skin
		renderPlayerBoard();
	} else {
		nameEl0.textContent = "Eliminated";
		clearCanvas(document.getElementById("game0"));
	}
}

// Click-triggered refresh: rerun the whole spectator view (big board +
// small opponent slots) against the last cached frame so a switch is
// instant instead of waiting on the next server tick.
function repaintSpectatorView(games) {
	paintSpectatorBigBoard(games);
	// Mirror the slot 1-2 logic from draw_board so the small slots also
	// drop the new target out of their list immediately.
	var opponents = games.slice(1).filter(function(g) {
		return g && (!iAmEliminated || !spectatorTarget || g.id !== spectatorTarget);
	});
	opponents.sort(function(a, b) {
		if (a.finished !== b.finished) return a.finished ? -1 : 1;
		if (a.finished && b.finished) return (a.finishedAt || 0) - (b.finishedAt || 0);
		return (b.progress || 0) - (a.progress || 0);
	});
	var slots = document.querySelectorAll('[data-slot]');
	for (var i = 1; i <= 5; i++) {
		var nameEl = document.getElementById("player_name" + i);
		var canvasEl = document.getElementById("game" + i);
		var slot = slots[i - 1];
		var opp = i <= 2 ? opponents[i - 1] : null;
		if (opp) {
			setHudName(nameEl, opp);
			drawBoardStatic(opp.state, canvasEl, opp.skin || "classic");
			if (slot) { slot.style.display = ""; slot.dataset.pid = opp.id || ""; }
		} else {
			setHudName(nameEl, null);
			clearCanvas(canvasEl);
			if (slot) { slot.style.display = "none"; delete slot.dataset.pid; }
		}
	}
}

socket.on("draw_board", function(data) {
	var games = data.games;
	lastGames = games;
	if (iAmEliminated) latestSpectatorGames = games;
	var slots = document.querySelectorAll('[data-slot]');
	// Cache live progress per player so the scoreboard can show "% cleared" in
	// real time and rank players by it.
	for (var gi = 0; gi < games.length; gi++) {
		var g = games[gi];
		if (g && g.id) liveProgress[g.id] = {
			progress: g.progress || 0,
			finished: !!g.finished,
			finishedAt: g.finishedAt || 0,
			safeCount: g.safeCount || 0,
			totalSafe: g.totalSafe || 0
		};
	}

	// Slot 0 = player's own board (always). Merge in our optimistic local
	// state for the cells the server hasn't echoed yet — a bot's tick on
	// another socket can trigger an updateDraw broadcast that fires before
	// our own click handler runs server-side, so the broadcast briefly
	// carries our pre-click state. Without this, the first click visibly
	// "reverts" until our click handler catches up.
	var me = games[0];
	if (!me && iAmEliminated) {
		paintSpectatorBigBoard(games);
	}
	if (me) {
		setHudName(document.getElementById("player_name0"), me);
		if (myState) {
			for (var rr = 0; rr < rows; rr++) {
				for (var cc = 0; cc < cols; cc++) {
					// Reveal is monotonic — the server can never un-reveal a cell,
					// so keep any locally-revealed cell revealed.
					if (myState[rr][cc] === KNOWN && me.state[rr][cc] !== KNOWN) {
						me.state[rr][cc] = KNOWN;
					}
					// Trust our most recent flag intent over a stale broadcast.
					else if (myState[rr][cc] === FLAGGED && me.state[rr][cc] === UNKNOWN) {
						me.state[rr][cc] = FLAGGED;
					}
					else if (myState[rr][cc] === UNKNOWN && me.state[rr][cc] === FLAGGED) {
						me.state[rr][cc] = UNKNOWN;
					}
				}
			}
		}
		queueRevealAnimations(me.state);
		myState = me.state;
		prevPlayerState = cloneState(me.state);
		renderPlayerBoard();
		updateMobileFindNextHint();
		// Racing clear → report the no-flag / chord-only challenge (once per board).
		if (me.finished && me.totalSafe > 0 && (me.safeCount || 0) >= me.totalSafe) reportClear();
	}

	// Slots 1-2 = top two opponents by live progress (finished outranks playing,
	// then by % cleared). Other opponents stay hidden — large lobbies would be
	// unreadable otherwise; the scoreboard surfaces everyone with progress bars.
	// When spectating, skip the target player here since they're already on
	// the big board (showing the same player in both slots would be wasteful).
	var opponents = games.slice(1).filter(function(g) {
		return g && (!iAmEliminated || !spectatorTarget || g.id !== spectatorTarget);
	});
	if (isMultiRacing()) {
		// 6-player battle: lock the opponent grid to a fixed order by starting rating (stable through
		// the match) so the boards don't jump around as the lead changes. Rating is constant during a
		// series, so this order never shifts; ties break by id for determinism.
		var ratingById = {};
		if (currentRoom && currentRoom.players) {
			for (var rp = 0; rp < currentRoom.players.length; rp++) {
				var pl = currentRoom.players[rp];
				ratingById[pl.id] = (typeof pl.rating === "number") ? pl.rating : 0;
			}
		}
		opponents.sort(function(a, b) {
			var ra = ratingById[a.id] || 0, rb = ratingById[b.id] || 0;
			if (rb !== ra) return rb - ra;
			return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
		});
	} else {
		// Other layouts (tournament thumbnails) show the current leaders, by live progress.
		opponents.sort(function(a, b) {
			if (a.finished !== b.finished) return a.finished ? -1 : 1;
			if (a.finished && b.finished) return (a.finishedAt || 0) - (b.finishedAt || 0);
			return (b.progress || 0) - (a.progress || 0);
		});
	}

	// The battle layouts show every opponent (duel = 1, 6-player = up to 5); other lobbies
	// (tournament) stay capped at the top 2 thumbnails — the scoreboard surfaces the rest.
	var oppShown = isMultiRacing() ? 5 : (isDuoRacing() ? 1 : 2);
	for (var i = 1; i <= 5; i++) {
		var nameEl = document.getElementById("player_name" + i);
		var canvasEl = document.getElementById("game" + i);
		var slot = slots[i - 1];
		var opp = i <= oppShown ? opponents[i - 1] : null;
		if (opp) {
			setHudName(nameEl, opp);
			drawBoardStatic(opp.state, canvasEl, opp.skin || "classic");
			if (slot) {
				slot.style.display = "";
				slot.dataset.pid = opp.id || "";
			}
		} else {
			setHudName(nameEl, null);
			clearCanvas(canvasEl);
			if (slot) {
				slot.style.display = "none";
				delete slot.dataset.pid;
			}
		}
	}

	renderScoreboard();
	if (isDuoRacing()) updateDuelHud(games[0], opponents[0]);
	else if (isMultiRacing()) updateMultiHud(games[0], opponents);
	if (isBattleRacing()) updateMultiPlacements(games); // finish-place stamps for both 1v1 + 6-player
	updateDangerWarning();
});

// danger warning moved to DangerWarning.js

var allViews = ["name_view", "lobby_view", "game_view", "learn_view", "leaderboard_view", "profile_view", "settings_view", "custom_view", "admin_view", "puzzles_view", "puzzles_list_view", "bots_view", "starting_positions_view", "patterns_view", "start_patterns_view", "combined_puzzles_view", "design_view", "territory_view", "puzzle_play_view", "ranked_picker_view", "puzzle_picker_view", "replay_view", "privacy_view", "terms_view"];
// Routing + view show/hide moved to Router.js.
// Profile view rendering moved to Profile.js.

function showGameView() {
	// Hide every other top-level view, not just name/lobby — entering a room from
	// the custom lobby (or any page) must replace it, not stack on top of it.
	hideAllViews();
	gameView.style.display = "";
	document.body.classList.add("in-game");
}

function showNameError(text) {
	nameError.textContent = text;
	nameError.style.display = "";
}

function showLobbyMessage(text) {
	lobbyMessage.textContent = text;
	lobbyMessage.style.display = "";
	setTimeout(function() {
		lobbyMessage.style.display = "none";
	}, 4000);
}

function resetGameUI() {
	readyButton.style.display = "";
	hideOverlay();
	clearFreeze();
	stopRoundTimer();
	resetBoardAnimations();
	lastScores = {};
	lastFinished = {};
	gameProgressText.textContent = "";
	roundTimer.textContent = "";
	for (var i = 0; i < 6; i++) {
		document.getElementById("player_name" + i).textContent = "";
		clearCanvas(document.getElementById("game" + i));
	}
	var slots = document.querySelectorAll('[data-slot]');
	for (var j = 0; j < slots.length; j++) slots[j].style.display = "none";
}

// overlay + countdown moved to Overlay.js
// round timer + freeze ticker moved to RoundTimer.js


// Render the live scoreboard. During a round, sorts by progress (finished
// first, then % cleared) and shows a progress bar. In planning phase, sorts
// by cumulative score and shows ready/waiting state.
// For larger lobbies (tournaments), applies a Trackmania-style top+gap+you
// pattern so it always shows the leaders and the player's neighbourhood.




// Touch press indicator: brightens the cell under the finger so taps feel
// acknowledged immediately, before the server confirms the action.




// Wrap a live-game state array into the BoardView interface drawCell expects.
