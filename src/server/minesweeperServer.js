var http = require("http")
  , path = require("path")
  , crypto = require("node:crypto")
  , gameCreator = require("./engine/GameCreator")
  , noGuess = require("./engine/NoGuessGenerator")
  , puzzleGen = require("./engine/PuzzleGenerator")
  , roomCreator = require("./engine/RoomCreator")
  , territoryGen = require("./engine/TerritoryGenerator")
  , territoryGame = require("./engine/TerritoryGame")
  , botPlayer = require("./engine/BotPlayer")
  , db = require("./db")
  , BoardLogic = require("../common/BoardLogic")
  , cspSolver = require("./engine/CSPSolver")
  , oauth = require("./runtime/oauth")
  , puzzleApi = require("./runtime/puzzleApi")
  , staticServer = require("./runtime/staticServer")
  , appState = require("./runtime/appState")
  , territory = require("./runtime/territory")
  , ranked = require("./runtime/ranked")
  , elo = require("./runtime/elo")
  , botMgr = require("./runtime/bots")
  , puzzleMode = require("./runtime/puzzlePlay")
  , botDemo = require("./runtime/botDemo")
  , standings = require("./runtime/standings")
  , roomState = require("./runtime/roomState")
  , session = require("./runtime/session")
  , gameUtil = require("./runtime/gameUtil");

var obfuscateBoard = gameUtil.obfuscateBoard, gameForBroadcast = gameUtil.gameForBroadcast, isBot = gameUtil.isBot,
    humanCount = gameUtil.humanCount, botCount = gameUtil.botCount, getRoomBotNames = gameUtil.getRoomBotNames, updateDraw = gameUtil.updateDraw;

// Load a local .env if present (no-op in production, where env vars are set directly).
try { process.loadEnvFile(); } catch (e) { /* no .env file — fine */ }


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

// Last-resort safety net: keep the process alive on an unexpected error instead of crashing
// and dropping every connected player. Socket handlers are already wrapped per-event (see the
// connection handler); this catches the rest — chiefly errors thrown from timer callbacks (bot
// ticks, round/ranked timers, the territory world tick). Log loudly so the real bug gets fixed.
process.on("uncaughtException", function(err) {
	console.error("uncaughtException (kept alive):", err);
});
process.on("unhandledRejection", function(reason) {
	console.error("unhandledRejection (kept alive):", reason);
});

var app = http.createServer(handler);
var io = require("socket.io")(app);
appState.io = io; // share the socket.io server with the handler modules
// Wire the territory module with the core helpers it needs (breaks the circular require).
territory.init({
	io: io,
	COUNT_DOWN_TIME: COUNT_DOWN_TIME,
	clearRoundTimer: clearRoundTimer,
	applyRankedElo: elo.applyRankedElo,
	broadcastRoomState: roomState.broadcastRoomState,
	broadcastRoomList: roomState.broadcastRoomList
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

// The Elo math lives in elo.js; give it the rating constants (shared predicates come from gameUtil).
elo.init({ RANKED_BOT_RATING: RANKED_BOT_RATING, PROVISIONAL_GAMES: PROVISIONAL_GAMES });
standings.init({ RANKED_BOT_RATING: RANKED_BOT_RATING, PROVISIONAL_GAMES: PROVISIONAL_GAMES });
roomState.init({ io: io, MAX_BOTS_PER_ROOM: MAX_BOTS_PER_ROOM, RANKED_BOT_RATING: RANKED_BOT_RATING, PROVISIONAL_GAMES: PROVISIONAL_GAMES });
session.init({ PROVISIONAL_GAMES: PROVISIONAL_GAMES });

// Racing-bot orchestration lives in botMgr.js; give it the game-loop services it needs.
botMgr.init({
	createPlayerGame: createPlayerGame,
	newBotId: function() { return nextBotId++; },
	RANKED_BOT_RATING: RANKED_BOT_RATING, MAX_BOTS_PER_ROOM: MAX_BOTS_PER_ROOM
});

// Single-player puzzle play lives in puzzlePlay.js; it's self-contained (obfuscateBoard via gameUtil).
botDemo.init({ isSocketAdmin: isSocketAdmin, RANKED_RULES: RANKED_RULES });

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
	broadcastRoomState: roomState.broadcastRoomState,
	startSeries: startSeries
});
// Per-mode queue state: humans searching, pre-generated bots, and the trickle timer.
var rankedQueues = appState.rankedQueues;
var pendingBotsLists = appState.pendingBotsLists;
var rankedFillTimers = appState.rankedFillTimers;
var rankedQueueMode = appState.rankedQueueMode; // playerID -> mode key



