var http = require("http")
  , fs = require("fs")
  , path = require("path")
  , crypto = require("node:crypto")
  , gameCreator = require("./GameCreator")
  , roomCreator = require("./RoomCreator")
  , botPlayer = require("./BotPlayer")
  , db = require("./db");

// Load a local .env if present (no-op in production, where env vars are set directly).
try { process.loadEnvFile(); } catch (e) { /* no .env file — fine */ }

// Return the first set value among several candidate env var names, so both the
// conventional UPPER_CASE names and the fly.io secret names work.
function envAny() {
	for (var i = 0; i < arguments.length; i++) {
		if (process.env[arguments[i]]) return process.env[arguments[i]];
	}
	return "";
}

var COUNT_DOWN_TIME = 3;
var BETWEEN_GAMES_DELAY = 3000;
var SERIES_END_DELAY = 6000;
var PROVISIONAL_GAMES = 10;

var PORT = process.env.PORT || 1337;
var OAUTH_BASE = process.env.OAUTH_REDIRECT_BASE || ("http://localhost:" + PORT);
var GITHUB_CLIENT_ID = envAny("GITHUB_CLIENT_ID", "GITHUB_AUTH_CLIENT_ID", "github_auth_client_id");
var GITHUB_CLIENT_SECRET = envAny("GITHUB_CLIENT_SECRET", "GITHUB_AUTH_CLIENT_SECRET", "github_auth_client_secret");
var GOOGLE_CLIENT_ID = envAny("GOOGLE_CLIENT_ID", "GOOGLE_AUTH_CLIENT_ID", "google_auth_client_id");
var GOOGLE_CLIENT_SECRET = envAny("GOOGLE_CLIENT_SECRET", "GOOGLE_AUTH_CLIENT_SECRET", "google_auth_client_secret");
var DEV_AUTH = process.env.DEV_AUTH === "1";
var oauthStates = {}; // state -> expiry ms

var app = http.createServer(handler);
var io = require("socket.io")(app);

function handler (req, res) {
	var url = new URL(req.url, OAUTH_BASE);
	var pathname = url.pathname;
	if (pathname === "/auth/github/login") return authGithubLogin(req, res);
	if (pathname === "/auth/github/callback") return authGithubCallback(req, res, url);
	if (pathname === "/auth/google/login") return authGoogleLogin(req, res);
	if (pathname === "/auth/google/callback") return authGoogleCallback(req, res, url);
	if (DEV_AUTH && pathname === "/auth/dev") return authDev(req, res, url);

	var filePath = "." + pathname;
	if (filePath == "./") {
		filePath = "./minesweeperClient.html";
	}
	var extension = path.extname(filePath);
	var contentType = "text/html";
	if (extension == ".js") {
		contentType = "text/javascript";
	} else if (extension == ".css") {
		contentType = "text/css";
	}
	fs.access(filePath, fs.constants.R_OK, function(err) {
		if (err) {
			res.writeHead(404);
			res.end();
			return;
		}
		fs.readFile(filePath, function(err, data) {
			if (err) {
				res.writeHead(500);
				res.end("Error while loading "+filePath);
			} else {
				res.writeHead(200, { "Content-Type" : contentType});
				res.end(data);
			}
		});
	});
}

function authGithubLogin(req, res) {
	if (!GITHUB_CLIENT_ID) { res.writeHead(500); res.end("GitHub OAuth is not configured (set GITHUB_CLIENT_ID/SECRET)."); return; }
	var state = crypto.randomBytes(16).toString("hex");
	oauthStates[state] = Date.now() + 10 * 60 * 1000;
	var params = new URLSearchParams({
		client_id: GITHUB_CLIENT_ID,
		redirect_uri: OAUTH_BASE + "/auth/github/callback",
		scope: "read:user",
		state: state
	});
	res.writeHead(302, { Location: "https://github.com/login/oauth/authorize?" + params.toString() });
	res.end();
}

