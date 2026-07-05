// Replay capture for ranked matches.
//
// Format (v1) — an INPUT LOG, not a state log: we store the mine layout per round plus the ordered
// list of each player's APPLIED clicks, and re-simulate the cascades at playback time. This is far
// smaller than snapshotting board state. Each event is `varint(dt_ms) + varint(cell<<1 | button)`
// (~2-3 bytes); button is 1 bit (0=left, 1=right) and reveal-vs-chord is decided by board state on
// replay. A whole match is a few KB gzipped.
//
// Lifecycle (driven from minesweeperServer):
//   startMatch(room)                  -> at series start, for ranked non-territory rooms
//   startRound(room, template, r, c)  -> at each round's startGame, snapshots the mine bitmask
//   attach(room, game, pid)           -> wires game.onMove for one player's game this round
//   finishMatch(room, standings)      -> at series end: serialize + gzip + persist, then clear
//
// The accumulator lives on `room.replay`; nothing is written until the match ends.

var zlib = require("zlib");
var db = require("../db");
var appState = require("./appState");
var gameUtil = require("./gameUtil");

// v2 added a per-player board-skin id; v3 adds avatar cloth colour + country code (older readers default).
var REPLAY_VERSION = 3;

function shouldCapture(room) {
	return !!(room && room.ranked && room.rankedMode !== "territory" && room.gameMode !== "territory");
}

// Resolve a stable descriptor for a player id (name / bot flag / signed-in user id).
function describePlayer(pid) {
	var acc = appState.accounts[pid];
	return {
		pid: pid,
		name: appState.names[pid] || "Anonymous",
		isBot: !!gameUtil.isBot(pid),
		userId: (acc && acc.userId) || null,
		skin: appState.skins[pid] || null, // board skin active at match time (null → default/classic)
		avatar: appState.avatars[pid] || null, // avatar cloth colour
		country: appState.countries[pid] || null // ISO country code
	};
}

// Begin a match accumulator. Captured roster is the players present at series start; recordMove
// lazily appends any pid not yet seen (defensive — ranked rosters don't grow mid-match).
function startMatch(room) {
	if (!shouldCapture(room)) { room.replay = null; return; }
	var mines = Math.round(room.mineDensity * room.rows * room.cols);
	var players = [], index = {};
	for (var i = 0; i < room.players.length; i++) {
		var d = describePlayer(room.players[i]);
		index[d.pid] = players.length;
		players.push(d);
	}
	room.replay = {
		style: room.rankedStyle || room.rankedMode || null,
		mode: room.rankedMode || null,
		rows: room.rows,
		cols: room.cols,
		mineCount: mines,
		createdAt: Date.now(),
		players: players,
		index: index,
		rounds: [],
		cur: null
	};
}

// Snapshot the round's mine layout + pre-revealed opening, and open a fresh per-player event log.
// Two bitmasks: `mines` (where the bombs are) and `known` (the no-guess opening cells `init` reveals
// before any click). Playback needs both — without `known` the re-simulated board starts fully covered
// and diverges from what the players actually saw.
function startRound(room, template, startR, startC) {
	var rp = room.replay;
	if (!rp) return;
	var rows = rp.rows, cols = rp.cols;
	var board = template.board;
	var bytes = Math.ceil((rows * cols) / 8);
	var mines = new Uint8Array(bytes);
	for (var r = 0; r < rows; r++) {
		for (var c = 0; c < cols; c++) {
			if (board[r][c] < 0) {
				var idx = r * cols + c;
				mines[idx >> 3] |= (1 << (idx & 7));
			}
		}
	}
	var known = new Uint8Array(bytes);
	var kc = template.knownCells || [];
	for (var k = 0; k < kc.length; k++) {
		var ki = kc[k][0] * cols + kc[k][1];
		known[ki >> 3] |= (1 << (ki & 7));
	}
	rp.cur = { mines: mines, known: known, startR: startR, startC: startC, t0: null, tracks: {} };
	rp.rounds.push(rp.cur);
}

// Wire a player's game so each applied move is logged into the current round.
function attach(room, game, pid) {
	var rp = room.replay;
	if (!rp) return;
	game.onMove = function(button, r, c) {
		var cur = rp.cur;
		if (!cur) return;
		if (rp.index[pid] === undefined) {
			rp.index[pid] = rp.players.length;
			rp.players.push(describePlayer(pid));
		}
		var t = Date.now();
		if (cur.t0 === null) cur.t0 = t;
		var track = cur.tracks[pid] || (cur.tracks[pid] = []);
		track.push({ t: t, b: button & 1, cell: r * rp.cols + c });
	};
}

