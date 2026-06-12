// Session / auth attach, extracted from minesweeperServer. loginSocket binds a (real or
// guest) user to a socket — populating accounts/names, mirroring the name into any live
// game, and emitting the `authenticated` snapshot — and registers the connect-time auth
// socket events (authenticate / guest_session / sign_out / set_name). Reads appState + db
// + roomState; updateDraw + PROVISIONAL_GAMES are injected via init to avoid a circular
// require. (The OAuth redirect flow lives in oauth.js; clients then `authenticate` here.)

var appState = require("./appState");
var db = require("./db");
var roomState = require("./roomState");

var accounts = appState.accounts, names = appState.names, games = appState.games, roomMapping = appState.roomMapping;

var updateDraw, PROVISIONAL_GAMES;
function init(deps) { updateDraw = deps.updateDraw; PROVISIONAL_GAMES = deps.PROVISIONAL_GAMES; }

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
}

module.exports = { init: init, registerSocketHandlers: registerSocketHandlers };
