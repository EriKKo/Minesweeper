var http = require("http")
  , path = require("path")
  , crypto = require("node:crypto")
  , gameCreator = require("./GameCreator")
  , noGuess = require("./NoGuessGenerator")
  , puzzleGen = require("./PuzzleGenerator")
  , roomCreator = require("./RoomCreator")
  , territoryGen = require("./TerritoryGenerator")
  , territoryGame = require("./TerritoryGame")
  , botPlayer = require("./BotPlayer")
  , db = require("./db")
  , BoardLogic = require("../common/BoardLogic")
  , cspSolver = require("./CSPSolver")
  , oauth = require("./oauth")
  , puzzleApi = require("./puzzleApi")
  , staticServer = require("./staticServer")
  , appState = require("./appState")
  , territory = require("./territory")
  , ranked = require("./ranked")
  , elo = require("./elo")
  , botMgr = require("./bots");

// Load a local .env if present (no-op in production, where env vars are set directly).
try { process.loadEnvFile(); } catch (e) { /* no .env file — fine */ }

// Pack the full board into a XOR-masked byte blob the client can decode lazily
// from inside a closure. This isn't real anti-cheat — anyone with the JS console
// can call the decoder for every cell — but it does mean the over-the-wire bytes
// aren't a trivially-readable JSON board, and `window.myBoard` doesn't exist.
function obfuscateBoard(board, rows, cols) {
	var bytes = Buffer.alloc(rows * cols);
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			bytes[r * cols + c] = board[r][c] === -1 ? 9 : board[r][c];
		}
	}
	var mask = crypto.randomBytes(256);
	for (var j = 0; j < bytes.length; j++) bytes[j] = bytes[j] ^ mask[j % mask.length];
	return { data: bytes.toString("base64"), mask: mask.toString("base64") };
}

// Game objects carry the full board (mines + numbers) — we don't ship that in
// per-tick broadcasts anymore, since the client received the obfuscated board
// once at game start and renders from it.
function gameForBroadcast(g, pid) {
	if (!g) return null;
	var safeCount = g.revealedSafeCount ? g.revealedSafeCount() : 0;
	var totalSafe = g.totalSafeSquares || 0;
	return {
		id: pid,
		playerName: g.playerName,
		state: g.state,
		finished: g.finished,
		finishedAt: g.finishedAt,
		safeCount: safeCount,
		totalSafe: totalSafe,
		progress: totalSafe > 0 ? safeCount / totalSafe : 0,
		frozenUntil: g.frozenUntil,
		playing: g.playing
	};
}

var COUNT_DOWN_TIME = 3;
var BETWEEN_GAMES_DELAY = 3000;
// Tournament rounds run the elimination sequence (scrim → reorder → cut flashes
// → survivor pulse → fade) over the same gap. The reveal lives in roughly
// 3.6s, so we stretch the between-round delay to give players a beat to read
// the survivor badge before the next countdown starts.
var BETWEEN_GAMES_DELAY_TOURNAMENT_CUT = 4500;
var SERIES_END_DELAY = 6000;
var PROVISIONAL_GAMES = 5;

var PORT = process.env.PORT || 1337;
// OAuth provider login + config lives in oauth.js; the server delegates /auth/*
// routes to it and reads oauth.DEV_AUTH / oauth.providerFlags() where needed.

var app = http.createServer(handler);
var io = require("socket.io")(app);
appState.io = io; // share the socket.io server with the handler modules
// Wire the territory module with the core helpers it needs (breaks the circular require).
territory.init({
	io: io,
	COUNT_DOWN_TIME: COUNT_DOWN_TIME,
	obfuscateBoard: obfuscateBoard,
	isBot: isBot,
	clearRoundTimer: clearRoundTimer,
	applyRankedElo: elo.applyRankedElo,
	broadcastRoomState: broadcastRoomState,
	broadcastRoomList: broadcastRoomList
});

// The HTTP handler is a pure router: provider auth, then the /api admin surface,
// then static client assets (each module early-returns if it owns the path).
function handler (req, res) {
	var url = new URL(req.url, oauth.OAUTH_BASE);
	if (oauth.handleAuthRoute(req, res, url)) return;
	if (puzzleApi.handleApiRoute(req, res, url)) return;
	staticServer.serve(res, url.pathname);
}


// Puzzles live in SQLite (see db.js). The Lab GETs them via /api/puzzles;
// POST /api/puzzles kicks off a background generation job that inserts new
// puzzles into the DB in setImmediate chunks. The job runs against the
// canonical-key UNIQUE constraint so duplicates are silently dropped at
// the DB layer.

// Active puzzle plays. Keyed by playerID — one in-flight puzzle per socket.
// Each entry holds the puzzle row, the gameCreator-built game (the
// authoritative state), and (for rated mode) the user's pre-attempt rating
// so the Elo update at the end is symmetric.
//
// pp.runMode is set for streak/storm modes: when the player solves or
// misses, finalizePuzzle hands off to the run controller below instead of
// applying Elo. The run advances the target rating, picks the next puzzle,
// and reuses startPuzzlePlay to set up another game on the same socket.
var puzzlePlay = appState.puzzlePlay;
var puzzleRun = appState.puzzleRun;   // playerID -> { mode, targetRating, solves, startedAt, endsAt, timerHandle }

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


var games = appState.games;
var roomMapping = appState.roomMapping;
var rooms = appState.rooms;
var nextRoomId = 1;
var sockets = appState.sockets;
var names = appState.names;
var accounts = appState.accounts; // socketId -> { userId, token } for signed-in players
var nextGameTimers = appState.nextGameTimers;
var roundTimers = appState.roundTimers;
var roundDeadlines = appState.roundDeadlines;
var roundStarts = appState.roundStarts; // roomId -> ms timestamp when the current round's play began
var bots = appState.bots; // botId -> true
// Ranked filler bots are drawn from a pre-benchmarked pool (scripts/generate-bot-pool.js).
// Load it once at boot; if it's absent pickBotFromPool returns null and addBotToRoom
// degrades to a casual-preset bot, so a seat is always fillable.
var BOT_POOL_PATH = process.env.BOT_POOL_PATH || path.join(__dirname, "..", "..", "bots-pool.json");
console.log("Loaded " + botPlayer.loadPool(BOT_POOL_PATH) + " ranked bots from pool (" + BOT_POOL_PATH + ")");
var botDifficulty = appState.botDifficulty; // botId -> "easy" | "medium" | "hard" (casual rooms)
var botSpeedMs = appState.botSpeedMs; // botId -> flat per-move pace (ms)
var botDifficultyMs = appState.botDifficultyMs; // botId -> ms of thinking per unit of move difficulty
var botDistanceMult = appState.botDistanceMult; // botId -> multiplier on the mouse-travel term
var botMaxDifficulty = appState.botMaxDifficulty; // botId -> hardest move (CSP difficulty) the bot can deduce
var botRating = appState.botRating; // botId -> Elo used for ranked rating math
var botMistake = appState.botMistake; // botId -> blunder rate (re-applied to the game each round)
var botChord = appState.botChord; // botId -> chord rate (re-applied to the game each round)
var botTickHandles = appState.botTickHandles; // botId -> setTimeout handle
var botLastClick = appState.botLastClick; // botId -> {r, c} of the bot's most recent click in the current round
var nextBotId = 1;
var MAX_BOTS_PER_ROOM = 15;