function authGithubCallback(req, res, url) {
	var code = url.searchParams.get("code");
	var state = url.searchParams.get("state");
	if (!state || !oauthStates[state] || oauthStates[state] < Date.now()) { res.writeHead(400); res.end("Invalid OAuth state"); return; }
	delete oauthStates[state];
	if (!code) { res.writeHead(400); res.end("Missing code"); return; }
	(async function() {
		try {
			var tokenResp = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: { "Accept": "application/json", "Content-Type": "application/json" },
				body: JSON.stringify({
					client_id: GITHUB_CLIENT_ID,
					client_secret: GITHUB_CLIENT_SECRET,
					code: code,
					redirect_uri: OAUTH_BASE + "/auth/github/callback"
				})
			});
			var tokenJson = await tokenResp.json();
			var accessToken = tokenJson.access_token;
			if (!accessToken) { res.writeHead(401); res.end("OAuth token exchange failed"); return; }
			var ghResp = await fetch("https://api.github.com/user", {
				headers: { "Authorization": "Bearer " + accessToken, "User-Agent": "minesweeper", "Accept": "application/vnd.github+json" }
			});
			var gh = await ghResp.json();
			var user = db.upsertUser("github", gh.id, gh.name || gh.login || ("user" + gh.id), gh.avatar_url);
			finishLogin(res, user.id);
		} catch (e) {
			console.error("github oauth error", e);
			res.writeHead(500); res.end("OAuth error");
		}
	})();
}

function authGoogleLogin(req, res) {
	if (!GOOGLE_CLIENT_ID) { res.writeHead(500); res.end("Google OAuth is not configured (set GOOGLE_CLIENT_ID/SECRET)."); return; }
	var state = crypto.randomBytes(16).toString("hex");
	oauthStates[state] = Date.now() + 10 * 60 * 1000;
	var params = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		redirect_uri: OAUTH_BASE + "/auth/google/callback",
		response_type: "code",
		scope: "openid email profile",
		state: state
	});
	res.writeHead(302, { Location: "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString() });
	res.end();
}

function authGoogleCallback(req, res, url) {
	var code = url.searchParams.get("code");
	var state = url.searchParams.get("state");
	if (!state || !oauthStates[state] || oauthStates[state] < Date.now()) { res.writeHead(400); res.end("Invalid OAuth state"); return; }
	delete oauthStates[state];
	if (!code) { res.writeHead(400); res.end("Missing code"); return; }
	(async function() {
		try {
			var tokenResp = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
				body: new URLSearchParams({
					code: code,
					client_id: GOOGLE_CLIENT_ID,
					client_secret: GOOGLE_CLIENT_SECRET,
					redirect_uri: OAUTH_BASE + "/auth/google/callback",
					grant_type: "authorization_code"
				}).toString()
			});
			var tokenJson = await tokenResp.json();
			var accessToken = tokenJson.access_token;
			if (!accessToken) { res.writeHead(401); res.end("OAuth token exchange failed"); return; }
			var uResp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
				headers: { "Authorization": "Bearer " + accessToken }
			});
			var g = await uResp.json();
			var user = db.upsertUser("google", g.sub, g.name || g.email || ("user" + g.sub), g.picture);
			finishLogin(res, user.id);
		} catch (e) {
			console.error("google oauth error", e);
			res.writeHead(500); res.end("OAuth error");
		}
	})();
}

function authDev(req, res, url) {
	var name = (url.searchParams.get("name") || "Dev").slice(0, 24);
	var user = db.upsertUser("dev", name.toLowerCase(), name, null);
	finishLogin(res, user.id);
}

function finishLogin(res, userId) {
	var token = db.createSession(userId);
	res.writeHead(302, { Location: OAUTH_BASE + "/#token=" + token });
	res.end();
}

var games = {};
var roomMapping = {};
var rooms = {};
var nextRoomId = 1;
var sockets = {};
var names = {};
var accounts = {}; // socketId -> { userId, token } for signed-in players
var nextGameTimers = {};
var roundTimers = {};
var roundDeadlines = {};
var roundStarts = {}; // roomId -> ms timestamp when the current round's play began
var bots = {}; // botId -> true
var botDifficulty = {}; // botId -> "easy" | "medium" | "hard" (casual rooms)
var botSpeedMs = {}; // botId -> ms between actions
var botRating = {}; // botId -> Elo used for ranked rating math
var botTickHandles = {}; // botId -> setTimeout handle
var botLastClick = {}; // botId -> {r, c} of the bot's most recent click in the current round
var nextBotId = 1;
var MAX_BOTS_PER_ROOM = 3;

