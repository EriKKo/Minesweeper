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
  , marathonGen = require("./runtime/marathonGen")
  , standings = require("./runtime/standings")
  , roomState = require("./runtime/roomState")
  , session = require("./runtime/session")
  , replay = require("./runtime/replay")
  , results = require("./runtime/results")
  , lifecycle = require("./runtime/lifecycle")
  , gameService = require("./runtime/gameService")
  , role = require("./runtime/role")
  , internalApi = require("./runtime/internalApi")
  , matchToken = require("./runtime/matchToken")
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
// A game server accepts cross-origin socket connections (the browser is on main's origin but connects
// directly to the game server for the match); the join token — not CORS — is what gates access. main/both
// are same-origin, so no CORS needed there.
var io = require("socket.io")(app, role.ROLE === "game" ? { cors: { origin: true, methods: ["GET", "POST"] } } : {});
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
	// Internal main↔game API (split roles only) — secret-guarded, never part of the monolith surface.
	if (role.isSplit() && internalApi.handleInternalRoute(req, res, url)) return;
	if (oauth.handleAuthRoute(req, res, url)) return;
	if (puzzleApi.handleApiRoute(req, res, url)) return;
	staticServer.serve(res, url.pathname, req);
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
var skins = appState.skins; // playerID -> board skin id
var avatars = appState.avatars; // playerID -> avatar cloth colour
var countries = appState.countries; // playerID -> ISO country code
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
marathonGen.init({ isSocketAdmin: isSocketAdmin });

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
	startSeries: gameService.allocate // matchmaking starts a match through the game-service boundary (P1-1)
});
// Wire the game-service boundary: allocate runs a match (startSeries), reportResult persists the outcome,
// and the construction deps let it rebuild a match from a spec (P1-3/P1-5).
gameService.init({
	startMatch: startSeries,
	onResult: results.persistResult,
	createRoom: roomCreator.createRoom,
	createPlayerGame: createPlayerGame,
	addBotToRoom: botMgr.addBotToRoom,
	territoryDims: territory.dims
});

// Game-server role (P1-5): build + run matches handed over the internal API, and report outcomes back
// to main instead of persisting locally. (ROLE=both/main keep the in-process persistResult handler.)
if (role.ROLE === "game") {
	// Game server: build + run matches handed over the internal API, and report outcomes back to main
	// (gameAllocate / reportResultToMain are defined below — hoisted function declarations).
	internalApi.setAllocateHandler(gameAllocate);
	gameService.setResultHandler(reportResultToMain);
}
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
	// Accumulate each player's per-round progress so the series-end Elo can apply a
	// margin-of-victory bonus (a dominant clear pays more than a photo-finish).
	room.progressSum = room.progressSum || {};
	room.progressRounds = (room.progressRounds || 0) + 1;
	for (var ps = 0; ps < roundStandings.length; ps++) {
		var pe = roundStandings[ps];
		room.progressSum[pe.id] = (room.progressSum[pe.id] || 0) + (pe.progress || 0);
	}
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
	console.log("[round] handleRoundTimeUp room=" + room.id + " phase=" + room.phase);
	// Diagnostic: at a timeout, dump each board's revealed/total so we can tell whether a board that
	// "looked cleared" to the player was actually cleared on the server (revealed===total but no win =
	// win-detection bug) or still short (final clicks not reaching/applying = transport/desync).
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i], g = games[pid];
		if (g) console.log("[round] timeout-state pid=" + pid + " isBot=" + isBot(pid) + " revealed=" + g.revealedSafeCount() + "/" + g.totalSafeSquares + " finished=" + g.finished + " frozenUntil=" + (g.frozenUntil > Date.now()));
	}
	if (room.phase !== "playing") return;
	endIndividualGame(room, "timeout");
}

function reduceRoundDeadline(room, targetSeconds) {
	var newDeadline = Date.now() + targetSeconds * 1000;
	if (roundDeadlines[room.id] && roundDeadlines[room.id] <= newDeadline) {
		console.log("[round] reduceRoundDeadline noop room=" + room.id + " (already <= " + targetSeconds + "s)");
		return;
	}
	console.log("[round] reduceRoundDeadline room=" + room.id + " → " + targetSeconds + "s");
	roundDeadlines[room.id] = newDeadline;
	if (roundTimers[room.id]) clearTimeout(roundTimers[room.id]);
	roundTimers[room.id] = setTimeout(function() {
		handleRoundTimeUp(room);
	}, targetSeconds * 1000);
	// Tell clients the round will end sooner so the displayed timer drops too (not just the server's).
	roomState.broadcastRoomState(room);
}


