// Single-player puzzle play (rated / streak / storm / daily), extracted from
// minesweeperServer. Owns the run lifecycle, serving puzzles near the player's rating,
// building the game, the hint pointer, and finalising with the puzzle-Elo exchange.
// Self-contained on db + the generators/solver + gameUtil (obfuscateBoard). State
// (puzzlePlay / puzzleRun) lives in appState. The server delegates the puzzle_* socket
// events here, plus the puzzle branch of left_click/right_click and the disconnect cleanup.

var appState = require("./appState");
var db = require("./db");
var puzzleGen = require("./PuzzleGenerator");
var gameCreator = require("./GameCreator");
var cspSolver = require("./CSPSolver");
var BoardLogic = require("../common/BoardLogic");
var gameUtil = require("./gameUtil");

var puzzlePlay = appState.puzzlePlay, puzzleRun = appState.puzzleRun, accounts = appState.accounts;
var obfuscateBoard = gameUtil.obfuscateBoard;

// Streak / Storm tuning.
var RUN_START_RATING = 100;
var RUN_STEP = 60;
var STORM_DURATION_MS = 3 * 60 * 1000;
var STORM_MISS_PENALTY_MS = 10 * 1000;

function startPuzzleRun(socket, playerID, user, mode) {
	clearStormTimer(playerID);
	var run = {
		mode: mode,
		targetRating: RUN_START_RATING,
		solves: 0,
		startedAt: Date.now(),
		servedIds: []   // puzzles served this run, so we don't repeat within a run
	};
	if (mode === "storm") {
		run.endsAt = Date.now() + STORM_DURATION_MS;
		run.timerHandle = setTimeout(function() { endPuzzleRun(socket, playerID, "time"); }, STORM_DURATION_MS);
	}
	puzzleRun[playerID] = run;
	serveRunPuzzle(socket, playerID, user);
}

function serveRunPuzzle(socket, playerID, user) {
	var run = puzzleRun[playerID];
	if (!run) return;
	// Exclude every puzzle served so far in this run so a single
	// playthrough never repeats — pickPuzzleNearRating widens the
	// rating window and falls back to "any unseen" if nothing matches.
	var puzzle = db.pickPuzzleNearRating(run.targetRating, run.servedIds);
	if (!puzzle) {
		endPuzzleRun(socket, playerID, "no_puzzles");
		return;
	}
	run.servedIds.push(puzzle.id);
	delete puzzlePlay[playerID];
	startPuzzlePlay(socket, playerID, user, puzzle, run);
}

function clearStormTimer(playerID) {
	var run = puzzleRun[playerID];
	if (run && run.timerHandle) { clearTimeout(run.timerHandle); run.timerHandle = null; }
}

function endPuzzleRun(socket, playerID, reason) {
	var run = puzzleRun[playerID];
	if (!run) return;
	clearStormTimer(playerID);
	delete puzzleRun[playerID];
	// Drop the in-flight game state too — the run is over.
	delete puzzlePlay[playerID];
	var pp_pre = run;
	var finalScore = (run.mode === "streak") ? run.targetRating : run.solves;
	var acc = accounts[playerID];
	var userId = acc ? acc.userId : null;
	var bestBefore = 0;
	if (userId) {
		bestBefore = db.getRunBest(userId, run.mode);
		if (finalScore > bestBefore) db.setRunBest(userId, run.mode, finalScore);
	}
	socket.emit("puzzle_run_end", {
		mode: run.mode,
		reason: reason,
		solves: run.solves,
		score: finalScore,
		bestBefore: bestBefore,
		best: Math.max(finalScore, bestBefore)
	});
}

function startPuzzlePlay(socket, playerID, user, puzzle, run, opts) {
	opts = opts || {};
	// Build the full board: -1 (MINE sentinel) where the puzzle's mine list
	// says, otherwise a clue count.
	var board = puzzleGen.buildBoard(puzzle.rows, puzzle.cols, puzzle.mines);
	var template = {
		board: board,
		numMines: puzzle.mines.length,
		knownCells: puzzle.revealed.slice()
	};
	var game = gameCreator.createGame(puzzle.mines.length, puzzle.rows, puzzle.cols);
	game.playerName = user.name;
	game.init(template);
	game.playing = true;
	game.win = function() { finalizePuzzle(socket, playerID, true); };
	game.mineHit = function() { finalizePuzzle(socket, playerID, false); };

	puzzlePlay[playerID] = {
		mode: run ? run.mode : "rated",
		puzzleId: puzzle.id,
		userId: user.id,
		game: game,
		playerBefore: user.puzzle_rating,
		puzzleBefore: puzzle.rating,
		hintUsed: false,
		startedAt: Date.now(),
		noRating: !!opts.noRating
	};

	var obf = obfuscateBoard(board, puzzle.rows, puzzle.cols);
	socket.emit("puzzle_board", {
		mode: run ? run.mode : "rated",
		puzzleId: puzzle.id,
		rows: puzzle.rows,
		cols: puzzle.cols,
		mines: puzzle.mines.length,
		totalSafe: puzzle.rows * puzzle.cols - puzzle.mines.length,
		knownCells: puzzle.revealed,
		boardData: obf.data,
		boardMask: obf.mask,
		playerRating: user.puzzle_rating,
		solved: user.puzzles_solved,
		attempted: user.puzzles_attempted,
		noRating: !!opts.noRating,
		run: run ? Object.assign({
			mode: run.mode,
			targetRating: run.targetRating || null,
			solves: run.solves || 0,
			endsAt: run.endsAt || null
		}, run.date ? { date: run.date } : {}, typeof run.streak === "number" ? { streak: run.streak } : {}) : null
	});
}

