// Admin "watch a bot play" demo, extracted from minesweeperServer. Builds a standalone
// no-guess game configured with a pool bot's variables and streams its play to the
// watching (admin) socket, one frame per move. Self-contained on botPlayer + the board
// generators; the admin gate (isSocketAdmin) and RANKED_RULES (the mine-hit freeze) are
// injected via init. State (botDemos) is appState.

var appState = require("./appState");
var botPlayer = require("../engine/BotPlayer");
var gameCreator = require("../engine/GameCreator");
var noGuess = require("../engine/NoGuessGenerator");
var roomCreator = require("../engine/RoomCreator");

var botDemos = appState.botDemos; // socketId -> { game, lastClick, timer, moves }

var isSocketAdmin, RANKED_RULES;
function init(deps) { isSocketAdmin = deps.isSocketAdmin; RANKED_RULES = deps.RANKED_RULES; }

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

// Register the admin bot-demo socket handlers for a connected player.
function registerSocketHandlers(socket, playerID) {
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
}

module.exports = {
	init: init,
	registerSocketHandlers: registerSocketHandlers,
	stopBotDemo: stopBotDemo
};
