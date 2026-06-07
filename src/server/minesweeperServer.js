var http = require("http")
  , fs = require("fs")
  , path = require("path")
  , crypto = require("node:crypto")
  , gameCreator = require("./GameCreator")
  , noGuess = require("./NoGuessGenerator")
  , puzzleGen = require("./PuzzleGenerator")
  , insideOut = require("./InsideOutGenerator")
  , roomCreator = require("./RoomCreator")
  , botPlayer = require("./BotPlayer")
  , db = require("./db")
  , BoardLogic = require("../common/BoardLogic")
  , puzzleSolver = require("./PuzzleSolver")
  , cspSolver = require("./CSPSolver");

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
var OAUTH_BASE = process.env.OAUTH_REDIRECT_BASE || ("http://localhost:" + PORT);
var GITHUB_CLIENT_ID = envAny("GITHUB_CLIENT_ID", "GITHUB_AUTH_CLIENT_ID", "github_auth_client_id");
var GITHUB_CLIENT_SECRET = envAny("GITHUB_CLIENT_SECRET", "GITHUB_AUTH_CLIENT_SECRET", "github_auth_client_secret");
var GOOGLE_CLIENT_ID = envAny("GOOGLE_CLIENT_ID", "GOOGLE_AUTH_CLIENT_ID", "google_auth_client_id");
var GOOGLE_CLIENT_SECRET = envAny("GOOGLE_CLIENT_SECRET", "GOOGLE_AUTH_CLIENT_SECRET", "google_auth_client_secret");
var DEV_AUTH = process.env.DEV_AUTH === "1";
var oauthStates = {}; // state -> expiry ms

var app = http.createServer(handler);
var io = require("socket.io")(app);

// Static file roots, tried in order. Client assets (HTML, CSS, .js modules)
// live in src/client; the one shared module (BoardLogic.js) lives in
// src/common and is fetched by both runtimes.
var STATIC_ROOTS = [
	path.join(__dirname, "..", "client"),
	path.join(__dirname, "..", "common")
];

function resolveStatic(pathname) {
	if (pathname === "/") pathname = "/index.html";
	for (var i = 0; i < STATIC_ROOTS.length; i++) {
		var full = path.join(STATIC_ROOTS[i], pathname);
		// Guard against path traversal — must stay rooted under the static dir.
		if (full.indexOf(STATIC_ROOTS[i]) !== 0) continue;
		try { fs.accessSync(full, fs.constants.R_OK); return full; } catch (e) {}
	}
	return null;
}