// Find the deduction the player should look at next, via the CSP analyzer's findNextSafeStep — the same
// solver that rates puzzles and drives the Analyze modal, so the hint always matches what's deducible.
function findHintPointer(game) {
	var safe = cspSolver.findNextSafeStep(game.board, game.state, {});
	if (safe && safe.safeCells && safe.safeCells.length) {
		return {
			type: safe.kind,
			clueCells: safe.clueCells,
			coveredCells: safe.safeCells
		};
	}
	if (safe && safe.mineCells && safe.mineCells.length) {
		// Chain dead-ended at a forced-mine deduction (no downstream safe
		// reveal in the deducible chain). Still useful — the player has
		// to flag this before they can make progress.
		return {
			type: safe.kind,
			clueCells: safe.clueCells,
			coveredCells: safe.mineCells
		};
	}
	// Solver couldn't make progress (puzzle requires guessing or frontier
	// larger than ENUM_CAP). Fall back to pointing at the smallest covered
	// frontier so the player at least knows where the active area is.
	return findFrontierFallback(game);
}

// Last-resort hint when the solver can't make any deductive progress
// (frontier larger than ENUM_CAP, or the puzzle truly needs a guess).
// Points at the smallest covered frontier so the player at least knows
// where the active area is.
function findFrontierFallback(game) {
	var rows = game.rows, cols = game.cols;
	var board = game.board, state = game.state;
	var bestClue = null, bestSize = Infinity;
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (state[r][c] !== BoardLogic.KNOWN || board[r][c] <= 0) continue;
			var ctx = cspSolver.constraintAt(board, state, r, c);
			if (!ctx.covered.length) continue;
			if (ctx.covered.length < bestSize) {
				bestSize = ctx.covered.length;
				bestClue = { r: r, c: c, covered: ctx.covered };
			}
		}
	}
	if (bestClue) return { clueCells: [[bestClue.r, bestClue.c]], coveredCells: bestClue.covered, type: "frontier" };
	return null;
}