// Ranked matchmaking
var RANKED_MATCH_SIZE = 4;
var RANKED_RULES = { gameCount: 5, roundSeconds: 120, deathPenalty: 5, mineCount: 30 };
var RANKED_BOT_RATING = 1000;
// Bots "join" the queue one at a time at random intervals so it reads like real
// players trickling in, rather than all appearing at a fixed deadline.
var BOT_JOIN_MIN_MS = 1500;
var BOT_JOIN_MAX_MS = 4200;
var rankedQueue = []; // socketIds of signed-in players searching
var pendingBots = 0;  // bots that have "arrived" so far this search
var rankedFillTimer = null;

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
		phase: room.phase,
		gameCount: room.gameCount,
		gamesPlayed: room.gamesPlayed,
		roundSeconds: room.roundSeconds,
		deathPenalty: room.deathPenalty,
		mineCount: room.mineCount,
		roundDeadline: roundDeadlines[room.id] || null,
		lastGameWinner: room.lastGameWinner,
		lastGameWinnerName: room.lastGameWinner ? names[room.lastGameWinner] : null,
		seriesWinner: room.seriesWinner,
		seriesWinnerName: room.seriesWinner ? names[room.seriesWinner] : null,
		gameCountOptions: room.gameCountOptions,
		roundSecondsOptions: room.roundSecondsOptions,
		deathPenaltyOptions: room.deathPenaltyOptions,
		mineCountOptions: room.mineCountOptions,
		botDifficultyOptions: botPlayer.DIFFICULTIES,
		botCount: room.players.filter(function(pid) { return isBot(pid); }).length,
		maxBots: MAX_BOTS_PER_ROOM,
		players: room.players.map(function(pid) {
			var g = games[pid];
			return {
				id: pid,
				name: names[pid] || "Anonymous",
				ready: room.isReady(pid),
				score: room.scores[pid] || 0,
				isOwner: pid === room.owner,
				isBot: isBot(pid),
				difficulty: isBot(pid) ? (botDifficulty[pid] || null) : null,
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

function clearBotTick(botId) {
	if (botTickHandles[botId]) {
		clearTimeout(botTickHandles[botId]);
		delete botTickHandles[botId];
	}
}

function clearRoomBotTicks(room) {
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (isBot(pid)) clearBotTick(pid);
	}
}

function readyAllBots(room) {
	for (var i = 0; i < room.players.length; i++) {
		if (isBot(room.players[i])) room.playerReady(room.players[i]);
	}
}

function scheduleBotTick(room, botId) {
	clearBotTick(botId);
	if (!rooms[room.id]) return;
	if (roomMapping[botId] !== room) return;
	if (room.phase !== "playing") return;
	var game = games[botId];
	if (!game || !game.playing) return;

	var now = Date.now();
	if (now < game.frozenUntil) {
		botTickHandles[botId] = setTimeout(function() {
			delete botTickHandles[botId];
			scheduleBotTick(room, botId);
		}, game.frozenUntil - now + 50);
		return;
	}

	var move;
	try {
		move = botPlayer.decideMove(game);
	} catch (e) {
		console.error("bot decideMove error", e);
		return;
	}
	if (!move) return;

	var baseMs = botSpeedMs[botId] || botPlayer.speedFor(botDifficulty[botId]);
	var delay = botPlayer.computeMoveDelay(baseMs, botLastClick[botId] || null, move);
	botTickHandles[botId] = setTimeout(function() {
		delete botTickHandles[botId];
		runBotMove(room, botId, move);
	}, delay);
}

function runBotMove(room, botId, move) {
	if (!rooms[room.id]) return;
	if (roomMapping[botId] !== room) return;
	if (room.phase !== "playing") return;
	var game = games[botId];
	if (!game || !game.playing) return;
	if (Date.now() < game.frozenUntil) {
		// got frozen while waiting — re-plan after the freeze ends
		scheduleBotTick(room, botId);
		return;
	}
	try {
		if (move.type === "left") game.handleLeftClick(move.r, move.c);
		else if (move.type === "right") game.handleRightClick(move.r, move.c);
		botLastClick[botId] = { r: move.r, c: move.c };
		updateDraw(room);
	} catch (e) {
		console.error("bot runMove error", e);
	}
	if (game.playing) {
		scheduleBotTick(room, botId);
	}
}

function startBotTicksForRoom(room) {
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (isBot(pid)) {
			// New round — bot hasn't looked at the board yet
			delete botLastClick[pid];
			scheduleBotTick(room, pid);
		}
	}
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

function addBotToRoom(room, config) {
	if (room.phase !== "planning") return false;
	if (room.isFull()) return false;
	if (botCount(room) >= MAX_BOTS_PER_ROOM) return false;
	var botId = "bot:" + (nextBotId++);
	bots[botId] = true;
	names[botId] = botPlayer.pickBotName(getRoomBotNames(room));
	games[botId] = createPlayerGame(botId);
	if (config) {
		// Elo-tuned bot (ranked): explicit speed, mistake rate, and rating.
		botDifficulty[botId] = null;
		botSpeedMs[botId] = config.speedMs;
		botRating[botId] = config.rating;
		games[botId].botMistakeRate = config.mistakeRate;
	} else {
		botDifficulty[botId] = botPlayer.DEFAULT_DIFFICULTY;
		botSpeedMs[botId] = botPlayer.speedFor(botDifficulty[botId]);
		games[botId].botMistakeRate = botPlayer.mistakeRateFor(botDifficulty[botId]);
	}
	roomMapping[botId] = room;
	room.addPlayer(botId);
	room.playerReady(botId);
	return true;
}

function removeOneBotFromRoom(room) {
	for (var i = room.players.length - 1; i >= 0; i--) {
		var pid = room.players[i];
		if (isBot(pid)) {
			removeBotEntirely(pid);
			return true;
		}
	}
	return false;
}

function removeBotEntirely(botId) {
	var room = roomMapping[botId];
	clearBotTick(botId);
	if (room) room.deletePlayer(botId);
	delete roomMapping[botId];
	delete games[botId];
	delete names[botId];
	delete bots[botId];
	delete botDifficulty[botId];
	delete botSpeedMs[botId];
	delete botRating[botId];
	delete botLastClick[botId];
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
			sockets[playerID].emit("draw_board", {games: getGamesWithPlayerOnTop(playerID, room.players)});
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
		return {
			id: pid,
			name: names[pid] || "Anonymous",
			safeCount: g ? g.revealedSafeCount() : 0,
			finished: finished,
			finishedAt: finishedAt,
			finishMs: (finished && roundStart && finishedAt) ? (finishedAt - roundStart) : null
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

// Pairwise Elo over the round's standings. Each pair of players is a mini-match;
// a player's delta is K * mean(score - expected) across opponents (so a round's
// swing stays ~K regardless of lobby size). Bots use a fixed rating and aren't
// persisted. Mutates human standings entries with ratingDelta/rating/provisional.
function applyRankedElo(standings) {
	var parts = standings.map(function(s) {
		var bot = isBot(s.id);
		var acc = accounts[s.id];
		var rating = bot ? (botRating[s.id] || RANKED_BOT_RATING) : RANKED_BOT_RATING, userId = null, played = 0;
		if (!bot && acc) {
			var u = db.getUserById(acc.userId);
			if (u) { rating = u.rating; userId = acc.userId; played = u.played; }
		}
		return { rank: s.rank, rating: rating, bot: bot, userId: userId, played: played, delta: null, newRating: null, provisional: false };
	});
	var n = parts.length;
	if (n < 2) return;
	for (var i = 0; i < n; i++) {
		var p = parts[i];
		if (p.bot || !p.userId) continue;
		var sum = 0;
		for (var j = 0; j < n; j++) {
			if (i === j) continue;
			var q = parts[j];
			var score = p.rank < q.rank ? 1 : p.rank > q.rank ? 0 : 0.5;
			var expected = 1 / (1 + Math.pow(10, (q.rating - p.rating) / 400));
			sum += score - expected;
		}
		var K = p.played < PROVISIONAL_GAMES ? 40 : 20;
		p.delta = Math.round(K * sum / (n - 1));
		p.newRating = p.rating + p.delta;
		p.provisional = (p.played + 1) < PROVISIONAL_GAMES;
		db.updateRating(p.userId, p.newRating, p.rank === 1);
	}
	for (var k = 0; k < standings.length; k++) {
		if (!parts[k].bot && parts[k].userId) {
			standings[k].ratingDelta = parts[k].delta;
			standings[k].rating = parts[k].newRating;
			standings[k].provisional = parts[k].provisional;
		}
	}
}

function endIndividualGame(room, reason) {
	if (room.phase !== "playing") return;
	clearRoundTimer(room.id);
	clearRoomBotTicks(room);
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
	if (room.ranked) applyRankedElo(standings);
	io.to("room:" + room.id).emit("game_result", {
		winnerId: winnerID,
		winnerName: winnerID ? names[winnerID] : null,
		gameNumber: room.gamesPlayed,
		gameCount: room.gameCount,
		reason: reason || "cleared",
		standings: standings
	});
	broadcastRoomState(room);

	if (room.gamesPlayed >= room.gameCount) {
		endSeries(room);
	} else {
		nextGameTimers[room.id] = setTimeout(function() {
			delete nextGameTimers[room.id];
			if (rooms[room.id] && room.phase === "playing" && room.players.length > 1) {
				startGame(room);
			} else if (rooms[room.id] && room.players.length <= 1) {
				endSeries(room);
			}
		}, BETWEEN_GAMES_DELAY);
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
	room.seriesWinner = computeSeriesWinner(room);
	room.phase = "planning";
	io.to("room:" + room.id).emit("series_ended", {
		winnerId: room.seriesWinner,
		winnerName: room.seriesWinner ? names[room.seriesWinner] : null,
		scores: room.players.map(function(pid) {
			return { id: pid, name: names[pid] || "Anonymous", score: room.scores[pid] || 0 };
		})
	});
	broadcastRoomState(room);
	broadcastRoomList();

	setTimeout(function() {
		if (!rooms[room.id]) return;
		room.resetScores();
		room.resetReady();
		readyAllBots(room);
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

	// First finish in this round? Pull the remaining time down to 20s so others
	// still in play have a hard deadline to also clear.
	if (countFinishedPlayers(room) === 1) {
		reduceRoundDeadline(room, 20);
	}

	if (isBot(playerID)) {
		clearBotTick(playerID);
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
	clearRoundTimer(room.id);
	var centerR = Math.floor(gameCreator.rows / 2);
	var centerC = Math.floor(gameCreator.cols / 2);
	var template = gameCreator.createNoGuessTemplate(centerR, centerC, room.mineCount);
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (!games[pid]) {
			games[pid] = createPlayerGame(pid);
		}
		games[pid].init(template);
	}
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		if (sockets[pid]) {
			sockets[pid].emit("start_game", {
				time: COUNT_DOWN_TIME,
				gameNumber: room.gamesPlayed + 1,
				gameCount: room.gameCount,
				roundSeconds: room.roundSeconds,
				deathPenalty: room.deathPenalty
			});
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
		startBotTicksForRoom(room);
	}, COUNT_DOWN_TIME * 1000);
}

function startSeries(room) {
	room.startSeries();
	broadcastRoomState(room);
	broadcastRoomList();
	startGame(room);
}

// ---- Ranked matchmaking ------------------------------------------------
function rankedCount() { return rankedQueue.length + pendingBots; }

function broadcastRankedQueue() {
	for (var i = 0; i < rankedQueue.length; i++) {
		var s = sockets[rankedQueue[i]];
		if (s) s.emit("ranked_searching", { count: rankedCount(), size: RANKED_MATCH_SIZE });
	}
}

function clearRankedFill() {
	if (rankedFillTimer) { clearTimeout(rankedFillTimer); rankedFillTimer = null; }
}

function scheduleBotArrival() {
	if (rankedFillTimer) return;
	var delay = BOT_JOIN_MIN_MS + Math.floor(Math.random() * (BOT_JOIN_MAX_MS - BOT_JOIN_MIN_MS));
	rankedFillTimer = setTimeout(function() {
		rankedFillTimer = null;
		if (rankedQueue.length === 0) { pendingBots = 0; return; } // everyone left
		pendingBots++;
		if (rankedCount() >= RANKED_MATCH_SIZE) {
			formRankedMatch();
		} else {
			broadcastRankedQueue();
			scheduleBotArrival();
		}
	}, delay);
}

function enqueueRanked(playerID) {
	if (!accounts[playerID]) return;          // ranked requires a signed-in account
	if (roomMapping[playerID]) return;         // already in a room
	if (rankedQueue.indexOf(playerID) !== -1) return;
	rankedQueue.push(playerID);
	if (rankedCount() >= RANKED_MATCH_SIZE) {
		formRankedMatch();
	} else {
		broadcastRankedQueue();
		scheduleBotArrival();
	}
}

function dequeueRanked(playerID) {
	var idx = rankedQueue.indexOf(playerID);
	if (idx === -1) return;
	rankedQueue.splice(idx, 1);
	if (rankedQueue.length === 0) {
		clearRankedFill();
		pendingBots = 0;
	} else {
		broadcastRankedQueue();
	}
}

function formRankedMatch() {
	clearRankedFill();
	pendingBots = 0;

	var humans = [];
	while (rankedQueue.length && humans.length < RANKED_MATCH_SIZE) {
		var pid = rankedQueue.shift();
		if (sockets[pid] && accounts[pid] && !roomMapping[pid]) humans.push(pid);
	}
	if (humans.length === 0) return;

	var id = nextRoomId++;
	var room = roomCreator.createRoom(id, humans[0]);
	room.ranked = true;
	room.gameCount = RANKED_RULES.gameCount;
	room.roundSeconds = RANKED_RULES.roundSeconds;
	room.deathPenalty = RANKED_RULES.deathPenalty;
	room.mineCount = RANKED_RULES.mineCount;
	rooms[id] = room;

	for (var i = 0; i < humans.length; i++) {
		var hid = humans[i];
		var socket = sockets[hid];
		games[hid] = createPlayerGame(hid);
		roomMapping[hid] = room;
		room.addPlayer(hid);
		socket.leave("lobby");
		socket.join("room:" + room.id);
		socket.emit("joined_room", { roomId: room.id, ranked: true });
	}

	// Tune filler bots to the lobby's average human rating, each with its own style.
	var sumElo = 0, eloCount = 0;
	for (var h = 0; h < humans.length; h++) {
		var acc = accounts[humans[h]];
		var u = acc ? db.getUserById(acc.userId) : null;
		if (u) { sumElo += u.rating; eloCount++; }
	}
	var targetElo = eloCount ? Math.round(sumElo / eloCount) : 1000;

	while (room.players.length < RANKED_MATCH_SIZE && botCount(room) < MAX_BOTS_PER_ROOM) {
		if (!addBotToRoom(room, botPlayer.configForElo(targetElo))) break;
	}

	for (var j = 0; j < room.players.length; j++) room.playerReady(room.players[j]);
	broadcastRoomState(room);
	startSeries(room);

	if (rankedQueue.length > 0) {
		broadcastRankedQueue();
		scheduleBotArrival();
	}
}

function createPlayerGame(playerID) {
	var game = gameCreator.createGame();
	game.playerName = names[playerID] || "Anonymous";
	game.win = function() { gameWin(playerID); };
	game.mineHit = function() { gameMineHit(playerID); };
	return game;
}

function addPlayerToRoom(socket, room) {
	var playerID = socket.id;
	games[playerID] = createPlayerGame(playerID);
	roomMapping[playerID] = room;
	room.addPlayer(playerID);

	socket.leave("lobby");
	socket.join("room:" + room.id);
	socket.emit("joined_room", { roomId: room.id });
	broadcastRoomState(room);
	broadcastRoomList();
}

function removePlayerFromRoom(playerID) {
	var room = roomMapping[playerID];
	if (!room) return;
	var wasPlaying = room.phase === "playing";
	room.deletePlayer(playerID);
	delete roomMapping[playerID];
	delete games[playerID];
	if (sockets[playerID]) {
		sockets[playerID].leave("room:" + room.id);
	}

	// If no humans remain, evict all bots so the room can be cleaned up.
	if (humanCount(room) === 0) {
		while (botCount(room) > 0) {
			removeOneBotFromRoom(room);
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
}

io.on("connection", function (socket) {
	var playerID = socket.id;
	sockets[playerID] = socket;
	socket.join("lobby");
	socket.emit("connected", { id: playerID, oauth: { github: !!GITHUB_CLIENT_ID, google: !!GOOGLE_CLIENT_ID, dev: DEV_AUTH } });

	socket.on("authenticate", function(data) {
		var token = data && data.token;
		var user = db.getUserByToken(token);
		if (!user) { socket.emit("auth_failed"); return; }
		accounts[playerID] = { userId: user.id, token: token };
		var isFirst = !names[playerID];
		names[playerID] = user.name;
		if (games[playerID]) {
			games[playerID].playerName = user.name;
			updateDraw(roomMapping[playerID]);
		}
		socket.emit("authenticated", {
			name: user.name,
			rating: user.rating,
			avatarUrl: user.avatar_url,
			wins: user.wins,
			played: user.played,
			provisional: user.played < PROVISIONAL_GAMES
		});
		if (isFirst) socket.emit("room_list", { rooms: getRoomList() });
		else if (roomMapping[playerID]) broadcastRoomState(roomMapping[playerID]);
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

	socket.on("find_ranked", function() {
		if (!accounts[playerID]) { socket.emit("ranked_rejected", { reason: "Sign in to play ranked." }); return; }
		if (roomMapping[playerID]) return;
		enqueueRanked(playerID);
	});

	socket.on("cancel_ranked", function() {
		dequeueRanked(playerID);
	});

	socket.on("get_leaderboard", function() {
		socket.emit("leaderboard", { players: db.topPlayers(20), provisionalGames: PROVISIONAL_GAMES });
	});

	socket.on("create_room", function() {
		if (!names[playerID]) return;
		if (roomMapping[playerID]) return;
		var id = nextRoomId++;
		var room = roomCreator.createRoom(id, playerID);
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
		removePlayerFromRoom(playerID);
		if (socketRef) {
			socketRef.join("lobby");
			socketRef.emit("left_room");
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

	socket.on("set_mine_count", function(data) {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		var count = data && parseInt(data.count, 10);
		if (room.setMineCount(count)) {
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
		botSpeedMs[botId] = botPlayer.speedFor(difficulty);
		if (games[botId]) games[botId].botMistakeRate = botPlayer.mistakeRateFor(difficulty);
		broadcastRoomState(room);
	});

	socket.on("add_bot", function() {
		var room = roomMapping[playerID];
		if (!room) return;
		if (room.owner !== playerID) return;
		if (!addBotToRoom(room)) return;
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
		if (!removeOneBotFromRoom(room)) return;
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
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleRightClick(data.r, data.c);
		updateDraw(room);
	});

	socket.on("left_click", function(data) {
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
		var game = games[playerID];
		if (!game || !game.playing || Date.now() < game.frozenUntil) return;
		game.handleLeftClick(data.r, data.c);
		updateDraw(room);
	});

	socket.on("disconnect", function() {
		dequeueRanked(playerID);
		if (roomMapping[playerID]) {
			removePlayerFromRoom(playerID);
		}
		delete sockets[playerID];
		delete names[playerID];
		delete accounts[playerID]; // session stays valid in the DB for reconnect
	});
});

app.listen(PORT, "0.0.0.0", function() {
	console.log("listening on " + PORT);
});