// --- binary writer (unsigned LEB128 varints) ------------------------------------------------------
function Writer() { this.bytes = []; }
Writer.prototype.u8 = function(v) { this.bytes.push(v & 0xff); };
Writer.prototype.varint = function(v) {
	v = v >>> 0;
	while (v >= 0x80) { this.bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
	this.bytes.push(v);
};
Writer.prototype.str = function(s) {
	var buf = Buffer.from(s || "", "utf8");
	this.varint(buf.length);
	for (var i = 0; i < buf.length; i++) this.bytes.push(buf[i]);
};
Writer.prototype.raw = function(u8arr) { for (var i = 0; i < u8arr.length; i++) this.bytes.push(u8arr[i]); };
Writer.prototype.buffer = function() { return Buffer.from(this.bytes); };

function serialize(rp, winnerIndex) {
	var w = new Writer();
	w.u8(0x4d); w.u8(0x52);          // magic "MR"
	w.u8(REPLAY_VERSION);
	w.u8(0);                          // flags (reserved)
	w.varint(rp.rows);
	w.varint(rp.cols);
	w.varint(rp.mineCount);
	w.varint(rp.rounds.length);       // gameCount
	w.str(rp.style || "");
	w.str(rp.mode || "");
	w.varint(rp.players.length);
	for (var p = 0; p < rp.players.length; p++) {
		var pl = rp.players[p];
		w.str(pl.name);
		w.u8(0); // reserved (was a bot flag) — opponents being bots is hidden info, so it's never recorded
		w.varint(pl.userId || 0);
		w.str(pl.skin || ""); // v2: board skin id ("" → default)
		w.str(pl.avatar || ""); // v3: avatar cloth colour ("" → default)
		w.str(pl.country || ""); // v3: country code ("" → none)
	}
	var bitLen = Math.ceil((rp.rows * rp.cols) / 8);
	for (var ri = 0; ri < rp.rounds.length; ri++) {
		var round = rp.rounds[ri];
		w.varint(round.startR);
		w.varint(round.startC);
		w.raw(round.mines);                // fixed bitLen bytes — mine layout
		w.raw(round.known);                // fixed bitLen bytes — pre-revealed opening
		var t0 = round.t0 || 0;
		for (var pi = 0; pi < rp.players.length; pi++) {
			var pid = rp.players[pi].pid;
			var track = round.tracks[pid] || [];
			w.varint(track.length);
			var prev = t0;
			for (var e = 0; e < track.length; e++) {
				var ev = track[e];
				var dt = ev.t - prev; if (dt < 0) dt = 0;
				prev = ev.t;
				w.varint(dt);
				w.varint((ev.cell << 1) | ev.b);
			}
		}
	}
	w._bitLen = bitLen;
	return w.buffer();
}

// Serialize + gzip the finished match into a wire-safe payload (meta + blob + participant userIds),
// then drop the accumulator. Pure — no db access — so it can run on a game server and travel over
// the main↔game internal API just as well as in-process (see persistPayload / results.js).
function buildPayload(room, seriesStandings) {
	var rp = room.replay;
	if (!rp) return null;
	room.replay = null;
	try {
		// No moves at all (e.g. everyone disconnected before play) → not worth storing.
		var anyMoves = rp.rounds.some(function(rd) {
			return Object.keys(rd.tracks).some(function(k) { return rd.tracks[k].length > 0; });
		});
		if (!rp.rounds.length || !anyMoves) return null;

		var winnerId = seriesStandings && seriesStandings[0] ? seriesStandings[0].id : null;
		var winnerIndex = winnerId !== null && rp.index[winnerId] !== undefined ? rp.index[winnerId] : -1;
		var raw = serialize(rp, winnerIndex);
		var blob = zlib.gzipSync(raw);
		var participants = rp.players.filter(function(p) { return p.userId; }).map(function(p) { return p.userId; });

		var meta = {
			createdAt: rp.createdAt,
			style: rp.style,
			mode: rp.mode,
			rows: rp.rows,
			cols: rp.cols,
			mineCount: rp.mineCount,
			gameCount: rp.rounds.length,
			winnerId: winnerIndex >= 0 ? (rp.players[winnerIndex].userId || null) : null,
			players: rp.players.map(function(p) { return { name: p.name, userId: p.userId, skin: p.skin || null, avatar: p.avatar || null, country: p.country || null }; }),
			format: REPLAY_VERSION,
			rawBytes: raw.length
		};
		return { meta: meta, blob: blob, participants: participants, createdAt: rp.createdAt };
	} catch (e) {
		console.error("replay.buildPayload failed", e);
		return null;
	}
}

// Persist an already-built payload. `blob` is a Buffer when built in-process, or a base64 string
// when it arrived over the wire from a game server's /internal/report post (JSON has no binary
// type) — accept either. Back-links the match's history rows so the profile's recent-games list
// can offer a "Watch".
function persistPayload(payload) {
	if (!payload) return null;
	try {
		var blob = Buffer.isBuffer(payload.blob) ? payload.blob : Buffer.from(payload.blob, "base64");
		var id = db.saveReplay(payload.meta, blob, payload.participants);
		if (id) db.linkReplayToMatches(id, payload.participants, payload.createdAt);
		return id;
	} catch (e) {
		console.error("replay.persistPayload failed", e);
		return null;
	}
}

// In-process convenience (build then persist immediately) — kept for anything that still wants the
// old one-call shape; results.js now calls buildPayload/persistPayload separately so the payload can
// travel over the wire in between on a split deploy.
function finishMatch(room, seriesStandings) {
	return persistPayload(buildPayload(room, seriesStandings));
}

module.exports = {
	shouldCapture: shouldCapture,
	startMatch: startMatch,
	startRound: startRound,
	attach: attach,
	buildPayload: buildPayload,
	persistPayload: persistPayload,
	finishMatch: finishMatch
};
