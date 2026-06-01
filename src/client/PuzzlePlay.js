// Rated puzzle play view.
//
// Loop: ask server for next puzzle near our rating → render via the Learn
// puzzle widget → on solve/fail emit `puzzle_attempt`, server replies with
// the Elo delta → show result panel with "Next" button. Server picks the
// puzzle and computes ratings — the client just renders and submits.

var puzzlePlayState = {
	current: null,        // server-returned puzzle data { id, rows, cols, mines, revealed }
	playerRating: null,
	streak: 0,
	waiting: false        // gate between submit and server reply so we don't double-submit
};

function renderPuzzlePlay() {
	var view = document.getElementById("puzzle_play_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Rated puzzles";
	view.appendChild(title);

	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Solve puzzles near your rating. Solve to gain rating, miss to lose some — the puzzle's rating moves too. The puzzle's rating is hidden until you finish.";
	view.appendChild(sub);

	if (!account) {
		var msg = document.createElement("p");
		msg.className = "puzzle-play-empty";
		msg.textContent = "Sign in to play rated puzzles — your rating is tied to your account.";
		view.appendChild(msg);
		return;
	}

	var header = document.createElement("div");
	header.className = "puzzle-play-header";
	header.id = "puzzle_play_header";
	view.appendChild(header);

	var board = document.createElement("div");
	board.id = "puzzle_play_board";
	board.className = "puzzle-play-board";
	view.appendChild(board);

	var result = document.createElement("div");
	result.id = "puzzle_play_result";
	result.className = "puzzle-play-result";
	result.style.display = "none";
	view.appendChild(result);

	renderPlayHeader();
	requestNextPuzzle();
}

function renderPlayHeader() {
	var header = document.getElementById("puzzle_play_header");
	if (!header) return;
	header.innerHTML = "";
	var rating = document.createElement("span");
	rating.className = "puzzle-play-rating";
	rating.textContent = "Your rating: " + (puzzlePlayState.playerRating != null ? puzzlePlayState.playerRating : "—");
	header.appendChild(rating);
	if (puzzlePlayState.streak > 0) {
		var streak = document.createElement("span");
		streak.className = "puzzle-play-streak";
		streak.textContent = "Streak: " + puzzlePlayState.streak;
		header.appendChild(streak);
	}
}

function requestNextPuzzle() {
	var result = document.getElementById("puzzle_play_result");
	if (result) result.style.display = "none";
	var board = document.getElementById("puzzle_play_board");
	if (board) {
		board.innerHTML = "";
		var loading = document.createElement("p");
		loading.className = "puzzle-play-loading";
		loading.textContent = "Finding a puzzle near your rating…";
		board.appendChild(loading);
	}
	socket.emit("puzzle_next");
}

function showPuzzlePlayBoard(puzzle) {
	puzzlePlayState.current = puzzle;
	puzzlePlayState.waiting = false;
	var board = document.getElementById("puzzle_play_board");
	if (!board) return;
	board.innerHTML = "";
	var pseudo = {
		title: "",
		rows: puzzle.rows,
		cols: puzzle.cols,
		mines: puzzle.mines,
		revealed: puzzle.revealed
	};
	board.appendChild(buildLearnPuzzle(pseudo, false,
		function() { submitPuzzleAttempt(true); },
		function() { submitPuzzleAttempt(false); }
	));
}

function submitPuzzleAttempt(solved) {
	if (puzzlePlayState.waiting || !puzzlePlayState.current) return;
	puzzlePlayState.waiting = true;
	socket.emit("puzzle_attempt", {
		puzzleId: puzzlePlayState.current.id,
		solved: solved
	});
}

function showPuzzleResult(result) {
	puzzlePlayState.waiting = false;
	puzzlePlayState.streak = result.solved ? puzzlePlayState.streak + 1 : 0;
	puzzlePlayState.playerRating = result.playerAfter;
	renderPlayHeader();

	if (account) {
		account.puzzleRating = result.playerAfter;
		account.puzzlesAttempted = (account.puzzlesAttempted || 0) + 1;
		if (result.solved) account.puzzlesSolved = (account.puzzlesSolved || 0) + 1;
		renderHomePuzzleCard();
	}

	var box = document.getElementById("puzzle_play_result");
	if (!box) return;
	box.style.display = "";
	box.innerHTML = "";
	box.classList.toggle("puzzle-play-result-ok", result.solved);
	box.classList.toggle("puzzle-play-result-fail", !result.solved);

	var headline = document.createElement("div");
	headline.className = "puzzle-play-result-headline";
	var delta = result.playerDelta;
	var deltaText = (delta > 0 ? "+" : "") + delta;
	headline.textContent = (result.solved ? "Solved · " : "Missed · ") + deltaText;
	box.appendChild(headline);

	var detail = document.createElement("p");
	detail.className = "puzzle-play-result-detail";
	detail.textContent =
		"Your rating: " + result.playerBefore + " → " + result.playerAfter +
		" · Puzzle rating: " + result.puzzleBefore + " → " + result.puzzleAfter;
	box.appendChild(detail);

	var actions = document.createElement("div");
	actions.className = "puzzle-play-result-actions";
	var next = document.createElement("button");
	next.className = "btn btn-primary";
	next.textContent = "Next puzzle";
	next.addEventListener("click", requestNextPuzzle);
	actions.appendChild(next);
	box.appendChild(actions);
}

function bindPuzzlePlaySocket() {
	socket.on("puzzle_next", function(data) {
		puzzlePlayState.playerRating = data.playerRating;
		renderPlayHeader();
		showPuzzlePlayBoard(data.puzzle);
	});
	socket.on("puzzle_result", function(data) {
		showPuzzleResult(data);
	});
	socket.on("puzzle_error", function(data) {
		puzzlePlayState.waiting = false;
		var board = document.getElementById("puzzle_play_board");
		if (!board) return;
		board.innerHTML = "";
		var p = document.createElement("p");
		p.className = "puzzle-play-empty";
		var reason = data && data.reason;
		if (reason === "auth_required") p.textContent = "Sign in to play rated puzzles.";
		else if (reason === "no_puzzles") p.textContent = "No puzzles available yet — head to the Lab to generate some.";
		else p.textContent = "Couldn't load a puzzle: " + reason;
		board.appendChild(p);
	});
}

function renderHomePuzzleCard() {
	if (typeof renderHomeRankChips === "function") renderHomeRankChips();
}