// Ranked matchmaking — five modes split across two playstyles.
//   sprint_*   → cascade-y races, 10% mines, fewer forced deductions.
//   standard_* → dense boards (20%), favouring deduction over click speed.
//   tournament → keeps the original 15% as the marquee event.
var RANKED_RULES = { gameCount: 1, roundSeconds: 120, deathPenalty: 5 };
var RANKED_BOT_RATING = 1000;

// The Elo math lives in elo.js; give it the bot predicate + rating constants.
elo.init({ isBot: isBot, RANKED_BOT_RATING: RANKED_BOT_RATING, PROVISIONAL_GAMES: PROVISIONAL_GAMES });

// Racing-bot orchestration lives in botMgr.js; give it the game-loop services + shared predicates.
botMgr.init({
	isBot: isBot, botCount: botCount, getRoomBotNames: getRoomBotNames,
	updateDraw: updateDraw, createPlayerGame: createPlayerGame,
	newBotId: function() { return nextBotId++; },
	RANKED_BOT_RATING: RANKED_BOT_RATING, MAX_BOTS_PER_ROOM: MAX_BOTS_PER_ROOM
});

// Wire the ranked module with the core services it needs (breaks the circular require).
// Placed after the consts above so they're assigned; the injected fns are hoisted declarations.
ranked.init({
	io: io,
	RANKED_RULES: RANKED_RULES,
	MAX_BOTS_PER_ROOM: MAX_BOTS_PER_ROOM,
	PROVISIONAL_GAMES: PROVISIONAL_GAMES,
	newRoomId: function() { return nextRoomId++; },
	readUserRating: elo.readUserRating,
	createPlayerGame: createPlayerGame,
	addBotToRoom: botMgr.addBotToRoom,
	botCount: botCount,
	broadcastRoomState: broadcastRoomState,
	startSeries: startSeries
});
// Per-mode queue state: humans searching, pre-generated bots, and the trickle timer.
var rankedQueues = appState.rankedQueues;
var pendingBotsLists = appState.pendingBotsLists;
var rankedFillTimers = appState.rankedFillTimers;
var rankedQueueMode = appState.rankedQueueMode; // playerID -> mode key

function isBot(playerID) {
	return !!bots[playerID];
}

function roomSummary(room) {
	return {
		id: room.id,
		ownerName: names[room.owner] || "Anonymous",
		playerCount: room.players.length,
		humanCount: room.players.filter(function(pid) { return !isBot(pid); }).length,
		maxPlayers: room.maxPlayers,
		phase: room.phase,
		gameMode: room.gameMode || "race",
		gameCount: room.gameCount,
		gamesPlayed: room.gamesPlayed,
		roundSeconds: room.roundSeconds,
		deathPenalty: room.deathPenalty,
		players: room.players.map(function(pid) { return names[pid] || "Anonymous"; })
	};
}

function getRoomList() {
	return Object.keys(rooms)
		.filter(function(id) { return !rooms[id].ranked; })
		.map(function(id) { return roomSummary(rooms[id]); });
}

function broadcastRoomList() {
	io.to("lobby").emit("room_list", { rooms: getRoomList() });
}

function buildRoomState(room) {
	return {
		id: room.id,
		owner: room.owner,
		ranked: !!room.ranked,
		rankedMode: room.rankedMode || null,
		gameMode: room.gameMode || "race",
		phase: room.phase,
		gameCount: room.gameCount,
		gamesPlayed: room.gamesPlayed,
		scoreTarget: room.scoreTarget || null,
		tournamentSchedule: room.tournamentSchedule || null,
		roundSeconds: room.roundSeconds,
		deathPenalty: room.deathPenalty,
		mineDensity: room.mineDensity,
		boardSize: room.boardSize,
		rows: room.rows,
		cols: room.cols,
		roundDeadline: roundDeadlines[room.id] || null,
		lastGameWinner: room.lastGameWinner,
		lastGameWinnerName: room.lastGameWinner ? names[room.lastGameWinner] : null,
		seriesWinner: room.seriesWinner,
		seriesWinnerName: room.seriesWinner ? names[room.seriesWinner] : null,
		gameCountOptions: room.gameCountOptions,
		roundSecondsOptions: room.roundSecondsOptions,
		deathPenaltyOptions: room.deathPenaltyOptions,
		mineDensityOptions: room.mineDensityOptions,
		boardSizeOptions: room.boardSizeOptions,
		botDifficultyOptions: botPlayer.DIFFICULTIES,
		botCount: room.players.filter(function(pid) { return isBot(pid); }).length,
		maxBots: MAX_BOTS_PER_ROOM,
		players: room.players.map(function(pid) {
			var g = games[pid];
			var bot = isBot(pid);
			var rating = bot ? (botRating[pid] || RANKED_BOT_RATING)
				: (accounts[pid] ? accounts[pid].rating : null);
			var provisional = bot ? false
				: (accounts[pid] ? accounts[pid].played < PROVISIONAL_GAMES : false);
			return {
				id: pid,
				name: names[pid] || "Anonymous",
				ready: room.isReady(pid),
				score: room.scores[pid] || 0,
				isOwner: pid === room.owner,
				isBot: bot,
				difficulty: bot ? (botDifficulty[pid] || null) : null,
				rating: rating,
				provisional: provisional,
				finished: g ? !!g.finished : false
			};
		})
	};
}

function broadcastRoomState(room) {
	io.to("room:" + room.id).emit("room_state", buildRoomState(room));
}

function clearRoundTimer(roomId) {
	if (roundTimers[roomId]) {
		clearTimeout(roundTimers[roomId]);
		delete roundTimers[roomId];
	}
	delete roundDeadlines[roomId];
}


function humanCount(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		if (!isBot(room.players[i])) n++;
	}
	return n;
}

function botCount(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		if (isBot(room.players[i])) n++;
	}
	return n;
}

function getRoomBotNames(room) {
	var ret = [];
	for (var i = 0; i < room.players.length; i++) {
		if (isBot(room.players[i])) ret.push(names[room.players[i]] || "");
	}
	return ret;
}


function deleteRoomIfEmpty(room) {
	if (room.players.length === 0) {
		if (nextGameTimers[room.id]) {
			clearTimeout(nextGameTimers[room.id]);
			delete nextGameTimers[room.id];
		}
		clearRoundTimer(room.id);
		delete roundStarts[room.id];
		delete rooms[room.id];
		return true;
	}
	return false;
}

function countActivePlayers(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		var g = games[room.players[i]];
		if (g && !g.finished) n++;
	}
	return n;
}

function countFinishedPlayers(room) {
	var n = 0;
	for (var i = 0; i < room.players.length; i++) {
		var g = games[room.players[i]];
		if (g && g.finished) n++;
	}
	return n;
}

function getGamesWithPlayerOnTop(playerID, players) {
	var g = [];
	g.push(games[playerID]);
	for (var i = 0; i < players.length; i++) {
		if (players[i] != playerID) {
			g.push(games[players[i]]);
		}
	}
	return g;
}