function handler (req, res) {
	var url = new URL(req.url, OAUTH_BASE);
	var pathname = url.pathname;
	if (pathname === "/auth/github/login") return authGithubLogin(req, res);
	if (pathname === "/auth/github/callback") return authGithubCallback(req, res, url);
	if (pathname === "/auth/google/login") return authGoogleLogin(req, res);
	if (pathname === "/auth/google/callback") return authGoogleCallback(req, res, url);
	if (DEV_AUTH && pathname === "/auth/dev") return authDev(req, res, url);
	if (pathname === "/api/puzzles") return servePuzzles(req, res, url);
	if (pathname === "/api/puzzles/stats") return servePuzzleStats(req, res);
	if (pathname === "/api/puzzles/clear") return servePuzzlesClear(req, res, url);
	if (pathname === "/api/starting-positions") return serveStartingPositions(req, res, url);
	if (pathname === "/api/patterns") return servePatterns(req, res, url);
	var analyzeMatch = pathname.match(/^\/api\/puzzles\/(\d+)\/analyze$/);
	if (analyzeMatch) return servePuzzleAnalyze(req, res, parseInt(analyzeMatch[1], 10));

	var filePath = resolveStatic(pathname);
	if (!filePath) { res.writeHead(404); res.end(); return; }
	var extension = path.extname(filePath);
	var contentType = "text/html";
	if (extension == ".js") {
		contentType = "text/javascript";
	} else if (extension == ".css") {
		contentType = "text/css";
	} else if (extension == ".svg") {
		contentType = "image/svg+xml";
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
}

function authGithubLogin(req, res) {
	if (!GITHUB_CLIENT_ID) { res.writeHead(500); res.end("GitHub OAuth is not configured (set GITHUB_CLIENT_ID/SECRET)."); return; }
	var state = crypto.randomBytes(16).toString("hex");
	oauthStates[state] = Date.now() + 10 * 60 * 1000;
	var params = new URLSearchParams({
		client_id: GITHUB_CLIENT_ID,
		redirect_uri: OAUTH_BASE + "/auth/github/callback",
		scope: "read:user user:email",
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
			// /user doesn't return private emails — fetch /user/emails separately
			// (requires `user:email` scope, which we ask for in the OAuth login).
			var ghEmail = gh.email || null;
			if (!ghEmail) {
				try {
					var emailsResp = await fetch("https://api.github.com/user/emails", {
						headers: { "Authorization": "Bearer " + accessToken, "User-Agent": "minesweeper", "Accept": "application/vnd.github+json" }
					});
					var emails = await emailsResp.json();
					if (Array.isArray(emails)) {
						var primary = emails.find(function(e) { return e.primary && e.verified; });
						if (primary) ghEmail = primary.email;
					}
				} catch (e) { /* email fetch optional */ }
			}
			var user = db.upsertUser("github", gh.id, gh.name || gh.login || ("user" + gh.id), gh.avatar_url, ghEmail);
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
			var user = db.upsertUser("google", g.sub, g.name || g.email || ("user" + g.sub), g.picture, g.email);
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

// Puzzles live in SQLite (see db.js). The Lab GETs them via /api/puzzles;
// POST /api/puzzles kicks off a background generation job that inserts new
// puzzles into the DB in setImmediate chunks. The job runs against the
// canonical-key UNIQUE constraint so duplicates are silently dropped at
// the DB layer.
var puzzleJob = null; // { id, target, diff, density, done, dupes, stalls, startedAt }
var nextPuzzleJobId = 1;

// Active puzzle plays. Keyed by playerID — one in-flight puzzle per socket.
// Each entry holds the puzzle row, the gameCreator-built game (the
// authoritative state), and (for rated mode) the user's pre-attempt rating
// so the Elo update at the end is symmetric.
//
// pp.runMode is set for streak/storm modes: when the player solves or
// misses, finalizePuzzle hands off to the run controller below instead of
// applying Elo. The run advances the target rating, picks the next puzzle,
// and reuses startPuzzlePlay to set up another game on the same socket.
var puzzlePlay = {};
var puzzleRun = {};   // playerID -> { mode, targetRating, solves, startedAt, endsAt, timerHandle }

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

// Find the deduction the player should look at next. Delegates to the
// shared PuzzleSolver so trivial / subset / *enum* logic is the same as
// what the puzzle generator's analyzer uses to classify difficulty —
// previously the hint had its own copy that lacked the enum pass.
function findHintPointer(game) {
	var safe = puzzleSolver.findFirstSafeStep(game.board, game.state);
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
			var ctx = puzzleSolver.constraintAt(board, state, r, c);
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

function startPuzzleJob(target, diff, density, source, targetRating) {
	source = source || "random";
	var generator = source === "inside_out" ? insideOut : puzzleGen;
	var job = {
		id: nextPuzzleJobId++,
		target: target,
		diff: diff || null,
		density: (typeof density === "number") ? density : null,
		source: source,
		targetRating: (typeof targetRating === "number") ? targetRating : null,
		done: 0,
		dupes: 0,
		stalls: 0,
		startedAt: Date.now()
	};
	puzzleJob = job;
	// 5 puzzles per tick so we yield to the event loop between chunks — keeps
	// the server responsive to socket traffic while the job runs.
	function tick() {
		if (puzzleJob !== job) return; // a newer job superseded this one
		if (job.done >= job.target) { puzzleJob = null; return; }
		var batch = generator.generatePuzzles({
			count: Math.min(5, job.target - job.done),
			diff: job.diff || undefined,
			density: (job.density != null) ? job.density : undefined,
			targetRating: (job.targetRating != null) ? job.targetRating : undefined
		});
		if (batch.length === 0) {
			// Generator gave up within its attempt budget. End the job rather
			// than spin forever on a difficulty that's exhausted random space.
			puzzleJob = null;
			return;
		}
		var added = 0;
		for (var i = 0; i < batch.length; i++) {
			var p = batch[i];
			if (!db.insertPuzzle(p)) { job.dupes++; continue; }
			added++;
			job.done++;
			if (job.done >= job.target) break;
		}
		// If a chunk produces only duplicates, the pool is saturated for this
		// difficulty — bail after a few stalls so we don't loop forever.
		if (added === 0) {
			job.stalls++;
			if (job.stalls >= 5) { puzzleJob = null; return; }
		} else {
			job.stalls = 0;
		}
		setImmediate(tick);
	}
	setImmediate(tick);
	return job;
}

// Pool-management endpoints (generate / clear) are admin-gated so an
// anonymous request can't nuke the prod puzzle pool. The client sends
// its existing session token via the X-Session-Token header; the
// server resolves it to a user and checks `is_admin`. DEV_AUTH=1
// still opens the gate locally for convenience.
function isPuzzleAdmin(req) {
	if (DEV_AUTH) return true;
	var token = req.headers["x-session-token"];
	if (!token) return false;
	var user = db.getUserByToken(token);
	return !!(user && user.is_admin);
}

function servePuzzles(req, res, url) {
	if (req.method === "POST") {
		if (!isPuzzleAdmin(req)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Admin token required to generate puzzles." }));
			return;
		}
		var count = Math.max(1, Math.min(500, parseInt(url.searchParams.get("count"), 10) || 20));
		var diff = parseInt(url.searchParams.get("diff"), 10);
		var density = parseFloat(url.searchParams.get("density"));
		var sourceRaw = url.searchParams.get("source");
		var source = (sourceRaw === "inside_out") ? "inside_out" : "random";
		var targetRatingRaw = parseInt(url.searchParams.get("targetRating"), 10);
		var targetRating = (source === "inside_out" && targetRatingRaw >= 0 && targetRatingRaw <= 3000) ? targetRatingRaw : null;
		if (puzzleJob) {
			res.writeHead(409, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "A generation job is already running.", job: puzzleJobStatus() }));
			return;
		}
		var job = startPuzzleJob(
			count,
			(diff >= 1 && diff <= 6) ? diff : null,
			(density >= 0.05 && density <= 0.50) ? density : null,
			source,
			targetRating
		);
		res.writeHead(202, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, job: { id: job.id, target: job.target, diff: job.diff, density: job.density, source: job.source, targetRating: job.targetRating } }));
		return;
	}
	// GET — return DB-backed puzzles. Paginated: `page` (0-indexed) +
	// `pageSize` (default 50, max 200), optionally filtered by `diff`,
	// sorted by rating asc/desc. Response carries total count for the
	// active filter so the client can size its page nav.
	var diff = parseInt(url.searchParams.get("diff"), 10);
	var page = parseInt(url.searchParams.get("page"), 10) || 0;
	var pageSize = parseInt(url.searchParams.get("pageSize"), 10) || 50;
	var sort = url.searchParams.get("sort") === "desc" ? "desc" : "asc";
	var methodRaw = url.searchParams.get("method");
	var method = (methodRaw === "trivial" || methodRaw === "subset" || methodRaw === "union" || methodRaw === "intersect" || methodRaw === "case" || methodRaw === "enum") ? methodRaw : null;
	var diffFilter = (diff >= 1 && diff <= 6) ? diff : null;
	var scoreBandRaw = url.searchParams.get("score");
	var scoreBand = (scoreBandRaw && /^(\d+(\.\d+)?-\d+(\.\d+)?|\d+(\.\d+)?\+)$/.test(scoreBandRaw)) ? scoreBandRaw : null;
	var listSourceRaw = url.searchParams.get("source");
	var listSource = (listSourceRaw === "random" || listSourceRaw === "inside_out") ? listSourceRaw : null;
	var puzzles = db.listPuzzles({ difficulty: diffFilter, method: method, scoreBand: scoreBand, source: listSource, page: page, pageSize: pageSize, sort: sort });
	var total = db.puzzleCount(diffFilter, method, scoreBand, listSource);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		puzzles: puzzles,
		pool: db.puzzleCount(),
		total: total,
		page: page,
		pageSize: pageSize,
		job: puzzleJobStatus()
	}));
}