function finalizePuzzle(socket, playerID, solved) {
	var pp = puzzlePlay[playerID];
	if (!pp) return;
	pp.game.playing = false;

	// Daily mode: one attempt per UTC day, no Elo, streak counter is the
	// reward — record + emit a daily-specific result and stop.
	if (pp.mode === "daily") {
		delete puzzlePlay[playerID];
		var date = db.todayUtc();
		db.recordDailyAttempt(pp.userId, date, solved);
		var streak = db.dailyStreakForUser(pp.userId);
		socket.emit("puzzle_daily_result", {
			date: date,
			solved: solved,
			streak: streak,
			puzzleId: pp.puzzleId
		});
		return;
	}

	// Run modes (streak / storm): no Elo, advance the run instead.
	if (pp.mode === "streak" || pp.mode === "storm") {
		var run = puzzleRun[playerID];
		if (!run) { delete puzzlePlay[playerID]; return; }
		if (solved) {
			run.solves++;
			run.targetRating += RUN_STEP;
		} else if (pp.mode === "streak") {
			endPuzzleRun(socket, playerID, "fail");
			return;
		} else if (pp.mode === "storm") {
			// 10s penalty + reschedule the timer.
			if (run.endsAt) {
				run.endsAt -= STORM_MISS_PENALTY_MS;
				clearStormTimer(playerID);
				var remaining = run.endsAt - Date.now();
				if (remaining <= 0) { endPuzzleRun(socket, playerID, "time"); return; }
				run.timerHandle = setTimeout(function() { endPuzzleRun(socket, playerID, "time"); }, remaining);
			}
		}
		// Serve next.
		var u = db.getUserById(pp.userId);
		if (!u) { endPuzzleRun(socket, playerID, "auth"); return; }
		serveRunPuzzle(socket, playerID, u);
		return;
	}

	delete puzzlePlay[playerID];
	// Retry attempts (after a failure on the same puzzle) are practice — no
	// Elo exchange, no DB write. The original failure already moved the
	// rating; replaying for closure shouldn't be either rewarded or punished.
	if (pp.noRating) {
		socket.emit("puzzle_result", {
			puzzleId: pp.puzzleId,
			solved: solved,
			hintUsed: pp.hintUsed,
			noRating: true,
			playerBefore: pp.playerBefore,
			playerAfter: pp.playerBefore,
			playerDelta: 0,
			puzzleBefore: pp.puzzleBefore,
			puzzleAfter: pp.puzzleBefore
		});
		return;
	}
	// Hinted solves earn half the rating exchange — same Elo math with the
	// actual score set to 0.5 (a "draw" against the puzzle) instead of 1.
	// A hinted failure is still a full loss; hint affects only the win.
	var playerActual;
	if (solved) playerActual = pp.hintUsed ? 0.5 : 1;
	else playerActual = 0;
	var puzzleActual = 1 - playerActual;
	var playerAfter = db.eloUpdate(pp.playerBefore, pp.puzzleBefore, 20, playerActual);
	var puzzleAfter = db.eloUpdate(pp.puzzleBefore, pp.playerBefore, 10, puzzleActual);
	db.updateUserPuzzleRating(pp.userId, playerAfter, solved);
	db.updatePuzzleRating(pp.puzzleId, puzzleAfter, solved);
	db.setCurrentPuzzle(pp.userId, null);
	db.recordAttempt({
		userId: pp.userId, puzzleId: pp.puzzleId, solved: solved,
		playerBefore: pp.playerBefore, playerAfter: playerAfter,
		puzzleBefore: pp.puzzleBefore, puzzleAfter: puzzleAfter
	});
	socket.emit("puzzle_result", {
		puzzleId: pp.puzzleId,
		solved: solved,
		hintUsed: pp.hintUsed,
		playerBefore: pp.playerBefore,
		playerAfter: playerAfter,
		playerDelta: playerAfter - pp.playerBefore,
		puzzleBefore: pp.puzzleBefore,
		puzzleAfter: puzzleAfter
	});
}

// The puzzle branch of the server's left/right click handlers delegates here.
// Returns true if a puzzle is in play for this socket (so the server stops routing).
function handleLeftClick(playerID, data) {
	var pp = puzzlePlay[playerID];
	if (!pp) return false;
	if (pp.game.playing) pp.game.handleLeftClick(data.r, data.c);
	return true;
}
function handleRightClick(playerID, data) {
	var pp = puzzlePlay[playerID];
	if (!pp) return false;
	if (pp.game.playing) pp.game.handleRightClick(data.r, data.c);
	return true;
}
// Disconnect cleanup: end any active run (records best, session-only) + drop the in-flight game.
function cleanup(socket, playerID) {
	if (puzzleRun[playerID]) endPuzzleRun(socket, playerID, "disconnect");
	delete puzzlePlay[playerID];
}