function updateDraw(room) {
	for (var i = 0; i < room.players.length; i++) {
		var playerID = room.players[i];
		if (sockets[playerID]) {
			// Carry the ids in the broadcast so the client can key live progress
			// per player instead of relying on positional matching.
			var orderedIds = [playerID];
			for (var k = 0; k < room.players.length; k++) {
				if (room.players[k] !== playerID) orderedIds.push(room.players[k]);
			}
			var stripped = orderedIds.map(function(pid) { return gameForBroadcast(games[pid], pid); });
			sockets[playerID].emit("draw_board", {games: stripped});
		}
	}
	// Tournament spectators: players who were cut earlier in this match
	// still want to watch the bracket play out. Send them a frame where
	// slot 0 is intentionally empty (they no longer have a "me" board)
	// and slots 1+ carry the surviving players' games.
	if (room.tournamentEliminated) {
		var elimIds = Object.keys(room.tournamentEliminated);
		if (elimIds.length) {
			var spectatorGames = [null];
			for (var sp = 0; sp < room.players.length; sp++) {
				spectatorGames.push(gameForBroadcast(games[room.players[sp]], room.players[sp]));
			}
			for (var e = 0; e < elimIds.length; e++) {
				var elimSock = sockets[elimIds[e]];
				if (elimSock) elimSock.emit("draw_board", { games: spectatorGames });
			}
		}
	}
}

function computeSeriesWinner(room) {
	var best = -1;
	var leaders = [];
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		var s = room.scores[pid] || 0;
		if (s > best) {
			best = s;
			leaders = [pid];
		} else if (s === best) {
			leaders.push(pid);
		}
	}
	if (leaders.length === 1 && best > 0) return leaders[0];
	return null; // tie or no winner
}

// Rank players for the round. Finishers (those who cleared their board) always
// outrank non-finishers; among finishers, earlier finishedAt is better; among
// non-finishers, higher safeCount is better. Standard competition ranking on
// ties — equally-ranked players share the higher rank and the next rank skips.
// Points are N, N-1, ... down to 1 by rank.
function rankCompare(a, b) {
	if (a.finished !== b.finished) return a.finished ? 1 : -1;
	if (a.finished) {
		if (a.finishedAt !== b.finishedAt) return a.finishedAt < b.finishedAt ? 1 : -1;
		return 0;
	}
	if (a.safeCount !== b.safeCount) return a.safeCount > b.safeCount ? 1 : -1;
	return 0;
}

function buildStandings(room) {
	var N = room.players.length;
	var roundStart = roundStarts[room.id] || 0;
	var entries = room.players.map(function(pid) {
		var g = games[pid];
		var finished = g ? !!g.finished : false;
		var finishedAt = g ? (g.finishedAt || 0) : 0;
		var bot = isBot(pid);
		var rating = bot ? (botRating[pid] || RANKED_BOT_RATING) : (accounts[pid] ? accounts[pid].rating : null);
		var provisional = bot ? false : (accounts[pid] ? accounts[pid].played < PROVISIONAL_GAMES : false);
		return {
			id: pid,
			name: names[pid] || "Anonymous",
			safeCount: g ? g.revealedSafeCount() : 0,
			finished: finished,
			finishedAt: finishedAt,
			finishMs: (finished && roundStart && finishedAt) ? (finishedAt - roundStart) : null,
			rating: rating,
			provisional: provisional
		};
	});
	for (var i = 0; i < entries.length; i++) {
		var strictlyHigher = 0;
		for (var j = 0; j < entries.length; j++) {
			if (i === j) continue;
			if (rankCompare(entries[j], entries[i]) > 0) strictlyHigher++;
		}
		entries[i].rank = strictlyHigher + 1;
		entries[i].points = N - strictlyHigher;
	}
	entries.sort(function(a, b) { return a.rank - b.rank; });
	return entries;
}


function endIndividualGame(room, reason) {
	if (room.phase !== "playing") return;
	clearRoundTimer(room.id);
	botMgr.clearRoomBotTicks(room);
	for (var i = 0; i < room.players.length; i++) {
		if (games[room.players[i]]) games[room.players[i]].playing = false;
	}
	var standings = buildStandings(room);
	// Round winner = unique top-ranked player, if any.
	var winnerID = null;
	if (standings.length > 0 && standings[0].rank === 1) {
		var tiedAtTop = 0;
		for (var k = 0; k < standings.length; k++) if (standings[k].rank === 1) tiedAtTop++;
		if (tiedAtTop === 1) winnerID = standings[0].id;
	}
	room.recordRoundResult(standings, winnerID);

	// Tournament elimination: top N from this round's standings advance, the
	// rest get a fixed final place (ranks below the survivor cut) and are
	// removed from the room. Their final tournament place is just their rank
	// in the standings of the round they were eliminated in.
	var tournamentSurvivors = null;
	var eliminatedThisRound = null;
	if (room.ranked && room.rankedMode === "tournament" && room.tournamentSchedule) {
		var roundIdx = room.gamesPlayed - 1;
		var survivorsTarget = room.tournamentSchedule[roundIdx] || 1;
		eliminatedThisRound = [];
		// Walk highest rank → lowest so each .deletePlayer doesn't shift indices we care about.
		if (!room.tournamentElo) room.tournamentElo = {};
		for (var ei = standings.length - 1; ei >= survivorsTarget; ei--) {
			var sCut = standings[ei];
			var place = ei + 1;
			room.tournamentEliminated[sCut.id] = { round: room.gamesPlayed, place: place };
			eliminatedThisRound.push({ id: sCut.id, name: names[sCut.id] || sCut.name, place: place });
			// Apply this player's Elo immediately against the current snapshot —
			// survivors are pinned at rank 1 (they outranked this player) and the
			// already-eliminated keep their fixed places, so the pairwise math
			// gives them their real final delta right now.
			var eloInfo = elo.applyEloForPlayer(sCut.id, elo.tournamentEloParts(room, sCut.id, place), room.rankedStyle || "tournament");
			if (eloInfo) room.tournamentElo[sCut.id] = eloInfo;
			if (sockets[sCut.id]) {
				sockets[sCut.id].emit("tournament_eliminated", {
					round: room.gamesPlayed,
					totalRounds: room.tournamentSchedule.length,
					place: place,
					totalParticipants: room.tournamentParticipants.length,
					ratingDelta: eloInfo ? eloInfo.delta : null,
					rating: eloInfo ? eloInfo.newRating : null,
					provisional: eloInfo ? eloInfo.provisional : null
				});
			}
			if (isBot(sCut.id)) botMgr.clearBotTick(sCut.id);
			room.deletePlayer(sCut.id);
		}
		tournamentSurvivors = room.players.length;
	}

	// Pass the survivor cut so the client can draw the cutline divider on the
	// round-end overlay. null for non-tournament rounds (no cut to render).
	var roundSurvivorsTarget = null;
	if (room.ranked && room.rankedMode === "tournament" && room.tournamentSchedule) {
		var rIdx = room.gamesPlayed - 1;
		roundSurvivorsTarget = room.tournamentSchedule[rIdx] || null;
	}
	// Ranked Elo is computed once at series end — see endSeries — so the rating
	// shown to the player only moves when the whole match finishes.
	io.to("room:" + room.id).emit("game_result", {
		winnerId: winnerID,
		winnerName: winnerID ? names[winnerID] : null,
		gameNumber: room.gamesPlayed,
		gameCount: room.gameCount,
		scoreTarget: room.scoreTarget || null,
		tournamentRemaining: tournamentSurvivors,
		tournamentEliminated: eliminatedThisRound,
		tournamentSurvivorsTarget: roundSurvivorsTarget,
		tournamentSchedule: room.tournamentSchedule || null,
		reason: reason || "cleared",
		standings: standings
	});
	broadcastRoomState(room);

	var seriesOver;
	if (tournamentSurvivors !== null) {
		seriesOver = tournamentSurvivors <= 1;
	} else if (room.scoreTarget) {
		seriesOver = Object.keys(room.scores).some(function(pid) { return (room.scores[pid] || 0) >= room.scoreTarget; });
	} else {
		seriesOver = room.gamesPlayed >= room.gameCount;
	}
	if (seriesOver) {
		endSeries(room);
	} else {
		var hadCut = eliminatedThisRound && eliminatedThisRound.length > 0;
		var nextDelay = hadCut ? BETWEEN_GAMES_DELAY_TOURNAMENT_CUT : BETWEEN_GAMES_DELAY;
		nextGameTimers[room.id] = setTimeout(function() {
			delete nextGameTimers[room.id];
			if (rooms[room.id] && room.phase === "playing" && room.players.length > 1) {
				startGame(room);
			} else if (rooms[room.id] && room.players.length <= 1) {
				endSeries(room);
			}
		}, nextDelay);
	}
}

