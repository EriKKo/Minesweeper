// Session / auth attach, extracted from minesweeperServer. loginSocket binds a (real or
// guest) user to a socket — populating accounts/names, mirroring the name into any live
// game, and emitting the `authenticated` snapshot — and registers the connect-time auth
// socket events (authenticate / guest_session / sign_out / set_name). Reads appState + db
// + roomState + gameUtil; PROVISIONAL_GAMES is injected via init to avoid a circular
// require. (The OAuth redirect flow lives in oauth.js; clients then `authenticate` here.)

var appState = require("./appState");
var db = require("../db");
var zlib = require("zlib");
var roomState = require("./roomState");
var gameUtil = require("./gameUtil");

var accounts = appState.accounts, names = appState.names, games = appState.games, roomMapping = appState.roomMapping, skins = appState.skins;
var avatars = appState.avatars, countries = appState.countries;
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
	// Guests with no chosen avatar default to the anonymous silhouette (others fall back to the red flag).
	var avatarColor = user.avatar_color || (user.is_guest ? "anon" : null);
	avatars[playerID] = avatarColor;
	countries[playerID] = user.country || null;
	if (games[playerID]) {
		games[playerID].playerName = displayName;
		games[playerID].avatar = avatars[playerID];
		games[playerID].country = countries[playerID];
		updateDraw(roomMapping[playerID]);
	}
	var today = db.todayUtc();
	var dailyAttempt = db.getDailyAttempt(user.id, today);
	var payload = {
		name: displayName,
		ratingSprint: user.rating_sprint, ratingStandard: user.rating_standard,
		ratingTournament: user.rating_tournament, ratingTerritory: user.rating_territory,
		avatarUrl: user.avatar_url,
		avatarColor: avatarColor,
		country: user.country || null,
		wins: user.wins,
		played: user.played,
		createdAt: user.created_at, // for "Member since" on the profile
		provisional: user.played < PROVISIONAL_GAMES,
		puzzleRating: user.puzzle_rating,
		puzzlePoints: user.puzzle_points || 0,
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

	// Avatar cloth colour (the in-game flag, recoloured). Persisted on the account + mirrored to opponents.
	socket.on("set_avatar", function(data) {
		var acc = accounts[playerID];
		if (!acc) return;
		var color = (data && typeof data.color === "string") ? data.color.trim() : "";
		// A #rrggbb cloth colour, the "anon" silhouette, or an "img:<id>" preset (or "" to clear → default red).
		if (color && color !== "anon" && !/^#[0-9a-f]{6}$/i.test(color) && !/^img:[a-z0-9_-]+$/i.test(color)) return;
		var value = color || null;
		db.setAvatarColor(acc.userId, value);
		avatars[playerID] = value;
		if (games[playerID]) { games[playerID].avatar = value; updateDraw(roomMapping[playerID]); }
	});

	// Country (ISO-3166 alpha-2). Persisted on the account + mirrored to opponents.
	socket.on("set_country", function(data) {
		var acc = accounts[playerID];
		if (!acc) return;
		var country = (data && typeof data.country === "string") ? data.country.trim().toUpperCase() : "";
		if (country && !/^[A-Z]{2}$/.test(country)) return; // two letters, or "" to clear
		var value = country || null;
		db.setCountry(acc.userId, value);
		countries[playerID] = value;
		if (games[playerID]) { games[playerID].country = value; updateDraw(roomMapping[playerID]); }
	});

	// A solo/racing board cleared with no flag and/or no direct reveal (chord only) — challenge counters.
	socket.on("record_clear", function(data) {
		var acc = accounts[playerID];
		if (acc && data) db.recordClear(acc.userId, !!data.noFlag, !!data.noReveal);
	});

	// Profile: recent ranked matches + per-style rating points (graph). Empty for signed-out.
	socket.on("get_match_history", function() {
		var acc = accounts[playerID];
		if (!acc) { socket.emit("match_history", { matches: [], ratings: [], stats: {} }); return; }
		socket.emit("match_history", {
			matches: db.getMatchHistory(acc.userId, 50),
			ratings: db.getRatingHistory(acc.userId, 1000),
			stats: db.achievementStats(acc.userId) // achievement metrics bag
		});
	});

	// Profile: fetch one replay for playback. We gunzip server-side and ship the raw binary
	// (input-log format) so the client only needs the decoder, not a gzip dependency. Only a
	// participant in the match may fetch it.
	socket.on("get_replay", function(data) {
		var acc = accounts[playerID];
		var id = data && data.id;
		if (!acc || !id) { socket.emit("replay_data", { id: id || null, error: "not_found" }); return; }
		var mine = db.listReplaysForUser(acc.userId, 500).some(function(r) { return r.id === id; });
		if (!mine) { socket.emit("replay_data", { id: id, error: "forbidden" }); return; }
		var row = db.getReplay(id);
		if (!row) { socket.emit("replay_data", { id: id, error: "not_found" }); return; }
		var raw;
		try { raw = zlib.gunzipSync(row.data); } catch (e) { socket.emit("replay_data", { id: id, error: "corrupt" }); return; }
		socket.emit("replay_data", {
			id: id, createdAt: row.created_at, style: row.style, mode: row.mode,
			winnerId: row.winner_id, players: row.players ? JSON.parse(row.players) : [],
			data: raw // Buffer → socket.io sends as binary; arrives as ArrayBuffer on the client
		});
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