async function endSeries(room) {
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
	}
	// Single persistence seam: ranked racing Elo (tournament rated incrementally elsewhere) + the
	// captured replay (no-op unless this was a ranked match being recorded). See runtime/results.js.
	// Awaited (not fire-and-forget): in-process (monolith/main) this resolves on the next microtask
	// tick since persistResult already mutated seriesStandings in place synchronously — reportResult
	// returns {applied, standings}, not an array, so the merge below is a no-op there. In the split
	// game role, reportResult is reportResultToMain (a real network round-trip to main, where the
	// actual Elo math runs) and resolves with an array of {id, ratingDelta, rating, provisional} —
	// without awaiting it here, series_ended would go out carrying the stale pre-match rating as both
	// "before" and "after" (the bug this fixes), since the game server never otherwise learns what
	// main computed.
	var reported = await gameService.reportResult(results.buildResultReport(room, seriesStandings));
	if (Array.isArray(reported)) {
		var byId = {};
		reported.forEach(function(r) { byId[r.id] = r; });
		seriesStandings.forEach(function(s) {
			var r = byId[s.id];
			if (r && typeof r.ratingDelta === "number") {
				s.ratingDelta = r.ratingDelta;
				s.rating = r.rating;
				s.provisional = r.provisional;
			}
		});
	}
	if (!rooms[room.id]) return; // the room was torn down while we were awaiting main's report
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

	// First finish in this round? Pull the remaining time down so the round closes soon after the
	// winner — the 6-player battle gets a snappy 3s sprint; other modes keep the longer 10s tail.
	var finishedNow = countFinishedPlayers(room);
	console.log("[round] gameWin pid=" + playerID + " isBot=" + isBot(playerID) + " finished=" + finishedNow + " active=" + countActivePlayers(room) + " players=" + room.players.length);
	if (finishedNow === 1) {
		var n = room.players.length;
		var multiRace = (room.gameMode || "race") === "race" && room.rankedMode !== "tournament" && n >= 3 && n <= 6;
		reduceRoundDeadline(room, multiRace ? 3 : 10);
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
	// Open a new replay round (mine layout snapshot) for ranked matches before wiring move capture.
	replay.startRound(room, template, centerR, centerC);
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
		// Custom-lobby gameplay modifiers (mutually exclusive). Only-flags also auto-chords on flag.
		games[pid].noFlags = room.modifier === "noFlags";
		games[pid].onlyFlags = room.modifier === "onlyFlags";
		games[pid].autoChordOnFlag = room.modifier === "onlyFlags";
		replay.attach(room, games[pid], pid);
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
			modifier: room.modifier || null,
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
		if (!rooms[room.id] || room.phase !== "playing") {
			console.log("[round] round-start callback bailed room=" + room.id + " exists=" + !!rooms[room.id] + " phase=" + (room.phase));
			return;
		}
		roundStarts[room.id] = Date.now();
		for (var i = 0; i < room.players.length; i++) {
			var pid = room.players[i];
			if (games[pid]) games[pid].playing = true;
		}
		console.log("[round] round started room=" + room.id + " players=" + room.players.length + " roundSeconds=" + room.roundSeconds);
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
	// Capture the self-contained MatchConfig at match start (P0-2): rules + roster + rating-before.
	// In the split this is what main hands the game server; today it's stashed for the result report.
	room.matchConfig = results.buildMatchConfig(room);
	replay.startMatch(room);
	roomState.broadcastRoomState(room);
	roomState.broadcastRoomList();
	startGame(room);
}