function handleRoundTimeUp(room) {
	delete roundTimers[room.id];
	if (room.phase !== "playing") return;
	endIndividualGame(room, "timeout");
}

function reduceRoundDeadline(room, targetSeconds) {
	var newDeadline = Date.now() + targetSeconds * 1000;
	if (roundDeadlines[room.id] && roundDeadlines[room.id] <= newDeadline) return;
	roundDeadlines[room.id] = newDeadline;
	if (roundTimers[room.id]) clearTimeout(roundTimers[room.id]);
	roundTimers[room.id] = setTimeout(function() {
		handleRoundTimeUp(room);
	}, targetSeconds * 1000);
}

// Rank players for series-end purposes: highest cumulative score wins, ties share
// a rank. Mirrors the per-round ranking logic but reads from room.scores.
function buildSeriesStandings(room) {
	var N = room.players.length;
	var entries = room.players.map(function(pid) {
		return { id: pid, name: names[pid] || "Anonymous", score: room.scores[pid] || 0 };
	});
	for (var i = 0; i < entries.length; i++) {
		var strictlyHigher = 0;
		for (var j = 0; j < entries.length; j++) {
			if (i !== j && entries[j].score > entries[i].score) strictlyHigher++;
		}
		entries[i].rank = strictlyHigher + 1;
		entries[i].points = N - strictlyHigher;
	}
	entries.sort(function(a, b) { return a.rank - b.rank; });
	return entries;
}

// Tournament final standings: each participant's rank is their tournament-
// elimination place (1 = winner, last = first eliminated). Eliminated players'
// rating deltas were applied at elimination time and stored in room.tournamentElo
// — pull them through so the final panel can show each row's delta.
function buildTournamentStandings(room) {
	var N = room.tournamentParticipants.length;
	var entries = room.tournamentParticipants.map(function(pid) {
		var elim = room.tournamentEliminated[pid];
		var rank = elim ? elim.place : 1;
		var entry = {
			id: pid,
			name: names[pid] || "Anonymous",
			score: 0,
			rank: rank,
			points: N - rank + 1,
			eliminatedRound: elim ? elim.round : null
		};
		var eloInfo = (room.tournamentElo || {})[pid];
		if (eloInfo) {
			entry.ratingDelta = eloInfo.delta;
			entry.rating = eloInfo.newRating;
			entry.provisional = eloInfo.provisional;
		} else if (!isBot(pid)) {
			// No stored Elo yet (likely the winner) — fall back to the persisted rating.
			var acc = accounts[pid];
			var u = acc ? db.getUserById(acc.userId) : null;
			if (u) { entry.rating = u.rating; entry.provisional = u.played < PROVISIONAL_GAMES; }
		}
		return entry;
	});
	entries.sort(function(a, b) { return a.rank - b.rank; });
	return entries;
}

function endSeries(room) {
	if (nextGameTimers[room.id]) {
		clearTimeout(nextGameTimers[room.id]);
		delete nextGameTimers[room.id];
	}
	room.seriesWinner = computeSeriesWinner(room);
	room.phase = "planning";
	// Apply Elo once at series end based on cumulative scoring. Mutates the
	// standings entries with ratingDelta / rating / provisional so the client can
	// show the bump on the series_ended panel.
	var seriesStandings;
	if (room.rankedMode === "tournament") {
		// Apply Elo for the winner (the lone survivor) against the now-complete
		// standings. The eliminated players already had theirs applied as they
		// were cut, so they're skipped here.
		var winnerPid = room.players[0];
		if (winnerPid) {
			if (!room.tournamentElo) room.tournamentElo = {};
			var winnerInfo = elo.applyEloForPlayer(winnerPid, elo.tournamentEloParts(room, winnerPid, 1), room.rankedStyle || "tournament");
			if (winnerInfo) room.tournamentElo[winnerPid] = winnerInfo;
		}
		seriesStandings = buildTournamentStandings(room);
		room.seriesWinner = seriesStandings[0] ? seriesStandings[0].id : null;
	} else {
		seriesStandings = buildSeriesStandings(room);
		if (room.ranked) elo.applyRankedElo(seriesStandings, room.rankedStyle);
	}
	io.to("room:" + room.id).emit("series_ended", {
		winnerId: room.seriesWinner,
		winnerName: room.seriesWinner ? names[room.seriesWinner] : null,
		ranked: !!room.ranked,
		mode: room.rankedMode || null,
		standings: seriesStandings,
		scores: seriesStandings.map(function(s) {
			return { id: s.id, name: s.name, score: s.score };
		})
	});
	broadcastRoomState(room);
	broadcastRoomList();

	// Ranked rooms are single-match: don't auto-reset bots or scores. The client
	// shows "Play another" (re-queues) and "Back to menu" (leaves the room).
	if (room.ranked) return;

	setTimeout(function() {
		if (!rooms[room.id]) return;
		room.resetScores();
		room.resetReady();
		botMgr.readyAllBots(room);
		broadcastRoomState(room);
	}, SERIES_END_DELAY);
}

function gameWin(playerID) {
	var room = roomMapping[playerID];
	if (!room || room.phase !== "playing") return;
	var game = games[playerID];
	if (!game || !game.playing || game.finished) return;

	game.finished = true;
	game.finishedAt = Date.now();
	game.playing = false;

	// First finish in this round? Pull the remaining time down to 10s — anyone
	// still working gets one last sprint before the round closes.
	if (countFinishedPlayers(room) === 1) {
		reduceRoundDeadline(room, 10);
	}

	if (isBot(playerID)) {
		botMgr.clearBotTick(playerID);
	}

	updateDraw(room);
	broadcastRoomState(room);

	// As soon as only one (or zero) players are still active, end the round.
	// The 20s timer reduction above still applies as a safety for the case where
	// the last active player(s) don't finish in time.
	if (countActivePlayers(room) <= 1) {
		endIndividualGame(room, "cleared");
	}
}

