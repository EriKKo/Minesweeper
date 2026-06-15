// Session / auth attach, extracted from minesweeperServer. loginSocket binds a (real or
// guest) user to a socket — populating accounts/names, mirroring the name into any live
// game, and emitting the `authenticated` snapshot — and registers the connect-time auth
// socket events (authenticate / guest_session / sign_out / set_name). Reads appState + db
// + roomState + gameUtil; PROVISIONAL_GAMES is injected via init to avoid a circular
// require. (The OAuth redirect flow lives in oauth.js; clients then `authenticate` here.)

var appState = require("./appState");
var db = require("../db");
var roomState = require("./roomState");
var gameUtil = require("./gameUtil");

var accounts = appState.accounts, names = appState.names, games = appState.games, roomMapping = appState.roomMapping, skins = appState.skins;
var updateDraw = gameUtil.updateDraw;

var PROVISIONAL_GAMES;
function init(deps) { PROVISIONAL_GAMES = deps.PROVISIONAL_GAMES; }

function loginSocket(socket, playerID, user, token, sendToken) {
	accounts[playerID] = {
		userId: user.id, token: token, played: user.played,
		ratingSprint: user.rating_sprint, ratingStandard: user.rating_standard,
		ratingTournament: user.rating_tournament, ratingTerritory: user.rating_territory
	};
	var displayName = db.displayNameOf(user); // editable display_name, falling back to the legacy/guest name
	var isFirst = !names[playerID];
	names[playerID] = displayName;
	if (games[playerID]) {
		games[playerID].playerName = displayName;
		updateDraw(roomMapping[playerID]);
	}
	var today = db.todayUtc();
	var dailyAttempt = db.getDailyAttempt(user.id, today);
	var payload = {
		name: displayName,
		ratingSprint: user.rating_sprint, ratingStandard: user.rating_standard,
		ratingTournament: user.rating_tournament, ratingTerritory: user.rating_territory,
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
		guest: !!user.is_guest,
		soloBests: db.getSoloBests(user.id), // { "<size>_<density%>": ms } — Free-play best clear times

		// The provider most recently signed in with (for accounts linked across several) — drives the
		// topbar auth logo. Falls back to the original provider for rows predating last_provider.
		provider: user.last_provider || user.provider
	};
	if (sendToken) payload.token = token;
	socket.emit("authenticated", payload);
	if (isFirst) socket.emit("room_list", { rooms: roomState.getRoomList() });
	else if (roomMapping[playerID]) roomState.broadcastRoomState(roomMapping[playerID]);
}

function registerSocketHandlers(socket, playerID) {
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

	// Board skin: a display preference relayed to opponents so each player's board renders in
	// their own skin. Stored per-player (like names); mirrored into any live game + rebroadcast.
	// The id is just a short slug — the client maps unknown ids to its default skin.
	socket.on("set_skin", function(data) {
		var skin = (data && typeof data.skin === "string") ? data.skin.trim().slice(0, 32) : "";
		if (!/^[a-z0-9_-]*$/i.test(skin)) return;
		skins[playerID] = skin || "classic";
		if (games[playerID]) {
			games[playerID].skin = skins[playerID];
			updateDraw(roomMapping[playerID]);
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
			socket.emit("room_list", { rooms: roomState.getRoomList() });
		} else {
			if (roomMapping[playerID]) roomState.broadcastRoomState(roomMapping[playerID]);
			roomState.broadcastRoomList();
		}
	});

	// Free-play clear: record the best time for this (board size, mine density) and echo it back so the
	// client can show the record / a "new best". Trusts the client's elapsed time — it's an unranked
	// personal stat, not a leaderboard, so there's nothing to game.
	socket.on("solo_result", function(data) {
		if (!accounts[playerID]) return;
		var size = data && data.size;
		var ms = data && parseInt(data.ms, 10);
		var pct = data && Math.round(parseFloat(data.density) * 100);
		if (["small", "medium", "large"].indexOf(size) === -1) return;
		if (!(ms > 0) || !(pct >= 1 && pct <= 100)) return;
		var res = db.recordSoloBest(accounts[playerID].userId, size, pct, ms);
		socket.emit("solo_record", { size: size, density: pct, best: res.best, isNewBest: res.isNewBest });
	});
}

module.exports = { init: init, registerSocketHandlers: registerSocketHandlers };
