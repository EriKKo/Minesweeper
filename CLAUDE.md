# Multiplayer Minesweeper (msbattle.net)

Real-time multiplayer Minesweeper racing: players clear their own board on a shared
no-guess layout, fastest wins. Casual rooms + a ranked ladder with accounts and Elo.

## Commands

Run from this directory (`Minesweeper/`):

- `npm run dev` — start locally with dev login enabled (`DEV_AUTH=1`), on port 1337.
  Auto-loads `.env`.
- `npm run stop` — stop the running server.
- `npm run restart` — stop + start (use this after server-side changes).
- `npm start` — plain start (no dev login); this is what the Docker/prod image runs.

Requires **Node ≥ 22** (uses the built-in `node:sqlite`).

There is no build step and no test suite. To verify changes, run the server and drive
the app in a browser at http://localhost:1337. Pure logic (board generation, the
no-guess solver, bot behaviour, Elo) can be checked with short `node -e` scripts.

## Layout

Source is split into three trees under `src/`:

**`src/server/`** — Node + socket.io backend:
- `minesweeperServer.js` — HTTP + socket.io entry: rooms, series, ranked matchmaking,
  OAuth/dev auth endpoints, bot orchestration. Also serves static client assets
  out of `src/client/` and `src/common/`.
- `GameCreator.js` — board/game state factory + mine placement.
- `NoGuessGenerator.js` — `createNoGuessTemplate` + the deduction solver
  (`analyzeSolvability`).
- `RoomCreator.js` — room and best-of-N series state.
- `BotPlayer.js` — bot AI (deduction + blunders), casual difficulty presets, the
  random-knob bot generator (`randomBotConfig`), and the ranked pool loader/picker
  (`loadPool` / `pickBotFromPool`). `configForElo` survives only as the offline
  calibration anchor — nothing at runtime calls it.
- `BotBench.js` — headless bot benchmarking: replays a bot's real decision loop on a
  virtual clock to measure solve time, calibrates time→Elo against the `configForElo`
  curve, and ratings a config. Used by `scripts/generate-bot-pool.js`; no I/O of its own.
- `db.js` — SQLite (`node:sqlite`) for accounts, sessions, and ratings.

**`src/common/`** — modules required by both runtimes (loaded via plain
`<script>` tag in the browser and `require()` on the server):
- `BoardLogic.js` — cascade, chord, neighbour iteration, the MINE/FLAGGED/
  UNKNOWN/KNOWN state sentinels.

**`src/client/`** — browser frontend, each file a single feature:
- `index.html` — entry page: markup + the inline live-game socket handlers
  and DOM/state wiring. All other client modules are plain `<script>` tags
  loaded ahead of it (each becomes a global).
- `style.css` — all styles.
- `BoardRender.js` — canvas paint + palette + animation timings + DPR.
- `Animations.js` — the cellAnims queue + RAF loop + per-frame board paint.
- `Input.js` — pointer/touch/keyboard handlers, local reveal/chord mirrors.
- `MobileLayout.js`, `Sound.js`, `Overlay.js`, `RoundTimer.js`,
  `DangerWarning.js`, `BoardDecoder.js`, `Router.js`, `Auth.js`,
  `Ranking.js`, `Leaderboard.js`, `Profile.js`, `Lobby.js`,
  `MatchPanels.js`, `GameRoom.js`, `Solo.js`, `Learn.js` — one feature each.

The Learn page is an interactive deduction trainer (`LEARN_COURSES` data
array, ~16 puzzles + ~10 demos). No mine-count deductions — the game
hides the total.

## Configuration (`.env`, auto-loaded; gitignored)

- `PORT` — 1337 local, 8080 in prod.
- `DEV_AUTH=1` — enables the `/auth/dev` login button. **Never set in production.**
- `OAUTH_REDIRECT_BASE` — base URL for OAuth callbacks (`http://localhost:1337` local,
  `https://msbattle.net` prod).
- `google_auth_client_id` / `google_auth_client_secret` (and GitHub equivalents) — OAuth
  credentials. The server reads these plus `GOOGLE_CLIENT_ID`-style UPPER_CASE names.

Ranked data persists in SQLite at `ranked.db` (gitignored), or `RANKED_DB` if set.

## Deployment

fly.io app `erik-minesweeper` at msbattle.net. `fly deploy`. The Dockerfile uses
`node:24-alpine`; a fly volume `minesweeper_data` is mounted at `/data` and
`RANKED_DB=/data/ranked.db` keeps ratings across restarts.

## Conventions

- Boards are always no-guess solvable; one shared layout per round with the centre
  pre-revealed.
- Board size is a per-room preset (small 10×13 / medium 15×20 / large 16×30) and mines
  are a density fraction of the cells, so difficulty stays consistent across sizes.
  Dimensions are passed into `createGame`/`createTemplate`; the solver and bot derive
  them from the board array; the client receives `rows`/`cols` in room state.
- Ranked uses a fixed ruleset (Best of 5, 2 min rounds, 5s mine penalty, medium board,
  10% mines), pairwise Elo, tiers, and a leaderboard. Filler bots are tuned to the
  lobby's average rating and trickle into the queue like real players.
- Ranked filler bots come from a **pre-benchmarked pool** (`bots-pool.json`, committed),
  not synthesized on the fly. Each pool bot is a random set of knobs (speed, mistake rate,
  chord rate, solver-tier ceiling) whose Elo was *measured* by simulating it solving boards
  at the three ranked densities (10/15/20%) and mapping its solve times onto the
  `configForElo` calibration curve. Matchmaking calls `botPlayer.pickBotFromPool(targetElo)`.
  Regenerate the pool with `node scripts/generate-bot-pool.js` (takes a few minutes; tune
  with `POOL_SIZE` / `BOARDS` / `CAL_SAMPLES` env vars — lower them for a quick smoke run).
  Re-run it whenever bot AI, the solver, or the Elo curve changes.