function gameMineHit(playerID) {
	var room = roomMapping[playerID];
	if (!room || room.phase !== "playing") return;
	var game = games[playerID];
	if (!game) return;
	var penaltyMs = room.deathPenalty * 1000;
	game.frozenUntil = Date.now() + penaltyMs;
	if (sockets[playerID]) {
		sockets[playerID].emit("mine_hit", { frozenUntil: game.frozenUntil, penaltySeconds: room.deathPenalty });
	}
}

function startGame(room) {
	if (room.gameMode === "territory") return territory.startGame(room);
	clearRoundTimer(room.id);
	var mines = Math.round(room.mineDensity * room.rows * room.cols);
	var centerR = Math.floor(room.rows / 2);
	var centerC = Math.floor(room.cols / 2);
	var template = noGuess.createNoGuessTemplate(centerR, centerC, mines, undefined, room.rows, room.cols);
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		// Recreate each game at the room's dimensions so a mid-lobby size change applies.
		games[pid] = createPlayerGame(pid, room.rows, room.cols);
		if (isBot(pid)) {
			botMgr.applyBotConfigToGame(pid);
			// The board's per-cell difficulty map (computed once at generation) drives
			// each bot's pacing and its max-difficulty skill gate.
			games[pid].botDifficultyByCell = template.difficultyByCell || null;
		}
		games[pid].init(template);
	}
	// For tournament rounds, compute how many will be cut this round so the
	// client can show a "X to be eliminated" banner during the countdown.
	// schedule[i] is the survivor target after round (i+1), so for the round
	// about to start (gamesPlayed+1) we look up schedule[gamesPlayed].
	var tournamentCutThisRound = null;
	var tournamentSurvivorsThisRound = null;
	if (room.ranked && room.rankedMode === "tournament" && room.tournamentSchedule) {
		var thisRoundSurvivors = room.tournamentSchedule[room.gamesPlayed];
		if (typeof thisRoundSurvivors === "number") {
			tournamentSurvivorsThisRound = thisRoundSurvivors;
			tournamentCutThisRound = Math.max(0, room.players.length - thisRoundSurvivors);
		}
	}
	// Players share one shared no-guess map this round — obfuscate it once and
	// hand the same blob to every client so reveals can be resolved locally.
	var obf = obfuscateBoard(template.board, room.rows, room.cols);
	function startPayload(forSpectator) {
		return {
			time: COUNT_DOWN_TIME,
			gameNumber: room.gamesPlayed + 1,
			gameCount: room.gameCount,
			roundSeconds: room.roundSeconds,
			deathPenalty: room.deathPenalty,
			rows: room.rows,
			cols: room.cols,
			boardData: obf.data,
			boardMask: obf.mask,
			tournamentCutThisRound: tournamentCutThisRound,
			tournamentSurvivorsThisRound: tournamentSurvivorsThisRound,
			spectator: !!forSpectator
		};
	}
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (sockets[pid]) sockets[pid].emit("start_game", startPayload(false));
	}
	// Tournament-eliminated players stay subscribed as spectators — they need
	// the new round's boardData/boardMask so their decoder matches what the
	// survivors are revealing, otherwise their slot-0 canvas would render
	// the new state matrix against last round's mine layout (cells revealed
	// to clue=0 would paint as mines, etc).
	if (room.tournamentEliminated) {
		var specIds = Object.keys(room.tournamentEliminated);
		for (var si = 0; si < specIds.length; si++) {
			var specSock = sockets[specIds[si]];
			if (specSock) specSock.emit("start_game", startPayload(true));
		}
	}
	setTimeout(function() {
		if (!rooms[room.id] || room.phase !== "playing") return;
		roundStarts[room.id] = Date.now();
		for (var i = 0; i < room.players.length; i++) {
			var pid = room.players[i];
			if (games[pid]) games[pid].playing = true;
		}
		if (room.roundSeconds > 0) {
			roundDeadlines[room.id] = Date.now() + room.roundSeconds * 1000;
			roundTimers[room.id] = setTimeout(function() {
				handleRoundTimeUp(room);
			}, room.roundSeconds * 1000);
		}
		broadcastRoomState(room);
		updateDraw(room);
		botMgr.startBotTicksForRoom(room);
	}, COUNT_DOWN_TIME * 1000);
}

function startSeries(room) {
	room.startSeries();
	broadcastRoomState(room);
	broadcastRoomList();
	startGame(room);
}



function createPlayerGame(playerID, gameRows, gameCols) {
	var game = gameCreator.createGame(0, gameRows, gameCols);
	game.playerName = names[playerID] || "Anonymous";
	game.win = function() { gameWin(playerID); };
	game.mineHit = function() { gameMineHit(playerID); };
	return game;
}

function addPlayerToRoom(socket, room) {
	var playerID = socket.id;
	games[playerID] = createPlayerGame(playerID, room.rows, room.cols);
	roomMapping[playerID] = room;
	room.addPlayer(playerID);

	socket.leave("lobby");
	socket.join("room:" + room.id);
	socket.emit("joined_room", { roomId: room.id });
	broadcastRoomState(room);
	broadcastRoomList();
}

// Apply a ranked-Elo loss to a player who's bailing on a live match. For 1v1
// and 6-player we treat them as having come dead-last in a synthetic current-
// series standings; for tournament we mark them eliminated this round and run
// the same pairwise Elo math the regular elimination path uses. Returns the
// eloInfo (delta / newRating / provisional) so the caller can echo it back to
// the leaver, or null if the room isn't ranked or the player isn't persisted.
function applyEarlyLeavePenalty(playerID, room) {
	if (!room.ranked) return null;
	if (isBot(playerID)) return null;
	if (!accounts[playerID]) return null;
	if (room.rankedMode === "tournament") {
		if (!room.tournamentEliminated) room.tournamentEliminated = {};
		if (!room.tournamentElo) room.tournamentElo = {};
		if (room.tournamentEliminated[playerID]) return null;
		// place = the bottom of the current survivor field. They lose to every
		// remaining survivor (pinned at rank 1 in tournamentEloParts) and to
		// everyone already eliminated who placed above them.
		var place = room.players.length;
		room.tournamentEliminated[playerID] = { round: (room.gamesPlayed || 0) + 1, place: place };
		var teloInfo = elo.applyEloForPlayer(playerID, elo.tournamentEloParts(room, playerID, place), room.rankedStyle || "tournament");
		if (teloInfo) room.tournamentElo[playerID] = teloInfo;
		return teloInfo;
	}
	// 1v1 / 6-player ranked: build a series standings snapshot with the leaver
	// pinned at the worst rank, then apply Elo for the leaver only. The other
	// players' Elo is still computed normally at endSeries.
	var standings = buildSeriesStandings(room);
	var lastRank = standings.length + 1;
	var parts = [buildPlayerParts(playerID, lastRank, room.rankedStyle)];
	for (var i = 0; i < standings.length; i++) {
		parts.push(buildPlayerParts(standings[i].id, standings[i].rank, room.rankedStyle));
	}
	return elo.applyEloForPlayer(playerID, parts, room.rankedStyle);
}