function createPlayerGame(playerID, gameRows, gameCols) {
	var game = gameCreator.createGame(0, gameRows, gameCols);
	game.playerName = names[playerID] || "Anonymous";
	game.skin = skins[playerID] || null; // null → opponents render this board in the default skin (bots, too)
	game.avatar = avatars[playerID] || null; // avatar cloth colour, broadcast so panels show each player's flag
	game.country = countries[playerID] || null;
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



// Contain handler errors: a thrown exception in ANY socket event handler is logged and dropped instead
// of propagating to uncaughtException and taking the whole server down. Applied before any handler is
// registered so it covers them all (both roles).
function installSocketErrorWrapper(socket) {
	var rawOn = socket.on.bind(socket);
	socket.on = function(event, handler) {
		return rawOn(event, function() {
			try { return handler.apply(this, arguments); }
			catch (e) { console.error("socket '" + event + "' handler error:", e); }
		});
	};
}

// The in-game reveal/flag handlers — identical in the monolith and on a game server, so shared.
function registerGameplayHandlers(socket, playerID) {
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
	// Reconciliation safety net: the client sends the safe cells it has cleared locally when it believes
	// the board is done but we haven't registered a win. Force-reveal any we're missing (a reveal that was
	// dropped in transit) so the round the player actually cleared registers the win instead of timing out
	// and scoring as a loss. Capped + cheap (skips already-revealed cells). See client emit in Main.js.
	socket.on("resync_reveal", function(data) {
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing" || room.gameMode === "territory") return;
		var game = games[playerID];
		if (!game || !game.playing) return;
		var cells = (data && data.cells) || [];
		if (!Array.isArray(cells) || cells.length > 4000) return;
		var revealed = 0;
		for (var i = 0; i < cells.length; i++) {
			var cell = cells[i];
			if (cell && game.revealSafeCell(cell[0], cell[1])) revealed++;
		}
		if (revealed) {
			console.log("[round] resync_reveal pid=" + playerID + " healed=" + revealed + " now=" + game.revealedSafeCount() + "/" + game.totalSafeSquares);
			updateDraw(room);
		}
	});
}

// ---- Game-server role (P1-5/P1-6) ----
// Matches are handed over /internal/allocate. Bots are seated immediately; human seats are RESERVED and
// filled as their clients connect with a join token. The series starts once every expected human is
// present (bot-only → starts at once). On end, the result is posted back to main.
var ATTACH_TIMEOUT_MS = 30000;
var gamePending = {}; // matchId -> { room, expected:Set(playerKey), attached:{playerKey:pid}, roster:{playerKey:entry}, started, timer }

function gameAllocate(spec) {
	var room = gameService.buildMatchFromConfig(Object.assign({}, spec, { humans: [] })); // bots only; humans attach later
	var roster = {}, expected = [];
	(spec.humanRoster || []).forEach(function(e) { roster[e.playerKey] = e; expected.push(e.playerKey); });
	var entry = gamePending[spec.matchId] = { room: room, expected: new Set(expected), attached: {}, roster: roster, started: false, timer: null };
	if (expected.length) entry.timer = setTimeout(function() { if (!entry.started) abortPendingMatch(spec.matchId); }, ATTACH_TIMEOUT_MS);
	maybeStartPendingMatch(spec.matchId);
	return { matchId: spec.matchId };
}

// Bind a connecting game-socket to its reserved seat via the join token. Returns false (caller drops the
// socket) if the token is bad, the match is unknown, or the seat is taken.
function attachGameClient(socket, playerID) {
	var token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
	var payload = matchToken.verifyMatchToken(token);
	if (!payload) return false;
	var entry = gamePending[payload.matchId];
	if (!entry) return false;
	var seat = entry.roster[payload.playerKey];
	if (!seat || entry.attached[payload.playerKey]) return false;
	// Bind identity + account to this game-socket, create its game, seat it in the room.
	names[playerID] = seat.name || "Anonymous";
	if (seat.avatar) avatars[playerID] = seat.avatar;
	if (seat.country) countries[playerID] = seat.country;
	if (seat.skin) skins[playerID] = seat.skin;
	if (seat.userId != null) accounts[playerID] = { userId: seat.userId };
	games[playerID] = createPlayerGame(playerID, entry.room.rows, entry.room.cols);
	roomMapping[playerID] = entry.room;
	entry.room.addPlayer(playerID);
	entry.room.playerReady(playerID);
	entry.attached[payload.playerKey] = playerID;
	// Remember which seat (userId / rating-before) this game-socket holds, so the result report can carry
	// it back to main for Elo-from-report (main has no account for this socket id).
	if (!entry.room.seatByPid) entry.room.seatByPid = {};
	entry.room.seatByPid[playerID] = seat;
	socket.join("room:" + entry.room.id);
	socket.emit("connected", { id: playerID, oauth: oauth.providerFlags() });
	socket.emit("joined_room", { roomId: entry.room.id, ranked: !!entry.room.ranked, mode: entry.room.rankedMode || null });
	maybeStartPendingMatch(payload.matchId);
	return true;
}

function maybeStartPendingMatch(matchId) {
	var entry = gamePending[matchId];
	if (!entry || entry.started) return;
	if (Object.keys(entry.attached).length < entry.expected.size) return; // wait for all humans
	entry.started = true;
	if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
	delete gamePending[matchId]; // no longer pending — it's live now
	startSeries(entry.room);
}

function abortPendingMatch(matchId) {
	var entry = gamePending[matchId];
	if (!entry) return;
	delete gamePending[matchId];
	var room = entry.room;
	if (room && rooms[room.id]) {
		(room.players || []).slice().forEach(function(pid) { delete roomMapping[pid]; delete games[pid]; });
		delete rooms[room.id];
	}
}

// Game → main: post the finished match's result (wire-safe; the live room/config aren't serializable).
// Each human standing is enriched with its userId + rating-before so main can apply Elo from the report.
// Awaited by endSeries — main's response carries back each standing's computed ratingDelta/rating/
// provisional (see internalApi.js's /internal/report handler), which endSeries merges into the
// standings it's about to emit in series_ended. Without this the game server's own series_ended would
// always show the pre-match rating as both "before" and "after", since the actual Elo computation only
// happens on main. Returns null (not a rejection) on any failure — endSeries falls back to emitting the
// un-enriched standings rather than the match result getting stuck.
async function reportResultToMain(report) {
	if (!role.MAIN_URL) return null;
	var seatByPid = (report.room && report.room.seatByPid) || {};
	var standings = (report.standings || []).map(function(s) {
		var seat = seatByPid[s.id];
		return seat ? Object.assign({}, s, { userId: seat.userId, ratingBefore: seat.rating, played: seat.played }) : s;
	});
	var wire = {
		matchId: report.matchId, ranked: report.ranked, mode: report.mode, style: report.style,
		standings: standings,
		winnerId: standings[0] ? standings[0].id : null,
		// JSON has no binary type — base64-encode the gzipped replay blob for the hop; persistPayload
		// on the main side accepts either a Buffer (in-process) or this base64 form.
		replayPayload: report.replayPayload ? {
			meta: report.replayPayload.meta,
			blob: report.replayPayload.blob.toString("base64"),
			participants: report.replayPayload.participants,
			createdAt: report.replayPayload.createdAt
		} : null
	};
	try {
		var res = await fetch(role.MAIN_URL + "/internal/report", {
			method: "POST",
			headers: { "content-type": "application/json", "x-internal-secret": role.INTERNAL_SECRET },
			body: JSON.stringify(wire)
		});
		var data = await res.json();
		return (data && data.standings) || null;
	} catch (e) {
		console.error("report to main failed", e);
		return null;
	}
}

io.on("connection", function (socket) {
	var playerID = socket.id;
	installSocketErrorWrapper(socket);
	sockets[playerID] = socket;

	// Game-server role: this socket is a match player. Bind it to its seat via the join token, register
	// only the in-game handlers, and skip all the lobby/auth machinery (that lives on main).
	if (role.ROLE === "game") {
		// TEMP [conn] diagnostics: a rejected attach with a VALID token but no pending entry is a mid-match
		// reconnect (the pending entry is deleted once the match starts) — that strands the client's moves
		// and is the leading suspect for "cleared the board but it said Defeat". Remove once confirmed.
		var _tok = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;
		var _p = matchToken.verifyMatchToken(_tok);
		if (!attachGameClient(socket, playerID)) {
			console.log("[conn] game attach REJECTED pid=" + playerID + " validToken=" + (!!_p) + " matchId=" + (_p && _p.matchId) + " pendingExists=" + (!!(_p && gamePending[_p.matchId])) + " (valid token + no pending = mid-match reconnect)");
			delete sockets[playerID]; socket.disconnect(true); return;
		}
		console.log("[conn] game attach OK pid=" + playerID + " matchId=" + (_p && _p.matchId) + " playerKey=" + (_p && _p.playerKey));
		registerGameplayHandlers(socket, playerID);
		territory.registerSocketHandlers(socket, playerID);
		socket.on("leave_room", function() { if (roomMapping[playerID]) removePlayerFromRoom(playerID); });
		socket.on("disconnect", function(reason) {
			console.log("[conn] game disconnect pid=" + playerID + " reason=" + reason + " inRoom=" + (!!roomMapping[playerID]));
			if (roomMapping[playerID]) removePlayerFromRoom(playerID);
			delete sockets[playerID]; delete names[playerID]; delete skins[playerID];
			delete avatars[playerID]; delete countries[playerID]; delete accounts[playerID];
		});
		return;
	}

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

	// Admin testing tool: set your own rating outright so you can preview ranks / ranked UI at any tier.
	// Gated to admins (DEV_AUTH or is_admin). Updates the DB + the live accounts cache and echoes back.
	socket.on("admin_set_rating", function(data) {
		if (!isSocketAdmin(playerID)) return;
		var acc = accounts[playerID];
		if (!acc) return;
		var rating = Math.round((data && data.rating) || 0);
		rating = Math.max(0, Math.min(6000, rating));
		var fieldByStyle = { sprint: "ratingSprint", standard: "ratingStandard", tournament: "ratingTournament", territory: "ratingTerritory" };
		var styles = (data && fieldByStyle[data.style]) ? [data.style] : ["sprint", "standard", "tournament", "territory"];
		styles.forEach(function(st) {
			db.setRating(acc.userId, rating, st);
			acc[fieldByStyle[st]] = rating;
		});
		socket.emit("admin_rating_set", {
			ratingSprint: acc.ratingSprint, ratingStandard: acc.ratingStandard,
			ratingTournament: acc.ratingTournament, ratingTerritory: acc.ratingTerritory
		});
	});

	socket.on("get_leaderboard", function(data) {
		var mode = (data && typeof data.mode === "string") ? data.mode : "overall";
		socket.emit("leaderboard", { players: db.topPlayers(20, mode), provisionalGames: PROVISIONAL_GAMES, mode: mode });
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
			density: density,
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
		// Territory is a shared-board mode (2 or 4 seats). It's no longer offered in the custom UI
		// (race-only there), but the socket still creates it — ranked territory and the territory tests
		// rely on this wiring.
		if (data && data.mode === "territory") {
			var seats = parseInt(data.players, 10) === 4 ? 4 : 2;
			var troom = roomCreator.createRoom(id, playerID, seats);
			troom.gameMode = "territory";
			var td = territory.dims(seats); troom.rows = td.rows; troom.cols = td.cols;
			troom.roundSeconds = 0; // no clock — territory ends when the board is played out
			rooms[id] = troom;
			addPlayerToRoom(socket, troom);
			return;
		}
		// Custom rooms are casual races configured up front in the create-room modal. Player count and
		// each ruleset option are applied through the room's own validated setters, which silently
		// ignore anything out of range — so a malformed payload just falls back to the defaults.
		var players = data && parseInt(data.players, 10);
		var maxPlayers = (players >= 2 && players <= 6) ? players : undefined;
		var room = roomCreator.createRoom(id, playerID, maxPlayers);
		if (data) {
			if (data.boardSize) room.setBoardSize(data.boardSize);
			if (data.mineDensity != null) room.setMineDensity(parseFloat(data.mineDensity));
			if (data.roundSeconds != null) room.setRoundSeconds(parseInt(data.roundSeconds, 10));
			if (data.deathPenalty != null) room.setDeathPenalty(parseInt(data.deathPenalty, 10));
			if (data.gameCount != null) room.setGameCount(parseInt(data.gameCount, 10));
			if (data.modifier != null) room.setModifier(data.modifier || null);
		}
		rooms[id] = room;
		addPlayerToRoom(socket, room);
	});

	socket.on("join_room", function(data) {
		if (!names[playerID]) return;
		if (roomMapping[playerID]) return;
		var room = rooms[data && data.roomId];
		if (!room) {
			socket.emit("join_failed", { reason: "Lobby no longer exists" });
			return;
		}
		if (room.isFull()) {
			socket.emit("join_failed", { reason: "Lobby is full" });
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
		// Remember it as the room's default so the next bot added matches the last difficulty chosen.
		room.lastBotDifficulty = difficulty;
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
			gameService.allocate(room); // start the match through the game-service boundary (P1-1)
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
			gameService.allocate(room); // start the match through the game-service boundary (P1-1)
		}
	});

	registerGameplayHandlers(socket, playerID); // left_click / right_click (shared with the game role)

	// Single-player puzzle (rated / streak / storm / daily) + territory socket handlers.
	puzzleMode.registerSocketHandlers(socket, playerID);
	botDemo.registerSocketHandlers(socket, playerID);
	territory.registerSocketHandlers(socket, playerID);
	marathonGen.registerSocketHandlers(socket, playerID);

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
		delete skins[playerID];
		delete avatars[playerID];
		delete countries[playerID];
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

// Listen on all interfaces incl. IPv6 (host omitted → Node binds `::` dual-stack). This is required for
// the split: fly's private `.internal` networking is IPv6, so a game server reporting to
// erik-minesweeper.internal:PORT must reach an IPv6 listener (binding "0.0.0.0" is IPv4-only and the
// public proxy still works, but app-to-app 6PN connections get ECONNREFUSED).
app.listen(PORT, function() {
	console.log("listening on " + PORT);
	backfillOverlapClassification();
	puzzleApi.ensurePoolTopUp();
	reapGuests();
	setInterval(reapGuests, 24 * 60 * 60 * 1000);
	// Drain on SIGTERM (deploy / `npm run stop`): finish active matches, then exit. See runtime/lifecycle.js.
	lifecycle.installShutdownHandler();
});
