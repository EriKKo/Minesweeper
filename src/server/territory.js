// Territory (versus) mode — the server-side wiring, extracted from minesweeperServer.
// One shared board both/all players grow into from their corners; cells are claimed by
// whoever clears them first (the game logic lives in TerritoryGame / TerritoryGenerator).
//
// This subsystem is bidirectionally coupled to the room/game lifecycle: it's called from
// the core (startGame -> startGame, player-leave -> endGame, left_click/fire/bomb) and it
// calls back into core helpers (obfuscateBoard, isBot, clearRoundTimer, applyRankedElo,
// broadcastRoomState/List). To avoid a circular require, those few helpers (and the shared
// COUNT_DOWN_TIME + io) are injected once via init(); everything else is shared state from
// appState or territory-internal.

var appState = require("./appState");
var territoryGame = require("./TerritoryGame");
var territoryGen = require("./TerritoryGenerator");
var botPlayer = require("./BotPlayer");
var BoardLogic = require("../common/BoardLogic");

// Shared state (mutated in place; same objects the server holds).
var rooms = appState.rooms, sockets = appState.sockets, names = appState.names, roomMapping = appState.roomMapping;
var roundStarts = appState.roundStarts, roundDeadlines = appState.roundDeadlines, roundTimers = appState.roundTimers;
var botMaxDifficulty = appState.botMaxDifficulty, botMistake = appState.botMistake, botSpeedMs = appState.botSpeedMs, botDifficultyMs = appState.botDifficultyMs;

// Territory-mode board sizes + palette (moved here from the server).
var TERRITORY_ROWS = 18, TERRITORY_COLS = 30;      // 2-player board: wide, room to play
var TERRITORY_ROWS_4 = 24, TERRITORY_COLS_4 = 40;  // 4-player board: bigger, so each corner has room
var TERRITORY_DENSITY = 0.13;
var TERRITORY_COLORS = ["cyan", "amber", "violet", "rose"]; // index = player slot (2- or 4-player)
// Board dims for a territory game by player count.
function territoryDims(players) { return players === 4 ? { rows: TERRITORY_ROWS_4, cols: TERRITORY_COLS_4 } : { rows: TERRITORY_ROWS, cols: TERRITORY_COLS }; }

// Core helpers + shared values injected at boot to avoid a circular require on the server.
var io, COUNT_DOWN_TIME, obfuscateBoard, isBot, clearRoundTimer, applyRankedElo, broadcastRoomState, broadcastRoomList;
function init(deps) {
	io = deps.io;
	COUNT_DOWN_TIME = deps.COUNT_DOWN_TIME;
	obfuscateBoard = deps.obfuscateBoard;
	isBot = deps.isBot;
	clearRoundTimer = deps.clearRoundTimer;
	applyRankedElo = deps.applyRankedElo;
	broadcastRoomState = deps.broadcastRoomState;
	broadcastRoomList = deps.broadcastRoomList;
}

function territoryPlayerMeta(room) {
	return room.players.map(function(pid, i) {
		return { id: pid, name: names[pid] || "Anonymous", color: TERRITORY_COLORS[i] || "cyan" };
	});
}

function startTerritoryGame(room) {
	clearRoundTimer(room.id);
	if (room.players.length !== 2 && room.players.length !== 4) return; // territory is 2- or 4-player (one per corner)
	var gen = territoryGen.generate({ rows: room.rows, cols: room.cols, density: TERRITORY_DENSITY, corners: room.players.length });
	var tg = territoryGame.create(gen, room.players);
	tg.started = false;
	room.territory = tg;

	var obf = obfuscateBoard(gen.board, gen.rows, gen.cols);
	var meta = territoryPlayerMeta(room);
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (!sockets[pid]) continue;
		sockets[pid].emit("territory_start", {
			time: COUNT_DOWN_TIME, rows: gen.rows, cols: gen.cols,
			boardData: obf.data, boardMask: obf.mask,
			players: meta, you: pid, starts: gen.starts,
			roundSeconds: room.roundSeconds
		});
	}
	setTimeout(function() {
		if (!rooms[room.id] || room.phase !== "playing" || room.territory !== tg) return;
		tg.started = true;
		roundStarts[room.id] = Date.now();
		if (room.roundSeconds > 0) {
			roundDeadlines[room.id] = Date.now() + room.roundSeconds * 1000;
			roundTimers[room.id] = setTimeout(function() {
				if (room.phase === "playing" && room.territory === tg) endTerritoryGame(room, "timeout");
			}, room.roundSeconds * 1000);
		}
		broadcastTerritory(room);
		startTerritoryBots(room, tg);
		startTerritoryWorldTick(room, tg);
	}, COUNT_DOWN_TIME * 1000);
}