function buildPlayerParts(pid, rank, style) {
	var bot = isBot(pid);
	var acc = accounts[pid];
	var u = !bot && acc ? db.getUserById(acc.userId) : null;
	return {
		id: pid,
		rank: rank,
		rating: bot ? (botRating[pid] || RANKED_BOT_RATING) : (u ? elo.readUserRating(u, style) : RANKED_BOT_RATING),
		bot: bot,
		userId: u ? u.id : null,
		played: u ? u.played : 0
	};
}

function removePlayerFromRoom(playerID) {
	var room = roomMapping[playerID];
	if (!room) return null;
	var wasPlaying = room.phase === "playing";
	// Ranked penalty: apply Elo BEFORE deletePlayer so the standings snapshot
	// inside applyEarlyLeavePenalty still includes the leaver.
	var leaveEloInfo = wasPlaying ? applyEarlyLeavePenalty(playerID, room) : null;
	room.deletePlayer(playerID);
	delete roomMapping[playerID];
	delete games[playerID];
	if (sockets[playerID]) {
		sockets[playerID].leave("room:" + room.id);
	}

	// If no humans remain, evict all bots so the room can be cleaned up.
	if (humanCount(room) === 0) {
		while (botCount(room) > 0) {
			botMgr.removeOneBotFromRoom(room);
		}
	}

	if (deleteRoomIfEmpty(room)) {
		broadcastRoomList();
		return;
	}

	// Prefer a human as the new owner if the previous owner left.
	if (room.players.indexOf(room.owner) === -1) {
		var newOwner = null;
		for (var i = 0; i < room.players.length; i++) {
			if (!isBot(room.players[i])) { newOwner = room.players[i]; break; }
		}
		if (newOwner) room.owner = newOwner;
		else room.reassignOwnerIfNeeded();
	}

	if (wasPlaying && room.gameMode === "territory") {
		// A territory game can't continue with a player gone — award it to whoever's left.
		if (room.territory) territory.endGame(room, "opponent-left");
		else { room.phase = "planning"; broadcastRoomState(room); }
		broadcastRoomList();
		return leaveEloInfo;
	}

	if (wasPlaying) {
		// Down to a single player mid-round — end the round so the series can advance.
		if (room.players.length === 1) {
			endIndividualGame(room, "cleared");
		} else {
			updateDraw(room);
			// Only one (or zero) players still actively playing — end the round.
			if (countActivePlayers(room) <= 1) {
				endIndividualGame(room, "cleared");
			}
		}
	} else {
		broadcastRoomState(room);
	}
	broadcastRoomList();
	return leaveEloInfo;
}

// Admin bot-play demos: one standalone (room-less) bot game per socket, streamed move
// by move at the bot's real cadence. Keyed by socket id.
var botDemos = appState.botDemos; // socketId -> { game, lastClick, timer, moves }

function isSocketAdmin(playerID) {
	if (oauth.DEV_AUTH) return true;
	var acc = accounts[playerID];
	if (!acc) return false;
	var u = db.getUserById(acc.userId);
	return !!(u && u.is_admin);
}

function stopBotDemo(playerID) {
	var d = botDemos[playerID];
	if (d && d.timer) clearTimeout(d.timer);
	delete botDemos[playerID];
}

// Full board grid (numbers, -1 for mine) for the demo — admin only, no obfuscation.
function fullBoardGrid(board) {
	return board.map(function(row) { return row.slice(); });
}

// Step the demo bot once, scheduling the next step after its real move delay (and
// honouring the 5s mine-hit freeze). Emits a frame to the watching socket per move.
function tickBotDemo(socket, playerID) {
	var d = botDemos[playerID];
	if (!d) return;
	var game = d.game;
	if (!game.playing || game.finished || d.moves > game.rows * game.cols * 8) {
		socket.emit("bot_demo_move", { state: game.state, finished: true, done: true, progress: game.revealedSafeCount() / game.totalSafeSquares });
		return;
	}
	var now = Date.now();
	if (now < game.frozenUntil) {
		d.timer = setTimeout(function() { tickBotDemo(socket, playerID); }, game.frozenUntil - now + 50);
		return;
	}
	var move;
	try { move = botPlayer.decideMove(game); } catch (e) { console.error("bot_demo decideMove", e); return; }
	if (!move) { socket.emit("bot_demo_move", { state: game.state, finished: true, done: true, progress: game.revealedSafeCount() / game.totalSafeSquares }); return; }
	var delay = botPlayer.computeMoveDelay(game, d.lastClick, move);
	d.timer = setTimeout(function() {
		if (!botDemos[playerID]) return;
		var hitBefore = game.mineHitCount || 0;
		try {
			if (move.type === "right") game.handleRightClick(move.r, move.c);
			else game.handleLeftClick(move.r, move.c);
		} catch (e) { console.error("bot_demo move", e); }
		d.lastClick = { r: move.r, c: move.c };
		d.moves++;
		socket.emit("bot_demo_move", {
			state: game.state,
			move: { r: move.r, c: move.c, type: move.type, difficulty: move.difficulty, stuck: !!move.stuck },
			mineHit: (game.mineHitCount || 0) > hitBefore,
			finished: !!game.finished,
			progress: game.revealedSafeCount() / game.totalSafeSquares
		});
		if (game.finished) { stopBotDemo(playerID); return; }
		tickBotDemo(socket, playerID);
	}, delay);
}

// Attach a (real or guest) user to this socket: populate accounts/names, mirror the name into any live
// game, and emit the `authenticated` snapshot. `sendToken` includes the session token in the payload so a
// freshly-created guest can persist it client-side (a normal token-login already has it).
function loginSocket(socket, playerID, user, token, sendToken) {
	accounts[playerID] = {
		userId: user.id, token: token, played: user.played,
		rating: user.rating,
		ratingSprint: user.rating_sprint != null ? user.rating_sprint : user.rating,
		ratingStandard: user.rating_standard != null ? user.rating_standard : user.rating,
		ratingTournament: user.rating_tournament != null ? user.rating_tournament : user.rating,
		ratingTerritory: user.rating_territory != null ? user.rating_territory : user.rating
	};
	var isFirst = !names[playerID];
	names[playerID] = user.name;
	if (games[playerID]) {
		games[playerID].playerName = user.name;
		updateDraw(roomMapping[playerID]);
	}
	var today = db.todayUtc();
	var dailyAttempt = db.getDailyAttempt(user.id, today);
	var payload = {
		name: user.name,
		rating: user.rating,
		ratingSprint: user.rating_sprint != null ? user.rating_sprint : user.rating,
		ratingStandard: user.rating_standard != null ? user.rating_standard : user.rating,
		ratingTournament: user.rating_tournament != null ? user.rating_tournament : user.rating,
		ratingTerritory: user.rating_territory != null ? user.rating_territory : user.rating,
		avatarUrl: user.avatar_url,
		wins: user.wins,
		played: user.played,
		provisional: user.played < PROVISIONAL_GAMES,
		puzzleRating: user.puzzle_rating,
		puzzlesSolved: user.puzzles_solved,
		puzzlesAttempted: user.puzzles_attempted,
		streakBest: user.streak_best,
		stormBest: user.storm_best,
		dailyStreak: db.dailyStreakForUser(user.id),
		dailyAttempt: dailyAttempt ? { solved: !!dailyAttempt.solved, at: dailyAttempt.attempted_at } : null,
		isAdmin: !!user.is_admin,
		guest: !!user.is_guest
	};
	if (sendToken) payload.token = token;
	socket.emit("authenticated", payload);
	if (isFirst) socket.emit("room_list", { rooms: getRoomList() });
	else if (roomMapping[playerID]) broadcastRoomState(roomMapping[playerID]);
}