function servePuzzlesClear(req, res, url) {
	if (!isPuzzleAdmin(req)) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Admin token required to clear puzzles." }));
		return;
	}
	db.clearPuzzles();
	puzzleJob = null;
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true }));
}

// Browse enumerated starting positions. Paged list with optional
// size filter and sort direction.
function serveStartingPositions(req, res, url) {
	var page = parseInt(url.searchParams.get("page"), 10) || 0;
	var pageSize = parseInt(url.searchParams.get("pageSize"), 10) || 50;
	var sort = url.searchParams.get("sort") === "desc" ? "desc" : "asc";
	var size = parseInt(url.searchParams.get("size"), 10);
	var actionRaw = url.searchParams.get("action");
	var firstAction = (actionRaw === "reveal" || actionRaw === "flag" || actionRaw === "case") ? actionRaw : null;
	var minRatingRaw = parseInt(url.searchParams.get("minRating"), 10);
	var maxRatingRaw = parseInt(url.searchParams.get("maxRating"), 10);
	var uniqueRaw = url.searchParams.get("unique");
	var uniqueSolution = (uniqueRaw === "true") ? true : (uniqueRaw === "false") ? false : null;
	var primeRaw = url.searchParams.get("prime");
	var prime = (primeRaw === "true") ? true : (primeRaw === "false") ? false : null;
	var filterOpts = {
		size: (size >= 3 && size <= 9) ? size : null,
		firstAction: firstAction,
		minRating: !isNaN(minRatingRaw) ? minRatingRaw : null,
		maxRating: !isNaN(maxRatingRaw) ? maxRatingRaw : null,
		uniqueSolution: uniqueSolution,
		prime: prime
	};
	var listOpts = Object.assign({ page: page, pageSize: pageSize, sort: sort }, filterOpts);
	var positions = db.listStartingPositions(listOpts);
	var total = db.startingPositionCount(filterOpts);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ positions: positions, total: total, page: page, pageSize: pageSize }));
}

// Browse the deduction-pattern catalogue (first-move templates
// extracted from every starting position). Sortable by occurrences or
// rating, filterable by action and rating band.
function servePatterns(req, res, url) {
	var page = parseInt(url.searchParams.get("page"), 10) || 0;
	var pageSize = parseInt(url.searchParams.get("pageSize"), 10) || 50;
	var sort = url.searchParams.get("sort") === "asc" ? "asc" : "desc";
	var orderByRaw = url.searchParams.get("orderBy");
	var orderBy = (orderByRaw === "occurrences" || orderByRaw === "rating") ? orderByRaw : "rating";
	var methodRaw = url.searchParams.get("method");
	var validMethod = { trivial: 1, subset: 1, union: 1, intersect: 1, case: 1, enum: 1 };
	var method = validMethod[methodRaw] ? methodRaw : null;
	var minRatingRaw = parseInt(url.searchParams.get("minRating"), 10);
	var maxRatingRaw = parseInt(url.searchParams.get("maxRating"), 10);
	var filterOpts = {
		method: method,
		minRating: !isNaN(minRatingRaw) ? minRatingRaw : null,
		maxRating: !isNaN(maxRatingRaw) ? maxRatingRaw : null
	};
	var patterns = db.listPatterns(Object.assign({ page: page, pageSize: pageSize, sort: sort, orderBy: orderBy }, filterOpts));
	var total = db.patternCount(filterOpts);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ patterns: patterns, total: total, page: page, pageSize: pageSize }));
}

// Aggregate stats for the All-Puzzles dashboard.
function servePuzzleStats(req, res) {
	var stats = db.puzzleStats();
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(stats));
}