// Drive any bot players in a territory game with the SAME bot AI the racing modes use
// (botPlayer.decideMove). The only differences are fed in via the game view: reveals are
// restricted to cells adjacent to the bot's own territory (canTarget), it never flags/chords
// (revealsOnly), and its KNOWN cells are everything claimed on the shared board plus mines it
// has already detonated (so it deduces from the full visible board but expands only its own front).
var territoryBotTimers = appState.territoryBotTimers; // roomId -> { botId: timeoutHandle }
var territoryBotFocus = appState.territoryBotFocus;  // botId -> { r, c } (locality focus persisted across ticks)

function startTerritoryBots(room, tg) {
	territoryBotTimers[room.id] = territoryBotTimers[room.id] || {};
	room.players.forEach(function(pid) { if (isBot(pid)) scheduleTerritoryBot(room, tg, pid); });
}

function territoryBotView(tg, botId) {
	var R = tg.rows, C = tg.cols, state = [];
	for (var r = 0; r < R; r++) {
		state.push(new Array(C));
		for (var c = 0; c < C; c++) {
			var known = tg.owner[r][c] !== null || tg.mineKnown[botId][r + "," + c];
			state[r][c] = known ? BoardLogic.KNOWN : BoardLogic.UNKNOWN;
		}
	}
	return {
		board: tg.board, state: state,
		botMaxDifficulty: botMaxDifficulty[botId],
		botMistakeRate: botMistake[botId],
		botChordRate: 0,
		revealsOnly: true,
		botFocus: territoryBotFocus[botId] || null,
		botDifficultyByCell: null,
		canTarget: function(r, c) { return tg.canReveal(botId, r, c) && !tg.mineKnown[botId][r + "," + c]; }
	};
}

function scheduleTerritoryBot(room, tg, botId) {
	if (!territoryBotTimers[room.id]) territoryBotTimers[room.id] = {};
	// Human "settling in" pause before the very first move — a real player takes a beat to read the
	// board rather than firing instantly. Randomised per bot (1.5–3.5 s) so they don't all start in
	// unison, which is what made the opening feel frantic and robotic.
	var initial = 1500 + Math.floor(Math.random() * 2000);
	territoryBotTimers[room.id][botId] = setTimeout(function tick() {
		if (!rooms[room.id] || room.phase !== "playing" || room.territory !== tg || !tg.playing) { clearTerritoryBots(room.id); return; }
		var now = Date.now();
		var nextDelay = (botSpeedMs[botId] || 400) + Math.floor(Math.random() * 150);
		if (tg.frozen(botId, now)) {
			nextDelay = (tg.frozenUntil[botId] - now) + 150;
		} else {
			var view = territoryBotView(tg, botId);
			var action = botPlayer.decideMove(view);
			territoryBotFocus[botId] = view.botFocus;
			if (action && action.type === "left") {
				tg.reveal(botId, action.r, action.c, now);
				broadcastTerritory(room);
				if (maybeEndTerritory(room)) return;
				// Harder deductions earn a longer pause, mirroring the racing pacing.
				nextDelay += Math.round((botDifficultyMs[botId] || 0) * Math.min(action.difficulty || 0, 8));
			}
		}
		territoryBotTimers[room.id][botId] = setTimeout(tick, nextDelay);
	}, initial);
}
function clearTerritoryBots(roomId) {
	var t = territoryBotTimers[roomId];
	if (!t) return;
	Object.keys(t).forEach(function(b) { clearTimeout(t[b]); });
	delete territoryBotTimers[roomId];
}