io.on("connection", function (socket) {
	var playerID = socket.id;
	sockets[playerID] = socket;
	socket.join("lobby");
	socket.emit("connected", { id: playerID, oauth: oauth.providerFlags() });

	socket.on("authenticate", function(data) {
		var token = data && data.token;
		var user = db.getUserByToken(token);
		if (!user) { socket.emit("auth_failed"); return; }
		loginSocket(socket, playerID, user, token, false);
	});

	// No stored session → spin up a guest: a real user row (with ratings) flagged guest, plus a session
	// token the client persists so the same guest survives reloads. Upgradable to a real account on sign-in.
	socket.on("guest_session", function() {
		if (accounts[playerID]) return; // already signed in / already a guest
		var user = db.createGuest();
		var token = db.createSession(user.id);
		loginSocket(socket, playerID, user, token, true);
	});

	socket.on("sign_out", function() {
		if (accounts[playerID]) {
			db.deleteSession(accounts[playerID].token);
			delete accounts[playerID];
		}
	});

	socket.on("set_name", function(data) {
		var name = (data && typeof data.name === "string") ? data.name.trim().slice(0, 24) : "";
		if (!name) {
			socket.emit("name_rejected", { reason: "Name cannot be empty" });
			return;
		}
		var isFirst = !names[playerID];
		names[playerID] = name;
		// Persist the chosen name for the logged-in row (guests rename themselves this way; it survives reloads).
		if (accounts[playerID]) db.setUserName(accounts[playerID].userId, name);
		if (games[playerID]) {
			games[playerID].playerName = name;
			updateDraw(roomMapping[playerID]);
		}
		socket.emit("name_accepted", { name: name });
		if (isFirst) {
			socket.emit("room_list", { rooms: getRoomList() });
		} else {
			if (roomMapping[playerID]) broadcastRoomState(roomMapping[playerID]);
			broadcastRoomList();
		}
	});

	socket.on("list_rooms", function() {
		socket.emit("room_list", { rooms: getRoomList() });
	});

	socket.on("find_ranked", function(data) {
		if (!accounts[playerID]) { socket.emit("ranked_rejected", { reason: "Sign in to play ranked." }); return; }
		if (roomMapping[playerID]) return;
		var mode = (data && data.mode) || "sprint_duo";
		if (!ranked.isValidMode(mode)) { socket.emit("ranked_rejected", { reason: "Unknown ranked mode." }); return; }
		ranked.enqueue(playerID, mode);
	});

	socket.on("cancel_ranked", function() {
		ranked.dequeue(playerID);
	});

	socket.on("get_leaderboard", function() {
		socket.emit("leaderboard", { players: db.topPlayers(20), provisionalGames: PROVISIONAL_GAMES });
	});

	// Rated puzzle play. Architecturally identical to the multiplayer / solo
	// flow: server constructs a real gameCreator game with the puzzle's
	// mine layout, ships the obfuscated board, and validates every click
	// via the shared left_click / right_click handlers (which branch below
	// to route to puzzlePlay[playerID] when present). The outcome is
	// decided by game.win / game.mineHit firing server-side — clients can't
	// fake a solve. Auth required.
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

	// Solo-mode primitive: generate a fresh no-guess board on demand and ship
	// the obfuscated blob back to this socket. No room, no opponents, no Elo
	// — the client owns the play loop. Underpins Free play, drills, and the
	// eventual daily speedrun.
	socket.on("request_solo_board", function(data) {
		var size = (data && data.size) || "medium";
		var dims = roomCreator.BOARD_SIZES[size];
		if (!dims) return;
		var density = (data && typeof data.density === "number") ? data.density : 0.10;
		if (density < 0.04) density = 0.04;
		if (density > 0.30) density = 0.30;
		var rows = dims.rows, cols = dims.cols;
		var mines = Math.round(density * rows * cols);
		var centerR = Math.floor(rows / 2);
		var centerC = Math.floor(cols / 2);
		var template = noGuess.createNoGuessTemplate(centerR, centerC, mines, undefined, rows, cols);
		if (!template) { socket.emit("solo_rejected", { reason: "Couldn't generate a no-guess board, try again." }); return; }
		var obf = obfuscateBoard(template.board, rows, cols);
		socket.emit("solo_board", {
			size: size,
			rows: rows,
			cols: cols,
			mines: mines,
			totalSafe: rows * cols - mines,
			knownCells: template.knownCells,  // pre-revealed cascade origin
			boardData: obf.data,
			boardMask: obf.mask
		});
	});

	// Admin: start (or restart) a bot-play demo. Builds a fresh medium no-guess board at
	// the requested density, configures a standalone game with the pool bot's variables,
	// and streams its play. The full board is sent (admin only — no anti-cheat needed).
	socket.on("bot_demo_start", function(data) {
		if (!isSocketAdmin(playerID)) return;
		var pool = botPlayer.getPool();
		var bot = pool[data && data.botIndex];
		if (!bot) return;
		var density = (data && typeof data.density === "number") ? data.density : 0.10;
		if (density < 0.04) density = 0.04;
		if (density > 0.30) density = 0.30;
		var dims = roomCreator.BOARD_SIZES.medium;
		var rows = dims.rows, cols = dims.cols;
		var mines = Math.round(density * rows * cols);
		var template = noGuess.createNoGuessTemplate(Math.floor(rows / 2), Math.floor(cols / 2), mines, undefined, rows, cols);
		if (!template) { socket.emit("bot_demo_rejected", { reason: "Couldn't generate a board, try again." }); return; }

		stopBotDemo(playerID);
		var game = gameCreator.createGame(mines, rows, cols);
		game.botSpeedMs = bot.speedMs;
		game.botDifficultyMs = bot.difficultyMs;
		game.botDistanceMult = bot.distanceMult;
		game.botMaxDifficulty = bot.maxDifficulty;
		game.botMistakeRate = bot.mistakeRate;
		game.botChordRate = bot.chordRate;
		game.botDifficultyByCell = template.difficultyByCell || null;
		game.mineHitCount = 0;
		game.win = function() { game.finished = true; };
		game.mineHit = function() { game.mineHitCount++; game.frozenUntil = Date.now() + RANKED_RULES.deathPenalty * 1000; };
		game.init(template);
		game.playing = true;
		game.frozenUntil = 0;

		botDemos[playerID] = { game: game, lastClick: null, timer: null, moves: 0 };
		socket.emit("bot_demo_board", { rows: rows, cols: cols, board: fullBoardGrid(game.board), state: game.state, mines: mines, density: density });
		tickBotDemo(socket, playerID);
	});

	socket.on("bot_demo_stop", function() { stopBotDemo(playerID); });

	socket.on("create_room", function(data) {
		if (!names[playerID]) return;
		if (roomMapping[playerID]) return;
		var id = nextRoomId++;
		var isTerritory = data && data.mode === "territory";
		// Territory is a shared-board mode: 2 players (opposite corners) or 4 (one per corner).
		var territorySeats = (data && data.players === 4) ? 4 : 2;
		var room = roomCreator.createRoom(id, playerID, isTerritory ? territorySeats : undefined);
		if (isTerritory) {
			room.gameMode = "territory";
			var td = territory.dims(territorySeats); room.rows = td.rows; room.cols = td.cols;
			room.roundSeconds = 0; // no clock — territory ends when the board is fully played out (stuck)
		}
		rooms[id] = room;
		addPlayerToRoom(socket, room);
	});

	socket.on("join_room", function(data) {
		if (!names[playerID]) return;
		if (roomMapping[playerID]) return;
		var room = rooms[data && data.roomId];
		if (!room) {
			socket.emit("join_failed", { reason: "Room no longer exists" });
			return;
		}
		if (room.isFull()) {
			socket.emit("join_failed", { reason: "Room is full" });
			return;
		}
		if (room.phase !== "planning") {
			socket.emit("join_failed", { reason: "Series in progress" });
			return;
		}
		addPlayerToRoom(socket, room);
	});

	socket.on("leave_room", function() {
		if (!roomMapping[playerID]) return;
		var socketRef = sockets[playerID];
		var leaveEloInfo = removePlayerFromRoom(playerID);
		if (socketRef) {
			socketRef.join("lobby");
			socketRef.emit("left_room", leaveEloInfo ? {
				ratingDelta: leaveEloInfo.delta,
				rating: leaveEloInfo.newRating,
				provisional: leaveEloInfo.provisional
			} : null);
			socketRef.emit("room_list", { rooms: getRoomList() });
		}
	});

	socket.on("set_game_count", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var count = data && parseInt(data.count, 10);
		if (room.setGameCount(count)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_round_seconds", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var seconds = data && parseInt(data.seconds, 10);
		if (room.setRoundSeconds(seconds)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_death_penalty", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var seconds = data && parseInt(data.seconds, 10);
		if (room.setDeathPenalty(seconds)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_mine_density", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var density = data && parseFloat(data.density);
		if (room.setMineDensity(density)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_board_size", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (room.setBoardSize(data && data.size)) {
			broadcastRoomState(room);
			broadcastRoomList();
		}
	});

	socket.on("set_bot_difficulty", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (room.phase !== "planning") return;
		var botId = data && data.botId;
		var difficulty = data && data.difficulty;
		if (!isBot(botId) || roomMapping[botId] !== room) return;
		if (botPlayer.DIFFICULTIES.indexOf(difficulty) === -1) return;
		botDifficulty[botId] = difficulty;
		var cfg = botPlayer.configForDifficulty(difficulty);
		botSpeedMs[botId] = cfg.speedMs;
		botDifficultyMs[botId] = cfg.difficultyMs;
		botDistanceMult[botId] = cfg.distanceMult;
		botMaxDifficulty[botId] = cfg.maxDifficulty;
		botMistake[botId] = cfg.mistakeRate;
		botChord[botId] = cfg.chordRate;
		botMgr.applyBotConfigToGame(botId);
		broadcastRoomState(room);
	});

	socket.on("add_bot", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (!botMgr.addBotToRoom(room)) return;
		broadcastRoomState(room);
		broadcastRoomList();
		// If the owner had already readied before adding the bot, start now.
		if (room.players.length > 1 && room.allReady() && humanCount(room) > 0) {
			startSeries(room);
		}
	});

	socket.on("remove_bot", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (room.phase !== "planning") return;
		if (!botMgr.removeOneBotFromRoom(room)) return;
		broadcastRoomState(room);
		broadcastRoomList();
	});

	socket.on("player_ready", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.phase !== "planning") return;
		room.playerReady(playerID);
		broadcastRoomState(room);
		if (room.players.length > 1 && room.allReady()) {
			startSeries(room);
		}
	});

	socket.on("right_click", function (data) {
		var pp = puzzlePlay[playerID];
		if (pp) {
			if (!pp.game.playing) return;
			pp.game.handleRightClick(data.r, data.c);
			return;
		}
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		if (room.gameMode === "territory") return; // no flags in territory v1
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleRightClick(data.r, data.c);
		updateDraw(room);
	});

	socket.on("left_click", function(data) {
		var pp = puzzlePlay[playerID];
		if (pp) {
			if (!pp.game.playing) return;
			pp.game.handleLeftClick(data.r, data.c);
			return;
		}
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		if (room.gameMode === "territory") { territory.handleReveal(playerID, data); return; }
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleLeftClick(data.r, data.c);
		updateDraw(room);
	});

	// Territory-only socket handlers (fire a fort beam / launch an energy bomb).
	territory.registerSocketHandlers(socket, playerID);

	socket.on("disconnect", function() {
		ranked.dequeue(playerID);
		if (roomMapping[playerID]) {
			removePlayerFromRoom(playerID);
		}
		// Mid-puzzle disconnect is fine — current_puzzle_id stays set in the
		// DB so the same puzzle is served on reconnect. We just drop the
		// in-memory game state. Active runs end (no resume — runs are
		// session-only by design); score is recorded if it's a new best.
		if (puzzleRun[playerID]) endPuzzleRun(socket, playerID, "disconnect");
		stopBotDemo(playerID);
		delete puzzlePlay[playerID];
		delete sockets[playerID];
		delete names[playerID];
		delete accounts[playerID]; // session stays valid in the DB for reconnect
	});
});