// CSP solver trace for a single puzzle. Used by the Analyze modal in
// the admin All-Puzzles view to compare the new solver's complexity
// scoring against the existing pass-based tier on a per-board basis.
function servePuzzleAnalyze(req, res, puzzleId) {
	var puzzle = db.getPuzzleById(puzzleId);
	if (!puzzle) {
		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Puzzle not found" }));
		return;
	}
	var board = puzzleGen.buildBoard(puzzle.rows, puzzle.cols, puzzle.mines);
	var state = [];
	for (var r = 0; r < puzzle.rows; r++) {
		state.push([]);
		for (var c = 0; c < puzzle.cols; c++) state[r].push(BoardLogic.UNKNOWN);
	}
	puzzle.revealed.forEach(function(rc) { state[rc[0]][rc[1]] = BoardLogic.KNOWN; });
	function cascade(rr, cc) {
		BoardLogic.cascadeReveal(rr, cc, puzzle.rows, puzzle.cols,
			function(r2, c2) { return state[r2][c2] === BoardLogic.UNKNOWN; },
			function(r2, c2) { state[r2][c2] = BoardLogic.KNOWN; return false; },
			function(r2, c2) { return board[r2][c2]; }
		);
	}
	var result = cspSolver.analyzeBoard(board, state, { revealCell: cascade });
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		puzzleId: puzzleId,
		solved: result.solved,
		maxComplexity: result.maxComplexity,
		totalComplexity: result.totalComplexity,
		safeCovered: result.safeCovered,
		moves: result.moves
	}));
}