// Steady ~1/s heartbeat that advances the energy economy even when nobody is clicking: bank produced
// energy, re-wire the extractor network, and push the updated infra/energy to clients so the HUD counts.
var territoryWorldTimers = appState.territoryWorldTimers; // roomId -> intervalHandle
function startTerritoryWorldTick(room, tg) {
	clearTerritoryWorldTick(room.id);
	territoryWorldTimers[room.id] = setInterval(function() {
		if (!rooms[room.id] || room.phase !== "playing" || room.territory !== tg || !tg.playing) { clearTerritoryWorldTick(room.id); return; }
		tg.tickWorld(Date.now());
		broadcastTerritory(room);
	}, 1000);
}
function clearTerritoryWorldTick(roomId) {
	if (territoryWorldTimers[roomId]) { clearInterval(territoryWorldTimers[roomId]); delete territoryWorldTimers[roomId]; }
}

function broadcastTerritory(room) {
	var tg = room.territory;
	if (!tg) return;
	var now = Date.now();
	tg.accrueEnergy(now); // bank energy up to this instant so the broadcast total is fresh
	var snap = tg.energySnapshot(now);
	var payload = {
		state: tg.state, owner: tg.owner, scores: tg.scores(),
		frozenUntil: tg.frozenUntil, playing: tg.playing,
		roundDeadline: roundDeadlines[room.id] || null,
		structures: tg.structureList(now), // extractors: position, beam recharge + construction state
		energyLines: tg.energyLineList(now), // the auto-wired power grid + its build progress
		energy: snap.energy, energyRate: snap.rate, // banked energy + production rate per player
		claims: tg.claimList(now) // crater cells still reserved for the launcher (the 5s bomb claim lock)
	};
	// A mine explosion re-covered + re-generated a patch this tick — tell clients to patch the
	// changed clues and play the reverse-cascade animation. One-shot, then cleared.
	if (tg._explosion) { payload.explosion = tg._explosion; tg._explosion = null; }
	// An offensive beam fired this tick — tell clients to play the beam + re-cover animation. One-shot.
	if (tg._fire) { payload.fire = tg._fire; tg._fire = null; }
	// An energy bomb was launched this tick — tell clients to animate the missile in flight. One-shot.
	if (tg._missile) { payload.missile = tg._missile; tg._missile = null; }
	io.to("room:" + room.id).emit("territory_board", payload);
}

// End the territory game only when it's genuinely decided: one player left standing (elimination)
// or a true deadlock (nobody can expand and no fort stands to re-open the board). Clearing the board
// is NOT an end — that's when the invasion war begins. Returns true if it ended the game.
function maybeEndTerritory(room) {
	var tg = room.territory;
	if (!tg || !tg.playing) return false;
	if (tg.alive() <= 1) { endTerritoryGame(room, "eliminated"); return true; }
	if (tg.deadlocked()) { endTerritoryGame(room, "deadlock"); return true; }
	return false;
}

