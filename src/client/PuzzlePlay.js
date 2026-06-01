// Rated puzzle play view.
//
// Architecturally identical to Solo: ask the server for a puzzle, receive
// the obfuscated board, render it in the standard game view via the same
// canvas + Input.js stack. Every click goes to the server (left_click /
// right_click) — server validates against the real game state and decides
// outcome via game.win / game.mineHit. No client-trusted "I solved it".

var puzzleSession = null;  // { puzzleId, totalSafe, totalMines, playerRating, startedAt, finished, result }

// Show the puzzle play view: trigger a server-side pick. The server responds
// with `puzzle_board`, which routes us into the game view in puzzle chrome.
function renderPuzzlePlay() {
	var view = document.getElementById("puzzle_play_view");
	if (!view) return;
	view.innerHTML = "";
	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Rated puzzles";
	view.appendChild(title);

	if (!account) {
		var msg = document.createElement("p");
		msg.className = "puzzle-play-empty";
		msg.textContent = "Sign in to play rated puzzles — your rating is tied to your account.";
		view.appendChild(msg);
		return;
	}
	var loading = document.createElement("p");
	loading.className = "puzzle-play-empty";
	loading.textContent = "Finding a puzzle near your rating…";
	view.appendChild(loading);
	socket.emit("puzzle_next");
}

function exitPuzzle() {
	puzzleSession = null;
	togglePuzzleChrome(false);
	if (gameView) {
		gameView.classList.remove("puzzle");
	}
	hideOverlay();
	myState = null;
	prevPlayerState = null;
	boardDecoder = null;
	location.hash = "#/";
}

function togglePuzzleChrome(on) {
	var card = document.getElementById("puzzle_card");
	if (card) card.style.display = on ? "" : "none";
	if (allOpponentsDiv) allOpponentsDiv.style.display = on ? "none" : "";
	var scoreboardCard = document.getElementById("scoreboard_card");
	if (scoreboardCard) scoreboardCard.style.display = on ? "none" : "";
	if (seriesCard) seriesCard.style.display = on ? "none" : "";
	if (botsCard) botsCard.style.display = on ? "none" : "";
	var rankedTagEl = document.getElementById("ranked_tag");
	if (rankedTagEl) rankedTagEl.style.display = "none";
	var soloCard = document.getElementById("solo_card");
	if (soloCard) soloCard.style.display = "none";
}

function updatePuzzleHud() {
	if (!puzzleSession) return;
	var ratingEl = document.getElementById("puzzle_hud_rating");
	var solvedEl = document.getElementById("puzzle_hud_solved");
	var minesEl = document.getElementById("puzzle_hud_mines");
	if (ratingEl) ratingEl.textContent = puzzleSession.playerRating;
	if (solvedEl) {
		var total = puzzleSession.totalSafe;
		var revealed = 0;
		if (myState) for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
			if (myState[r][c] === KNOWN) revealed++;
		}
		solvedEl.textContent = revealed + " / " + total;
	}
	if (minesEl) {
		var flagged = 0;
		if (myState) for (var r2 = 0; r2 < rows; r2++) for (var c2 = 0; c2 < cols; c2++) {
			if (myState[r2][c2] === FLAGGED) flagged++;
		}
		minesEl.textContent = flagged + " / " + puzzleSession.totalMines;
	}
}

function showPuzzleOutcome(result) {
	var panel = document.createElement("div");
	panel.className = "result-panel";

	var header = document.createElement("div");
	header.className = "result-header";
	header.textContent = result.solved ? "Solved!" : "Mine hit";
	panel.appendChild(header);

	var delta = result.playerDelta;
	var deltaLine = document.createElement("div");
	deltaLine.className = "tournament-place";
	deltaLine.style.color = result.solved ? "#4ade80" : "#f87171";
	deltaLine.textContent = (delta > 0 ? "+" : "") + delta + " rating";
	panel.appendChild(deltaLine);

	var detail = document.createElement("div");
	detail.className = "result-foot";
	detail.textContent =
		"You: " + result.playerBefore + " → " + result.playerAfter +
		" · Puzzle: " + result.puzzleBefore + " → " + result.puzzleAfter;
	panel.appendChild(detail);

	var actions = document.createElement("div");
	actions.className = "result-actions";

	var next = document.createElement("button");
	next.className = "btn btn-primary";
	next.textContent = "Next puzzle";
	next.addEventListener("click", function() {
		hideOverlay();
		socket.emit("puzzle_next");
	});
	actions.appendChild(next);

	var back = document.createElement("button");
	back.className = "btn btn-secondary";
	back.textContent = "Back home";
	back.addEventListener("click", exitPuzzle);
	actions.appendChild(back);

	panel.appendChild(actions);
	presentPanel(panel, result.solved ? "win" : "lose");
}