function puzzleJobStatus() {
	if (!puzzleJob) return null;
	return {
		id: puzzleJob.id,
		target: puzzleJob.target,
		diff: puzzleJob.diff,
		density: puzzleJob.density,
		source: puzzleJob.source || "random",
		targetRating: puzzleJob.targetRating || null,
		done: puzzleJob.done,
		dupes: puzzleJob.dupes
	};
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
var botMistake = {}; // botId -> blunder rate (re-applied to the game each round)
var botChord = {}; // botId -> chord rate (re-applied to the game each round)
var botMaxTier = {}; // botId -> solver tier ceiling (re-applied each round)
var botTickHandles = {}; // botId -> setTimeout handle
var botLastClick = {}; // botId -> {r, c} of the bot's most recent click in the current round
var nextBotId = 1;
var MAX_BOTS_PER_ROOM = 15;

// Ranked matchmaking — five modes split across two playstyles.
//   sprint_*   → cascade-y races, 10% mines, fewer forced deductions.
//   standard_* → dense boards (20%), favouring deduction over click speed.
//   tournament → keeps the original 15% as the marquee event.
// Each playstyle (sprint / standard / tournament) carries its own Elo so
// a player can be Bronze in Sprint and Gold in Standard.
var RANKED_MODES = {
	sprint_duo: { size: 2, label: "1v1 Sprint", style: "sprint", mineDensity: 0.10, boardSize: "medium" },
	sprint_six: { size: 6, label: "6P Sprint",  style: "sprint", mineDensity: 0.10, boardSize: "medium" },
	standard_duo: { size: 2, label: "1v1 Standard", style: "standard", mineDensity: 0.20, boardSize: "medium" },
	standard_six: { size: 6, label: "6P Standard", style: "standard", mineDensity: 0.20, boardSize: "medium" },
	// Cut 4 per round while many players are alive (16 → 12 → 8), then drop to
	// 2 per round (8 → 6 → 4 → 2) so the bottom of the bracket gets dramatic
	// per-round 1v1 elimination drama all the way to the 2 → 1 final.
	tournament: { size: 16, label: "Tournament", style: "tournament", mineDensity: 0.15, boardSize: "medium", schedule: [12, 8, 6, 4, 2, 1] }
};
var RANKED_RULES = { gameCount: 1, roundSeconds: 120, deathPenalty: 5 };
// Brief pause between forming a ranked match and starting the first game so
// players can see who they're playing and at what tier. Tournament takes a
// little longer since there's a 16-row roster to read.
var RANKED_MATCH_REVEAL_MS = {
	sprint_duo: 2500,
	sprint_six: 3000,
	standard_duo: 2500,
	standard_six: 3000,
	tournament: 5000
};
var RANKED_BOT_RATING = 1000;
// Bots "join" the queue one at a time at random intervals so it reads like real
// players trickling in, rather than all appearing at a fixed deadline.
var BOT_JOIN_MIN_MS = 200;
var BOT_JOIN_MAX_MS = 850;
// Per-mode queue state: humans searching, pre-generated bots, and the trickle timer.
var rankedQueues = { sprint_duo: [], sprint_six: [], standard_duo: [], standard_six: [], tournament: [] };
var pendingBotsLists = { sprint_duo: [], sprint_six: [], standard_duo: [], standard_six: [], tournament: [] };
var rankedFillTimers = { sprint_duo: null, sprint_six: null, standard_duo: null, standard_six: null, tournament: null };
var rankedQueueMode = {}; // playerID -> mode key

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
		rankedMode: room.rankedMode || null,
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

function addBotToRoom(room, config, prechosenName) {
	if (room.phase !== "planning") return false;
	if (room.isFull()) return false;
	if (botCount(room) >= MAX_BOTS_PER_ROOM) return false;
	var botId = "bot:" + (nextBotId++);
	bots[botId] = true;
	names[botId] = prechosenName || botPlayer.pickBotName(getRoomBotNames(room));
	games[botId] = createPlayerGame(botId, room.rows, room.cols);
	if (config) {
		// Elo-tuned bot (ranked): explicit speed, mistake rate, and rating.
		botDifficulty[botId] = null;
		botSpeedMs[botId] = config.speedMs;
		botRating[botId] = config.rating;
		botMistake[botId] = config.mistakeRate;
		botChord[botId] = (typeof config.chordRate === "number") ? config.chordRate : 0;
		botMaxTier[botId] = config.maxTier || "trivial";
	} else {
		botDifficulty[botId] = botPlayer.DEFAULT_DIFFICULTY;
		botSpeedMs[botId] = botPlayer.speedFor(botDifficulty[botId]);
		botMistake[botId] = botPlayer.mistakeRateFor(botDifficulty[botId]);
		botChord[botId] = botPlayer.chordRateFor(botDifficulty[botId]);
		botMaxTier[botId] = botPlayer.maxTierFor(botDifficulty[botId]);
		botRating[botId] = RANKED_BOT_RATING;
	}
	games[botId].botMistakeRate = botMistake[botId];
	games[botId].botChordRate = botChord[botId];
	games[botId].botMaxTier = botMaxTier[botId];
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
	delete botMistake[botId];
	delete botChord[botId];
	delete botMaxTier[botId];
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

// Read the rating column matching this match's playstyle so Sprint /
// Standard / Tournament each evolve independently.
function readUserRating(u, style) {
	if (!u) return RANKED_BOT_RATING;
	if (style === "sprint") return u.rating_sprint != null ? u.rating_sprint : u.rating;
	if (style === "standard") return u.rating_standard != null ? u.rating_standard : u.rating;
	if (style === "tournament") return u.rating_tournament != null ? u.rating_tournament : u.rating;
	return u.rating;
}

// Compute and apply Elo for a single player against a known set of standings.
// Used by tournament mode so eliminated players get their rating change the
// moment they're cut, instead of waiting for the survivor to be crowned. The
// math is the same pairwise formula as applyRankedElo. Returns the delta info
// (or null if the player isn't a persisted human).
function applyEloForPlayer(targetPid, allParts, style) {
	var target = null;
	for (var i = 0; i < allParts.length; i++) if (allParts[i].id === targetPid) { target = allParts[i]; break; }
	if (!target || target.bot || !target.userId) return null;
	var n = allParts.length;
	if (n < 2) return null;
	var sum = 0;
	for (var j = 0; j < n; j++) {
		var q = allParts[j];
		if (q.id === targetPid) continue;
		var score = target.rank < q.rank ? 1 : target.rank > q.rank ? 0 : 0.5;
		var expected = 1 / (1 + Math.pow(10, (q.rating - target.rating) / 400));
		sum += score - expected;
	}
	var K = Math.max(30, 80 - target.played * 4);
	var delta = Math.round(K * sum / Math.sqrt(n - 1));
	var newRating = target.rating + delta;
	var provisional = (target.played + 1) < PROVISIONAL_GAMES;
	db.updateRating(target.userId, newRating, target.rank === 1, style);
	if (accounts[targetPid]) {
		// Cache the style-specific rating on the in-memory account so the
		// lobby tile updates the right tier badge.
		if (style === "sprint") accounts[targetPid].ratingSprint = newRating;
		else if (style === "standard") accounts[targetPid].ratingStandard = newRating;
		else if (style === "tournament") accounts[targetPid].ratingTournament = newRating;
		accounts[targetPid].rating = newRating; // legacy field kept in sync
		accounts[targetPid].played = target.played + 1;
	}
	return { delta: delta, newRating: newRating, provisional: provisional };
}

// Build the pairwise-Elo parts snapshot for a tournament room from the
// perspective of a single eliminated/finishing player. Survivors are slotted
// at rank 1 (they outranked anyone already eliminated); the focused player
// keeps their just-determined rank; previously-eliminated players retain
// their stored places.
function tournamentEloParts(room, focusedPid, focusedRank) {
	var participants = room.tournamentParticipants || [];
	var style = room.rankedStyle || "tournament";
	return participants.map(function(pid) {
		var rank;
		if (pid === focusedPid) {
			rank = focusedRank;
		} else if (room.tournamentEliminated[pid]) {
			rank = room.tournamentEliminated[pid].place;
		} else {
			rank = 1; // survivor — will outrank the focused player
		}
		var bot = isBot(pid);
		var acc = accounts[pid];
		var rating = bot ? (botRating[pid] || RANKED_BOT_RATING) : RANKED_BOT_RATING;
		var userId = null, played = 0;
		if (!bot && acc) {
			var u = db.getUserById(acc.userId);
			if (u) { rating = readUserRating(u, style); userId = acc.userId; played = u.played; }
		}
		return { id: pid, rank: rank, rating: rating, bot: bot, userId: userId, played: played };
	});
}

// Pairwise Elo over the round's standings. Each pair of players is a mini-match;
// a player's delta is K * mean(score - expected) across opponents (so a round's
// swing stays ~K regardless of lobby size). Bots use a fixed rating and aren't
// persisted. Mutates human standings entries with ratingDelta/rating/provisional.
function applyRankedElo(standings, style) {
	var parts = standings.map(function(s) {
		var bot = isBot(s.id);
		var acc = accounts[s.id];
		var rating = bot ? (botRating[s.id] || RANKED_BOT_RATING) : RANKED_BOT_RATING, userId = null, played = 0;
		if (!bot && acc) {
			var u = db.getUserById(acc.userId);
			if (u) { rating = readUserRating(u, style); userId = acc.userId; played = u.played; }
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
		// Smooth K-factor curve so new accounts climb fast and ratings settle
		// after ~12 games: K=80 game 1, K=60 at 5, K=40 at 10, K=30 from 13 on.
		var K = Math.max(30, 80 - p.played * 4);
		// Normalize by sqrt(n-1) instead of (n-1) so beating more opponents pays
		// more: 1v1 top spot ~K/2; 6-player top spot ~K*sqrt(5)/2 ≈ 2.2× as much.
		p.delta = Math.round(K * sum / Math.sqrt(n - 1));
		p.newRating = p.rating + p.delta;
		p.provisional = (p.played + 1) < PROVISIONAL_GAMES;
		db.updateRating(p.userId, p.newRating, p.rank === 1, style);
	}
	for (var k = 0; k < standings.length; k++) {
		if (!parts[k].bot && parts[k].userId) {
			standings[k].ratingDelta = parts[k].delta;
			standings[k].rating = parts[k].newRating;
			standings[k].provisional = parts[k].provisional;
			// Keep the in-memory cache in sync with what we just persisted.
			if (accounts[standings[k].id]) {
				var acc = accounts[standings[k].id];
				if (style === "sprint") acc.ratingSprint = parts[k].newRating;
				else if (style === "standard") acc.ratingStandard = parts[k].newRating;
				else if (style === "tournament") acc.ratingTournament = parts[k].newRating;
				acc.rating = parts[k].newRating; // legacy field
				acc.played = parts[k].played + 1;
			}
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
			var eloInfo = applyEloForPlayer(sCut.id, tournamentEloParts(room, sCut.id, place), room.rankedStyle || "tournament");
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
			if (isBot(sCut.id)) clearBotTick(sCut.id);
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
			var winnerInfo = applyEloForPlayer(winnerPid, tournamentEloParts(room, winnerPid, 1), room.rankedStyle || "tournament");
			if (winnerInfo) room.tournamentElo[winnerPid] = winnerInfo;
		}
		seriesStandings = buildTournamentStandings(room);
		room.seriesWinner = seriesStandings[0] ? seriesStandings[0].id : null;
	} else {
		seriesStandings = buildSeriesStandings(room);
		if (room.ranked) applyRankedElo(seriesStandings, room.rankedStyle);
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

	// First finish in this round? Pull the remaining time down to 10s — anyone
	// still working gets one last sprint before the round closes.
	if (countFinishedPlayers(room) === 1) {
		reduceRoundDeadline(room, 10);
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
	var mines = Math.round(room.mineDensity * room.rows * room.cols);
	var centerR = Math.floor(room.rows / 2);
	var centerC = Math.floor(room.cols / 2);
	var template = noGuess.createNoGuessTemplate(centerR, centerC, mines, undefined, room.rows, room.cols);
	for (var i = 0; i < room.players.length; i++) {
		var pid = room.players[i];
		// Recreate each game at the room's dimensions so a mid-lobby size change applies.
		games[pid] = createPlayerGame(pid, room.rows, room.cols);
		if (isBot(pid)) {
			games[pid].botMistakeRate = botMistake[pid];
			games[pid].botChordRate = botChord[pid];
			games[pid].botMaxTier = botMaxTier[pid];
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
function isValidMode(mode) { return !!RANKED_MODES[mode]; }
function modeSize(mode) { return RANKED_MODES[mode].size; }

function rankedCount(mode) {
	return rankedQueues[mode].length + pendingBotsLists[mode].length;
}

// Average human rating in this mode's queue — used to tune freshly-arriving
// bots so the lobby's overall skill stays consistent.
function rankedTargetElo(mode) {
	var q = rankedQueues[mode];
	var sum = 0, n = 0;
	for (var i = 0; i < q.length; i++) {
		var acc = accounts[q[i]];
		var u = acc ? db.getUserById(acc.userId) : null;
		if (u) { sum += u.rating; n++; }
	}
	return n ? Math.round(sum / n) : 1000;
}

// What each player should see in the search-screen slots: humans in the queue
// plus already-arrived pending bots, ordered humans-first. `isYou` is per-viewer.
function rankedSearchMembers(viewerID, mode) {
	var members = [];
	var q = rankedQueues[mode], pending = pendingBotsLists[mode];
	for (var i = 0; i < q.length; i++) {
		var pid = q[i];
		var acc = accounts[pid];
		var u = acc ? db.getUserById(acc.userId) : null;
		members.push({
			id: pid,
			name: names[pid] || (u && u.name) || "Anonymous",
			rating: u ? u.rating : 1000,
			provisional: u ? (u.played < PROVISIONAL_GAMES) : true,
			isYou: pid === viewerID,
			isBot: false
		});
	}
	for (var j = 0; j < pending.length; j++) {
		var b = pending[j];
		members.push({
			id: "pending_bot_" + mode + "_" + j,
			name: b.name,
			rating: b.config.rating,
			provisional: false,
			isYou: false,
			isBot: true
		});
	}
	return members;
}

function broadcastRankedQueue(mode) {
	var q = rankedQueues[mode];
	for (var i = 0; i < q.length; i++) {
		var pid = q[i];
		var s = sockets[pid];
		if (s) s.emit("ranked_searching", {
			mode: mode,
			count: rankedCount(mode),
			size: modeSize(mode),
			members: rankedSearchMembers(pid, mode)
		});
	}
}

function clearRankedFill(mode) {
	if (rankedFillTimers[mode]) { clearTimeout(rankedFillTimers[mode]); rankedFillTimers[mode] = null; }
}

// Spread bot ratings around the target so the lobby looks like real matchmaking
// instead of N copies of the player's rating. Clamped to the bot strength curve.
function jitterBotElo(targetElo) {
	var jittered = targetElo + Math.round((Math.random() - 0.5) * 100);  // ±50
	if (jittered < 600) jittered = 600;
	if (jittered > 1800) jittered = 1800;
	return jittered;
}

// How many bots "arrive" on this trickle tick. Mostly one, but occasionally a
// pair or a small cluster — feels more like real players spawning in.
function pickBotBatchSize() {
	var r = Math.random();
	if (r < 0.10) return 3;
	if (r < 0.35) return 2;
	return 1;
}

function scheduleBotArrival(mode) {
	if (rankedFillTimers[mode]) return;
	var delay = BOT_JOIN_MIN_MS + Math.floor(Math.random() * (BOT_JOIN_MAX_MS - BOT_JOIN_MIN_MS));
	rankedFillTimers[mode] = setTimeout(function() {
		rankedFillTimers[mode] = null;
		if (rankedQueues[mode].length === 0) { pendingBotsLists[mode] = []; return; }
		var slotsLeft = modeSize(mode) - rankedCount(mode);
		if (slotsLeft <= 0) return;
		var batch = Math.min(slotsLeft, pickBotBatchSize());
		for (var b = 0; b < batch; b++) {
			var taken = pendingBotsLists[mode].map(function(p) { return p.name; });
			pendingBotsLists[mode].push({
				name: botPlayer.pickBotName(taken),
				config: botPlayer.configForElo(jitterBotElo(rankedTargetElo(mode)))
			});
		}
		if (rankedCount(mode) >= modeSize(mode)) {
			formRankedMatch(mode);
		} else {
			broadcastRankedQueue(mode);
			scheduleBotArrival(mode);
		}
	}, delay);
}

function enqueueRanked(playerID, mode) {
	if (!isValidMode(mode)) return;
	if (!accounts[playerID]) return;          // ranked requires a signed-in account
	if (roomMapping[playerID]) return;         // already in a room
	// Player can only be in one ranked queue at a time.
	if (rankedQueueMode[playerID]) dequeueRanked(playerID);
	rankedQueues[mode].push(playerID);
	rankedQueueMode[playerID] = mode;
	if (rankedCount(mode) >= modeSize(mode)) {
		formRankedMatch(mode);
	} else {
		broadcastRankedQueue(mode);
		scheduleBotArrival(mode);
	}
}

function dequeueRanked(playerID) {
	var mode = rankedQueueMode[playerID];
	if (!mode) return;
	delete rankedQueueMode[playerID];
	var q = rankedQueues[mode];
	var idx = q.indexOf(playerID);
	if (idx !== -1) q.splice(idx, 1);
	if (q.length === 0) {
		clearRankedFill(mode);
		pendingBotsLists[mode] = [];
	} else {
		broadcastRankedQueue(mode);
	}
}

function formRankedMatch(mode) {
	clearRankedFill(mode);
	var matchSize = modeSize(mode);
	var queuedBots = pendingBotsLists[mode];
	pendingBotsLists[mode] = [];

	var humans = [];
	while (rankedQueues[mode].length && humans.length < matchSize) {
		var pid = rankedQueues[mode].shift();
		delete rankedQueueMode[pid];
		if (sockets[pid] && accounts[pid] && !roomMapping[pid]) humans.push(pid);
	}
	if (humans.length === 0) return;

	var id = nextRoomId++;
	var modeDef = RANKED_MODES[mode];
	var room = roomCreator.createRoom(id, humans[0], matchSize);
	room.ranked = true;
	room.rankedMode = mode;
	room.rankedStyle = modeDef.style; // sprint / standard / tournament
	room.roundSeconds = RANKED_RULES.roundSeconds;
	room.deathPenalty = RANKED_RULES.deathPenalty;
	room.mineDensity = modeDef.mineDensity;
	room.setBoardSize(modeDef.boardSize);
	if (mode === "tournament") {
		room.tournamentSchedule = modeDef.schedule.slice();
		room.tournamentParticipants = [];   // populated after players join
		room.tournamentEliminated = {};      // pid -> { round, place }
		room.gameCount = modeDef.schedule.length;
	} else {
		room.gameCount = RANKED_RULES.gameCount;
	}
	rooms[id] = room;

	for (var i = 0; i < humans.length; i++) {
		var hid = humans[i];
		var socket = sockets[hid];
		games[hid] = createPlayerGame(hid, room.rows, room.cols);
		roomMapping[hid] = room;
		room.addPlayer(hid);
		socket.leave("lobby");
		socket.join("room:" + room.id);
		socket.emit("joined_room", { roomId: room.id, ranked: true, mode: mode });
	}

	// Use the bot identities already shown to the player during the search so the
	// opponents who appear in the lobby slot list are the same who join the match.
	for (var b = 0; b < queuedBots.length && room.players.length < matchSize; b++) {
		if (botCount(room) >= MAX_BOTS_PER_ROOM) break;
		addBotToRoom(room, queuedBots[b].config, queuedBots[b].name);
	}
	// If queued bots weren't enough (e.g. a player joined late and the queue size
	// jumped without enough bot timers firing), top up with fresh bots tuned to
	// the lobby's average human rating.
	if (room.players.length < matchSize) {
		var sumElo = 0, eloCount = 0;
		for (var h = 0; h < humans.length; h++) {
			var acc = accounts[humans[h]];
			var u = acc ? db.getUserById(acc.userId) : null;
			if (u) { sumElo += u.rating; eloCount++; }
		}
		var targetElo = eloCount ? Math.round(sumElo / eloCount) : 1000;
		while (room.players.length < matchSize && botCount(room) < MAX_BOTS_PER_ROOM) {
			if (!addBotToRoom(room, botPlayer.configForElo(jitterBotElo(targetElo)))) break;
		}
	}

	for (var j = 0; j < room.players.length; j++) room.playerReady(room.players[j]);
	if (mode === "tournament") room.tournamentParticipants = room.players.slice();
	broadcastRoomState(room);

	// Pause so the players can read the opponent slates + tiers before the first
	// countdown starts. The room is in planning phase during this window.
	var revealMs = RANKED_MATCH_REVEAL_MS[mode] || 4000;
	io.to("room:" + room.id).emit("match_reveal", { delayMs: revealMs });
	setTimeout(function() {
		if (!rooms[room.id] || room.phase !== "planning") return;
		startSeries(room);
	}, revealMs);

	if (rankedQueues[mode].length > 0) {
		broadcastRankedQueue(mode);
		scheduleBotArrival(mode);
	}
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
		var teloInfo = applyEloForPlayer(playerID, tournamentEloParts(room, playerID, place), room.rankedStyle || "tournament");
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
	return applyEloForPlayer(playerID, parts, room.rankedStyle);
}

function buildPlayerParts(pid, rank, style) {
	var bot = isBot(pid);
	var acc = accounts[pid];
	var u = !bot && acc ? db.getUserById(acc.userId) : null;
	return {
		id: pid,
		rank: rank,
		rating: bot ? (botRating[pid] || RANKED_BOT_RATING) : (u ? readUserRating(u, style) : RANKED_BOT_RATING),
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
	return leaveEloInfo;
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
		accounts[playerID] = {
			userId: user.id, token: token, played: user.played,
			rating: user.rating,
			ratingSprint: user.rating_sprint != null ? user.rating_sprint : user.rating,
			ratingStandard: user.rating_standard != null ? user.rating_standard : user.rating,
			ratingTournament: user.rating_tournament != null ? user.rating_tournament : user.rating
		};
		var isFirst = !names[playerID];
		names[playerID] = user.name;
		if (games[playerID]) {
			games[playerID].playerName = user.name;
			updateDraw(roomMapping[playerID]);
		}
		var today = db.todayUtc();
		var dailyAttempt = db.getDailyAttempt(user.id, today);
		socket.emit("authenticated", {
			name: user.name,
			rating: user.rating,
			ratingSprint: user.rating_sprint != null ? user.rating_sprint : user.rating,
			ratingStandard: user.rating_standard != null ? user.rating_standard : user.rating,
			ratingTournament: user.rating_tournament != null ? user.rating_tournament : user.rating,
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
			isAdmin: !!user.is_admin
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

	socket.on("find_ranked", function(data) {
		if (!accounts[playerID]) { socket.emit("ranked_rejected", { reason: "Sign in to play ranked." }); return; }
		if (roomMapping[playerID]) return;
		var mode = (data && data.mode) || "sprint_duo";
		if (!isValidMode(mode)) { socket.emit("ranked_rejected", { reason: "Unknown ranked mode." }); return; }
		enqueueRanked(playerID, mode);
	});

	socket.on("cancel_ranked", function() {
		dequeueRanked(playerID);
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
		botSpeedMs[botId] = botPlayer.speedFor(difficulty);
		botMistake[botId] = botPlayer.mistakeRateFor(difficulty);
		botChord[botId] = botPlayer.chordRateFor(difficulty);
		botMaxTier[botId] = botPlayer.maxTierFor(difficulty);
		if (games[botId]) {
			games[botId].botMistakeRate = botMistake[botId];
			games[botId].botChordRate = botChord[botId];
			games[botId].botMaxTier = botMaxTier[botId];
		}
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
		var pp = puzzlePlay[playerID];
		if (pp) {
			if (!pp.game.playing) return;
			pp.game.handleRightClick(data.r, data.c);
			return;
		}
		var room = roomMapping[playerID];
		if (!room || room.phase !== "playing") return;
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
		// Mid-puzzle disconnect is fine — current_puzzle_id stays set in the
		// DB so the same puzzle is served on reconnect. We just drop the
		// in-memory game state. Active runs end (no resume — runs are
		// session-only by design); score is recorded if it's a new best.
		if (puzzleRun[playerID]) endPuzzleRun(socket, playerID, "disconnect");
		delete puzzlePlay[playerID];
		delete sockets[playerID];
		delete names[playerID];
		delete accounts[playerID]; // session stays valid in the DB for reconnect
	});
});

// Background pool top-up — if PUZZLE_POOL_TARGET is set and the DB has
// fewer puzzles than that, kick off a self-restarting generation job at
// startup. Keeps the pool healthy in prod without needing to babysit
// the Lab. PUZZLE_POOL_TOPUP_DISABLED=1 turns it off.
function ensurePuzzlePoolTopUp() {
	if (process.env.PUZZLE_POOL_TOPUP_DISABLED === "1") return;
	var target = parseInt(process.env.PUZZLE_POOL_TARGET, 10);
	if (!target || target <= 0) return;
	var have = db.puzzleCount();
	if (have >= target) {
		console.log("puzzle pool: " + have + " / " + target + " (full)");
		return;
	}
	var toGenerate = target - have;
	console.log("puzzle pool: " + have + " / " + target + " — generating " + toGenerate + " in background");
	function tick() {
		if (puzzleJob) {
			// User-triggered job in flight; wait it out and retry later.
			setTimeout(tick, 30 * 1000);
			return;
		}
		var current = db.puzzleCount();
		if (current >= target) {
			console.log("puzzle pool top-up complete (" + current + " / " + target + ")");
			return;
		}
		var batch = Math.min(200, target - current);
		startPuzzleJob(batch, null, null);
		// Poll until the job clears, then loop.
		var watchdog = setInterval(function() {
			if (!puzzleJob) { clearInterval(watchdog); tick(); }
		}, 1000);
	}
	setTimeout(tick, 2000);
}

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

app.listen(PORT, "0.0.0.0", function() {
	console.log("listening on " + PORT);
	backfillOverlapClassification();
	ensurePuzzlePoolTopUp();
});
