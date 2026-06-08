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
- `NoGuessGenerator.js` — `createNoGuessTemplate` + `analyzeSolvability`, which verifies
  no-guess solvability by running the **capped CSP solver** (`GEN_MAX_COMPLEXITY`, kept
  below the case-split threshold so generation stays fast) and, from that same solve,
  bakes a per-cell **difficulty map** (`template.difficultyByCell`, CSP complexity per cell).
- `RoomCreator.js` — room and best-of-N series state.
- `BotPlayer.js` — bot AI. Each bot has six per-move variables (`speedMs`, `difficultyMs`,
  `distanceMult`, `maxDifficulty`, `mistakeRate`, `chordRate`); `computeMoveDelay` scales the
  pause by the move's actual numeric difficulty (from the board's difficulty map) and the bot
  guesses when the easiest available move exceeds `maxDifficulty`. Also the random-knob
  generator (`randomBotConfig`), pool loader/picker (`loadPool` / `pickBotFromPool`), and
  casual presets (`configForDifficulty`). `configForElo` survives only as the offline
  calibration anchor — nothing at runtime calls it.
- `BotBench.js` — headless bot benchmarking: replays a bot's real decision loop on a
  virtual clock to measure solve time, calibrates time→Elo against the `configForElo`
  curve, and rates a config. Reads each board's difficulty map off the template. Used by
  `scripts/generate-bot-pool.js`; no I/O of its own.
- `CSPSolver.js` — constraint solver: `analyzeBoard(board, state, {revealCell, maxComplexity})`
  returns per-move numeric `complexity` and `solved`. The `maxComplexity` cap prunes the
  search and skips case-splits below 8 — it's both the generation difficulty ceiling and the
  model for a bot's skill ceiling.
- `db.js` — SQLite (`node:sqlite`) for accounts, sessions, and ratings.
- `StartPatterns.js` — size-parametric enumeration of starting-cascade positions (any H×W
  block) and the unique first-deduction patterns they yield, reusing `Patterns.js`'s
  canonicalisation. Driven by `scripts/generate-patterns.js`, which catalogues into
  `deduction-patterns.json` tagged by source size. Served by `GET /api/start-patterns` and
  shown on the **Start patterns** admin page (`#/admin/start-patterns`, `StartPatternsView.js`,
  reusing `PatternsView.js`'s board renderers). `geometry(H,W,walls)` also enumerates blocks flush
  against board edges — open / wall / corner placements (walls remove ring cells and add `wallCells`
  to the pattern, drawn as dark tiles). The script has **two passes**: (1) exhaustive enumeration of
  every ring arrangement for **3×3 + 3×4** (open/wall/corner), and (2) a **curiosity sweep** of two
  named clue rings — all-1s, and 4s-in-corners/2s-along-edges — for every block size **3×3 up to 9×9**.
  Exhaustive enumeration is only viable up to ~4×4 (ring grows with block size; 4×4-open alone ≈ 6 min,
  see the ring≤24 / `BRUTE_LIMIT` guards), so the sweep builds just those two tuples and runs the same
  extractor; rings past the brute-force limit fall back to the analyzer-deduced forced set.
  Findings: starting cascades yield very few unique patterns (40 total) and the complexity
  **ceilings at ~8** (case-split rings + one 3×4-open subset at 8.44) regardless of block size;
  bigger blocks add only larger versions of the same case rings, and wall/corner add 3 *easier*
  (cx ≤ 2.7) edge patterns. Hard patterns (chain/enum) live mid-solve, not at a fresh opening —
  starting positions aren't a source of hard building blocks. **mod-3 parity law:** the all-1s and
  corners-4/edges-2 rings force a deduction (always a cx-8 case-split) **iff neither H nor W ≡ 2
  (mod 3)**; otherwise the ring is fully ambiguous and forces nothing. This holds out to 9×9 — the
  difficulty never rises above 8, so larger blocks never mean harder building blocks.
- `scripts/combine-patterns.js` — composes two start patterns into one board to test whether
  *combining* building blocks beats the single-opening ~cx-8 ceiling. It lays two blocks side by
  side so their unknown rings either share a seam column or sit a gap apart, solves for a concrete
  mine layout (backtracking) so each is a real `{rows,cols,mines,revealed}` board, and scores it
  with `PuzzleGenerator.analyzeWithTracking`. Writes `combined-puzzles.json`; served by
  `GET /api/combined-puzzles` (+ `/:id/analyze`) and shown on the **Combined puzzles** admin page
  (`#/admin/combined-puzzles`, `CombinedPuzzlesView.js`), which reuses the All-Puzzles
  `renderPuzzleListCard` / `openAnalyzeModal` (both now take an analyze-endpoint base arg) so each
  card is playable and Analyze shows the solver trace. Findings: composing genuinely helps — a
  `#15⊕#16` 1-column-gap board is fully solvable at cx 5.9 (vs 2.69 alone), and two heavy
  `corners4-edges2` rings sharing a seam reach cx 9.7 (past 8, though it stalls before a full
  solve). Some pairs (`#15⊕#16`, `#16⊕#16` at a shared seam) have **no consistent mine layout** —
  the clue rings conflict at the seam — surfaced as a note on the page since they can't be a board.

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
- `Input.js` — pointer/touch/keyboard handlers, local reveal/chord mirrors. Keyboard
  actions are resolved through `keybindings.actionFor()`.
- `Keybindings.js` — rebindable in-game keyboard controls (persisted to `ms_keybinds`),
  the Controls section rendered on the Profile page, and the dynamic in-game hint line.
- `BotsAdmin.js` — admin bot browser (`#/admin/bots`): paginated/sortable/Elo-filterable
  view of the pool via `GET /api/bots`, plus the server-driven "watch a bot play" modal
  (`bot_demo_start`/`stop` → `bot_demo_board`/`move` sockets; renders frames with `drawCell`).
- `MobileLayout.js`, `Sound.js`, `Overlay.js`, `RoundTimer.js`,
  `DangerWarning.js`, `BoardDecoder.js`, `Router.js`, `Auth.js`,
  `Ranking.js`, `Leaderboard.js`, `Profile.js`, `Lobby.js`,
  `MatchPanels.js`, `GameRoom.js`, `Solo.js`, `Learn.js`,
  `StartPatternsView.js`, `CombinedPuzzlesView.js` — one feature each.

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
  not synthesized on the fly. Each pool bot is a random point in the six-variable space
  (speed, per-difficulty thinking, distance multiplier, max-difficulty ceiling, mistake
  rate, chord rate) whose Elo was *measured* by simulating it solving boards at the three
  ranked densities (10/15/20%) and mapping its solve times onto the `configForElo`
  calibration curve. Distinct play styles can land at the same Elo (a fast guesser vs a
  slow, thorough solver). Matchmaking calls `botPlayer.pickBotFromPool(targetElo)`.
  Regenerate with `node scripts/generate-bot-pool.js` (a few minutes; tune with
  `POOL_SIZE` / `BOARDS` / `CAL_SAMPLES` env vars). **Re-run it whenever bot AI, the CSP
  solver/complexity costs, `GEN_MAX_COMPLEXITY`, or the Elo curve changes** — the measured
  ratings depend on all of them.