// Register the puzzle_* socket events for a connected player.
function registerSocketHandlers(socket, playerID) {
	socket.on("puzzle_next", function() {
		var acc = accounts[playerID];
		if (!acc) { socket.emit("puzzle_error", { reason: "auth_required" }); return; }
		var u = db.getUserById(acc.userId);
		if (!u) { socket.emit("puzzle_error", { reason: "auth_required" }); return; }
		// Drop any in-memory game state from a prior connection — we'll
		// rebuild from the DB so resumption survives disconnects too.
		delete puzzlePlay[playerID];
		// Resume the user's in-progress puzzle if any. Leaving a puzzle (nav
		// away, disconnect, etc.) doesn't count as a loss — they get the same
		// board next time. Only a real solve or mine-hit completes it.
		var puzzle = null;
		if (u.current_puzzle_id) {
			puzzle = db.getPuzzleById(u.current_puzzle_id);
		}
		if (!puzzle) {
			var recent = db.recentlyAttemptedPuzzleIds(u.id);
			puzzle = db.pickPuzzleNearRating(u.puzzle_rating, recent);
			if (!puzzle) { socket.emit("puzzle_error", { reason: "no_puzzles" }); return; }
			db.setCurrentPuzzle(u.id, puzzle.id);
		}
		// puzzle_next is rated-mode only — cancel any active run before
		// starting a fresh rated attempt.
		if (puzzleRun[playerID]) {
			clearStormTimer(playerID);
			delete puzzleRun[playerID];
		}
		startPuzzlePlay(socket, playerID, u, puzzle, null);
	});

	function authedUserForPuzzle() {
		var acc = accounts[playerID];
		if (!acc) { socket.emit("puzzle_error", { reason: "auth_required" }); return null; }
		var u = db.getUserById(acc.userId);
		if (!u) { socket.emit("puzzle_error", { reason: "auth_required" }); return null; }
		return u;
	}

	// Practice replay of a puzzle the player just failed. Re-serves the same
	// board with noRating set — the rating exchange already happened when
	// the original attempt finalised, so the retry is purely for closure /
	// learning. Client tells us the puzzleId; we just verify it exists.
	socket.on("puzzle_retry", function(data) {
		var u = authedUserForPuzzle(); if (!u) return;
		var puzzleId = data && data.puzzleId;
		if (!puzzleId) { socket.emit("puzzle_error", { reason: "no_puzzle" }); return; }
		var puzzle = db.getPuzzleById(puzzleId);
		if (!puzzle) { socket.emit("puzzle_error", { reason: "no_puzzle" }); return; }
		delete puzzlePlay[playerID];
		if (puzzleRun[playerID]) {
			clearStormTimer(playerID);
			delete puzzleRun[playerID];
		}
		startPuzzlePlay(socket, playerID, u, puzzle, null, { noRating: true });
	});

	socket.on("puzzle_streak_start", function() {
		var u = authedUserForPuzzle(); if (!u) return;
		delete puzzlePlay[playerID];
		startPuzzleRun(socket, playerID, u, "streak");
	});

	socket.on("puzzle_storm_start", function() {
		var u = authedUserForPuzzle(); if (!u) return;
		delete puzzlePlay[playerID];
		startPuzzleRun(socket, playerID, u, "storm");
	});

	socket.on("puzzle_run_abandon", function() {
		if (puzzleRun[playerID]) endPuzzleRun(socket, playerID, "abandon");
	});

	socket.on("puzzle_daily_status", function() {
		var u = authedUserForPuzzle(); if (!u) return;
		var date = db.todayUtc();
		var puzzle = db.getOrPickDailyPuzzle(date);
		var attempt = db.getDailyAttempt(u.id, date);
		socket.emit("puzzle_daily_status", {
			date: date,
			puzzleId: puzzle ? puzzle.id : null,
			// Board data so the lobby can paint the daily preview. The
			// `revealed` set is the seed cascade only — no spoilers about
			// where mines are beyond what the player would see at start.
			board: puzzle ? {
				rows: puzzle.rows,
				cols: puzzle.cols,
				mines: puzzle.mines,
				revealed: puzzle.revealed,
				rating: puzzle.rating,
				difficulty: puzzle.difficulty
			} : null,
			attempt: attempt ? { solved: !!attempt.solved, at: attempt.attempted_at } : null,
			streak: db.dailyStreakForUser(u.id)
		});
	});

	socket.on("puzzle_daily_start", function() {
		var u = authedUserForPuzzle(); if (!u) return;
		var date = db.todayUtc();
		var attempt = db.getDailyAttempt(u.id, date);
		if (attempt) { socket.emit("puzzle_error", { reason: "daily_already_done" }); return; }
		var puzzle = db.getOrPickDailyPuzzle(date);
		if (!puzzle) { socket.emit("puzzle_error", { reason: "no_puzzles" }); return; }
		delete puzzlePlay[playerID];
		if (puzzleRun[playerID]) { clearStormTimer(playerID); delete puzzleRun[playerID]; }
		startPuzzlePlay(socket, playerID, u, puzzle, {
			mode: "daily",
			date: date,
			streak: db.dailyStreakForUser(u.id)
		});
	});

	// Hint points to the cell(s) where the next safe-reveal lives — it does
	// NOT reveal anything. The player still has to read the clue and make
	// the move. Re-usable: every press fetches a fresh hint from the current
	// state, so as the puzzle progresses, hints follow the new frontier.
	// The first hint per puzzle sets pp.hintUsed, which is read at
	// finalizePuzzle to halve the Elo gain on solve. Subsequent hints are
	// free — the penalty is already in effect.
	socket.on("puzzle_hint", function() {
		var pp = puzzlePlay[playerID];
		if (!pp || !pp.game.playing) return;
		var hint = findHintPointer(pp.game);
		if (!hint) return;
		pp.hintUsed = true;
		socket.emit("puzzle_hint_pointer", hint);
	});
}

module.exports = {
	registerSocketHandlers: registerSocketHandlers,
	handleLeftClick: handleLeftClick,
	handleRightClick: handleRightClick,
	cleanup: cleanup
};