function clearRoundTimer(roomId) {
	if (roundTimers[roomId]) {
		clearTimeout(roundTimers[roomId]);
		delete roundTimers[roomId];
	}
	delete roundDeadlines[roomId];
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



function endIndividualGame(room, reason) {
	if (room.phase !== "playing") return;
	clearRoundTimer(room.id);
	botMgr.clearRoomBotTicks(room);
	for (var i = 0; i < room.players.length; i++) {
		if (games[room.players[i]]) games[room.players[i]].playing = false;
	}
	var roundStandings = standings.buildStandings(room);
	// Round winner = unique top-ranked player, if any.
	var winnerID = null;
	if (roundStandings.length > 0 && roundStandings[0].rank === 1) {
		var tiedAtTop = 0;
		for (var k = 0; k < roundStandings.length; k++) if (roundStandings[k].rank === 1) tiedAtTop++;
		if (tiedAtTop === 1) winnerID = roundStandings[0].id;
	}
	room.recordRoundResult(roundStandings, winnerID);

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
		for (var ei = roundStandings.length - 1; ei >= survivorsTarget; ei--) {
			var sCut = roundStandings[ei];
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
		standings: roundStandings
	});
	roomState.broadcastRoomState(room);

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


function endSeries(room) {
	if (nextGameTimers[room.id]) {
		clearTimeout(nextGameTimers[room.id]);
		delete nextGameTimers[room.id];
	}
	room.seriesWinner = standings.computeSeriesWinner(room);
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
		seriesStandings = standings.buildTournamentStandings(room);
		room.seriesWinner = seriesStandings[0] ? seriesStandings[0].id : null;
	} else {
		seriesStandings = standings.buildSeriesStandings(room);
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
	roomState.broadcastRoomState(room);
	roomState.broadcastRoomList();

	// Ranked rooms are single-match: don't auto-reset bots or scores. The client
	// shows "Play another" (re-queues) and "Back to menu" (leaves the room).
	if (room.ranked) return;

	setTimeout(function() {
		if (!rooms[room.id]) return;
		room.resetScores();
		room.resetReady();
		botMgr.readyAllBots(room);
		roomState.broadcastRoomState(room);
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
	roomState.broadcastRoomState(room);

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
		roomState.broadcastRoomState(room);
		updateDraw(room);
		botMgr.startBotTicksForRoom(room);
	}, COUNT_DOWN_TIME * 1000);
}

function startSeries(room) {
	room.startSeries();
	roomState.broadcastRoomState(room);
	roomState.broadcastRoomList();
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
	roomState.broadcastRoomState(room);
	roomState.broadcastRoomList();
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
	var seriesStandings = standings.buildSeriesStandings(room);
	var lastRank = seriesStandings.length + 1;
	var parts = [buildPlayerParts(playerID, lastRank, room.rankedStyle)];
	for (var i = 0; i < seriesStandings.length; i++) {
		parts.push(buildPlayerParts(seriesStandings[i].id, seriesStandings[i].rank, room.rankedStyle));
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
		roomState.broadcastRoomList();
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
		else { room.phase = "planning"; roomState.broadcastRoomState(room); }
		roomState.broadcastRoomList();
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
		roomState.broadcastRoomState(room);
	}
	roomState.broadcastRoomList();
	return leaveEloInfo;
}

// Admin bot-play demos: one standalone (room-less) bot game per socket, streamed move
// by move at the bot's real cadence. Keyed by socket id.

function isSocketAdmin(playerID) {
	if (oauth.DEV_AUTH) return true;
	var acc = accounts[playerID];
	if (!acc) return false;
	var u = db.getUserById(acc.userId);
	return !!(u && u.is_admin);
}



io.on("connection", function (socket) {
	var playerID = socket.id;
	// Contain handler errors: a thrown exception in ANY socket event handler (the core ones
	// below + the feature modules' registerSocketHandlers) is logged and dropped, instead of
	// propagating up to uncaughtException and taking the whole server — every connected
	// player — down. Patched before any handler is registered so it covers them all.
	var rawOn = socket.on.bind(socket);
	socket.on = function(event, handler) {
		return rawOn(event, function() {
			try {
				return handler.apply(this, arguments);
			} catch (e) {
				console.error("socket '" + event + "' handler error:", e);
			}
		});
	};
	sockets[playerID] = socket;
	socket.join("lobby");
	socket.emit("connected", { id: playerID, oauth: oauth.providerFlags() });

	session.registerSocketHandlers(socket, playerID);


	socket.on("list_rooms", function() {
		socket.emit("room_list", { rooms: roomState.getRoomList() });
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
			socketRef.emit("room_list", { rooms: roomState.getRoomList() });
		}
	});

	socket.on("set_game_count", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var count = data && parseInt(data.count, 10);
		if (room.setGameCount(count)) {
			roomState.broadcastRoomState(room);
			roomState.broadcastRoomList();
		}
	});

	socket.on("set_round_seconds", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var seconds = data && parseInt(data.seconds, 10);
		if (room.setRoundSeconds(seconds)) {
			roomState.broadcastRoomState(room);
			roomState.broadcastRoomList();
		}
	});

	socket.on("set_death_penalty", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var seconds = data && parseInt(data.seconds, 10);
		if (room.setDeathPenalty(seconds)) {
			roomState.broadcastRoomState(room);
			roomState.broadcastRoomList();
		}
	});

	socket.on("set_mine_density", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var density = data && parseFloat(data.density);
		if (room.setMineDensity(density)) {
			roomState.broadcastRoomState(room);
			roomState.broadcastRoomList();
		}
	});

	socket.on("set_board_size", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (room.setBoardSize(data && data.size)) {
			roomState.broadcastRoomState(room);
			roomState.broadcastRoomList();
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
		roomState.broadcastRoomState(room);
	});

	socket.on("add_bot", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (!botMgr.addBotToRoom(room)) return;
		roomState.broadcastRoomState(room);
		roomState.broadcastRoomList();
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
		roomState.broadcastRoomState(room);
		roomState.broadcastRoomList();
	});

	socket.on("player_ready", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.phase !== "planning") return;
		room.playerReady(playerID);
		roomState.broadcastRoomState(room);
		if (room.players.length > 1 && room.allReady()) {
			startSeries(room);
		}
	});

	socket.on("right_click", function (data) {
		if (puzzleMode.handleRightClick(playerID, data)) return; // single-player puzzle in progress
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		if (room.gameMode === "territory") return; // no flags in territory v1
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleRightClick(data.r, data.c);
		updateDraw(room);
	});

	socket.on("left_click", function(data) {
		if (puzzleMode.handleLeftClick(playerID, data)) return; // single-player puzzle in progress
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		if (room.gameMode === "territory") { territory.handleReveal(playerID, data); return; }
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleLeftClick(data.r, data.c);
		updateDraw(room);
	});

	// Single-player puzzle (rated / streak / storm / daily) + territory socket handlers.
	puzzleMode.registerSocketHandlers(socket, playerID);
	botDemo.registerSocketHandlers(socket, playerID);
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
		puzzleMode.cleanup(socket, playerID);
		botDemo.stopBotDemo(playerID);
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