// One-shot: re-classify puzzles inserted before the overlap pass existed
// so their pass counts and tier reflect the new solver. Rows are batched
// so a large pool doesn't block the event loop at startup.
function backfillOverlapClassification() {
	var rows = db.legacyPuzzleRows();
	if (!rows.length) return;
	console.log("reclassifying " + rows.length + " puzzles for the overlap pass");
	var idx = 0;
	function step() {
		var end = Math.min(rows.length, idx + 50);
		for (; idx < end; idx++) {
			var row = rows[idx];
			var mines = JSON.parse(row.mines);
			var revealed = JSON.parse(row.revealed);
			var board = puzzleGen.buildBoard(row.rows, row.cols, mines);
			var analysis = puzzleGen.analyzeWithTracking(board, revealed, mines.length);
			db.applyPuzzleClassification(row.id, analysis);
		}
		if (idx < rows.length) setImmediate(step);
		else console.log("overlap reclassification complete");
	}
	setImmediate(step);
}

// Reap abandoned guest accounts (no games, no puzzles, older than the TTL) on startup and daily, so
// drive-by visitors don't grow the users table without bound. Tune via GUEST_TTL_DAYS (default 7).
var GUEST_TTL_DAYS = parseFloat(process.env.GUEST_TTL_DAYS || "7");
function reapGuests() {
	try {
		var removed = db.pruneStaleGuests(GUEST_TTL_DAYS * 24 * 60 * 60 * 1000);
		if (removed) console.log("[guests] pruned " + removed + " stale guest(s) older than " + GUEST_TTL_DAYS + "d");
	} catch (e) { console.error("[guests] prune failed", e); }
}

app.listen(PORT, "0.0.0.0", function() {
	console.log("listening on " + PORT);
	backfillOverlapClassification();
	puzzleApi.ensurePoolTopUp();
	reapGuests();
	setInterval(reapGuests, 24 * 60 * 60 * 1000);
});