function endTerritoryGame(room, reason) {
	clearRoundTimer(room.id);
	clearTerritoryBots(room.id);
	clearTerritoryWorldTick(room.id);
	var tg = room.territory;
	if (!tg) return;
	tg.playing = false;
	var scores = tg.scores();
	// Rank by cells owned (ties share a rank), like the racing standings.
	var ranked = territoryPlayerMeta(room).map(function(m) { return { id: m.id, name: m.name, color: m.color, score: scores[m.id] || 0 }; });
	ranked.sort(function(a, b) { return b.score - a.score; });
	ranked.forEach(function(e, i) { e.rank = (i > 0 && ranked[i - 1].score === e.score) ? ranked[i - 1].rank : i + 1; });
	var winnerId = (ranked.length >= 2 && ranked[0].score !== ranked[1].score) ? ranked[0].id : null;

	// Ranked territory is a single game; apply pairwise Elo on its own "territory" ladder.
	if (room.ranked) {
		var standings = ranked.map(function(e) { return { id: e.id, name: e.name, rank: e.rank }; });
		applyRankedElo(standings, room.rankedStyle || "territory");
		standings.forEach(function(s) {
			var e = ranked.filter(function(x) { return x.id === s.id; })[0];
			if (e) { e.ratingDelta = s.ratingDelta; e.rating = s.rating; e.provisional = s.provisional; }
		});
		room.seriesWinner = winnerId;
	}

	io.to("room:" + room.id).emit("territory_result", {
		reason: reason || "cleared",
		ranked: !!room.ranked,
		scores: ranked.map(function(e) { return { id: e.id, name: e.name, color: e.color, score: e.score, ratingDelta: e.ratingDelta, rating: e.rating, provisional: e.provisional }; }),
		winnerId: winnerId,
		winnerName: winnerId ? names[winnerId] : null,
		totalSafe: tg.totalSafe
	});
	room.territory = null;
	room.phase = "planning";
	broadcastRoomState(room);
	broadcastRoomList();
	// Casual rooms re-arm for another game; ranked rooms are single-match (player leaves/re-queues).
	if (!room.ranked) setTimeout(function() {
		if (!rooms[room.id]) return;
		room.resetReady();
		broadcastRoomState(room);
	}, 1200);
}

// The territory branch of the server's left_click handler delegates here.
function handleReveal(playerID, data) {
	var room = roomMapping[playerID];
	if (!room || room.phase !== "playing") return;
	var tg = room.territory;
	if (!tg || !tg.started || !tg.playing) return;
	var res = tg.reveal(playerID, data.r, data.c, Date.now());
	if (res.type === "invalid") return;
	broadcastTerritory(room);
	maybeEndTerritory(room);
}

// Register the territory-only socket handlers (fire a fort beam / launch an energy bomb)
// for a connected player. Racing/casual sockets just never emit these.
function registerSocketHandlers(socket, playerID) {
	// Fire a structure (left-click on your own surrounded-mine fort) — a directional beam at the nearest enemy.
	socket.on("territory_fire", function(data) {
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing" || room.gameMode !== "territory") return;
		var tg = room.territory;
		if (!tg || !tg.started || !tg.playing) return;
		var res = tg.fireStructure(playerID, data.r, data.c, Date.now());
		if (res.type === "invalid" || res.type === "charging") return;
		broadcastTerritory(room);
		maybeEndTerritory(room);
	});

	// Launch an energy bomb at a target area: spends energy + fires a missile from a random generator; the
	// blast lands after the flight time, re-covering the area to a fresh solvable layout.
	socket.on("territory_bomb", function(data) {
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing" || room.gameMode !== "territory") return;
		var tg = room.territory;
		if (!tg || !tg.started || !tg.playing) return;
		var res = tg.requestBomb(playerID, data.r, data.c, Date.now());
		if (res.type !== "launch") return; // not enough energy, no generator, or out of bounds
		broadcastTerritory(room); // carries the energy spend + the missile to animate
		var target = res.target;
		setTimeout(function() {
			if (!rooms[room.id] || room.phase !== "playing" || room.territory !== tg || !tg.playing) return;
			tg.detonateBomb(target[0], target[1], playerID, Date.now());
			broadcastTerritory(room);
			maybeEndTerritory(room);
		}, res.flightMs);
	});
}

module.exports = {
	init: init,
	dims: territoryDims,
	density: TERRITORY_DENSITY,   // mine density for the ranked territory modes
	startGame: startTerritoryGame,
	endGame: endTerritoryGame,
	broadcast: broadcastTerritory,
	maybeEnd: maybeEndTerritory,
	handleReveal: handleReveal,
	registerSocketHandlers: registerSocketHandlers
};
