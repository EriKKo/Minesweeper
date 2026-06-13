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

There is no build step. `npm test` runs the integration tests (`node --test`,
`test/*.test.js`) — they boot the real server on an isolated port + throwaway DB and
check the `/api/*` surface; `test/helpers.js` is the spawn harness. To verify UI
changes, run the server and drive the app in a browser at http://localhost:1337.
Pure logic (board generation, the no-guess solver, bot behaviour, Elo) can be checked
with short `node -e` scripts.

## Layout

Source is split into three trees under `src/`:

**`src/server/`** — Node + socket.io backend. Organised into role subfolders; the entry
(`minesweeperServer.js`) and shared persistence (`db.js`) sit at the root, and everything
else is grouped:
- **`src/server/engine/`** — pure game logic / generators / solvers / benches, no http/socket/db
  coupling (`GameCreator`, `NoGuessGenerator`, `RoomCreator`, `BotPlayer`, `CSPSolver`,
  `PuzzleGenerator`, `InsideOutGenerator`, `RingSeedGenerator`, `StartPatterns`, `Patterns`,
  `TerritoryGame`, `TerritoryGenerator`, `BotBench`, `TerritoryBench`). The files `scripts/` import.
- **`src/server/runtime/`** — the http + socket runtime: shared state + the socket-handler modules
  (`appState`, `gameUtil`, `ranked`, `elo`, `bots`, `puzzlePlay`, `botDemo`, `standings`,
  `roomState`, `session`, `territory`, `staticServer`, `oauth`, `puzzleApi`).

(File bullets below use bare names; resolve them under `engine/` or `runtime/` per the lists above.)
- `minesweeperServer.js` — HTTP + socket.io entry (at `src/server/` root): rooms, series, ranked
  matchmaking, bot orchestration. Its HTTP handler is a pure router — `/auth/*` → `oauth.js`,
  `/api/*` → `puzzleApi.js`, everything else → `staticServer.js`. **Error containment:** every
  socket event handler is wrapped in try/catch (the `socket.on` patch at the top of the
  connection handler, covering core + module handlers), and `uncaughtException`/`unhandledRejection`
  are caught at the process level — so a thrown handler/timer error is logged and the server keeps
  running instead of crashing and dropping every connected player.
- `staticServer.js` — serves client assets out of `src/client/` and `src/common/`,
  with the SPA fallback (extensionless unknown paths serve `index.html`).
- `appState.js` — the server's shared mutable state in one place: the live collections
  the socket handlers operate on (`rooms`, `games`, `sockets`, `names`, `accounts`,
  round/series timers, the bot registries, the ranked queues, territory/puzzle timers),
  plus `io`. A singleton — `minesweeperServer` aliases each locally (`var rooms =
  appState.rooms`, mutated in place, never reassigned), and the handler modules split
  out of the server share the same objects by requiring it. Primitive id counters
  (`nextRoomId`/`nextBotId`) are not in it.
- `ranked.js` — ranked matchmaking: the per-mode queues, the bot-trickle filler, and
  `formRankedMatch` (builds the room, seats humans + bots, hands off to the series start).
  Owns the `RANKED_MODES` catalogue + bot-join timings. When a match forms it emits `match_reveal`
  then, after a short `MATCH_REVEAL_MS` beat (no roster modal — the search waiting room already
  showed the field), starts the series; the client drops straight into the game layout with a
  covered board. Coupled to the core
  like territory, so its core services (`createPlayerGame`, `addBotToRoom`,
  `broadcastRoomState`, `startSeries`, `readUserRating`, a room-id source, `RANKED_RULES`,
  `MAX_BOTS_PER_ROOM`, `PROVISIONAL_GAMES`, `io`) are injected via `ranked.init(deps)`; queue
  state is `appState` and `botCount` comes from `gameUtil`. The server delegates
  `find_ranked`/`cancel_ranked`/disconnect to `ranked.isValidMode`/`enqueue`/`dequeue`.
- `elo.js` — the rating math: the pairwise-Elo formula (`applyRankedElo`), the per-style
  rating reader (`readUserRating`), and the tournament per-player variants
  (`applyEloForPlayer`/`tournamentEloParts`, so a cut player is rated the moment they're
  eliminated). Pure math over `db` + the `appState` accounts/botRating; the standings it
  consumes are built in the core. `RANKED_BOT_RATING`/`PROVISIONAL_GAMES` are injected via
  `elo.init(deps)` (`isBot` comes from `gameUtil`). Consumed by the core endgame, `ranked`, and `territory`.
- `bots.js` — racing/casual/ranked bot orchestration: add/remove bots, apply their per-move
  config to the game, and the per-move tick (`decideMove` → a delayed `handleLeftClick`, then
  reschedule). The bots play through the same game objects + move path as humans; `createPlayerGame`
  is injected via `bots.init(deps)`, and the game-loop helpers (`updateDraw`) + shared predicates
  (`isBot`/`botCount`/`getRoomBotNames`) come from `gameUtil`. Per-bot state is `appState`. (Territory
  has its own bot tick in `territory.js`.) NB the server requires it as `botMgr` to avoid colliding
  with the `bots` state map (`botId → true`) that `isBot` reads.
- `puzzlePlay.js` — single-player puzzle play (rated / streak / storm / daily): the run
  lifecycle, serving puzzles near the player's rating, building the game, the hint pointer,
  and finalising with the puzzle-Elo exchange. Self-contained on `db` + the generators/solver +
  `gameUtil` (`obfuscateBoard`) — no `init` needed; state
  (`puzzlePlay`/`puzzleRun`) is `appState`. The server delegates the `puzzle_*` socket events
  (`registerSocketHandlers`), the puzzle branch of `left_click`/`right_click`
  (`handleLeftClick`/`handleRightClick`), and disconnect (`cleanup`). Required as `puzzleMode`
  (the `puzzlePlay` name is the appState map). Solo free-play board gen (`request_solo_board`)
  stays in the server.
- `botDemo.js` — the admin "watch a bot play" demo: builds a standalone no-guess game with a
  pool bot's variables and streams its play (one frame per move) to the watching socket. The
  admin gate (`isSocketAdmin`) and `RANKED_RULES` are injected via `botDemo.init(deps)`; state
  (`botDemos`) is `appState`. Server delegates `bot_demo_start`/`bot_demo_stop`
  (`registerSocketHandlers`) and disconnect (`stopBotDemo`).
- `standings.js` — turns a room's game results into ranked arrays: per-round standings
  (finishers first, then by finish time / safe count), the series winner, the cumulative-score
  series standings, and the tournament final standings. Reads game/room state + the accounts
  cache; the rating constants are injected via `standings.init(deps)` (`isBot` comes from `gameUtil`).
- `roomState.js` — room serialization + broadcast: the lobby summary (`room_list`) and the
  full `room_state` payload the client renders, pushed over socket.io. Reads room/game/account
  state from appState; `io`/the bot+rating constants are injected via `roomState.init(deps)` (`isBot` from `gameUtil`).
- `session.js` — session/auth attach: `loginSocket` binds a real-or-guest user to a socket
  (accounts/names + the `authenticated` snapshot) and registers the auth socket events
  (`authenticate`/`guest_session`/`sign_out`/`set_name`). Reads appState + db + roomState + `gameUtil`
  (`updateDraw`); `PROVISIONAL_GAMES` injected via `session.init(deps)`. (OAuth redirect is `oauth.js`;
  clients then `authenticate` here.)
- `gameUtil.js` — small shared game helpers depending only on appState + crypto: the bot/player
  predicates (`isBot`/`humanCount`/`botCount`/`getRoomBotNames`), the board obfuscator
  (`obfuscateBoard`), the per-game broadcast payload (`gameForBroadcast`), and `updateDraw`
  (push each player their `draw_board` frame). Required across the server + modules.
- `puzzleApi.js` — the admin/puzzle HTTP API: everything behind `/api/*` (the All-Puzzles,
  Bots, Patterns, Starting-positions, Combined-puzzles pages), the background
  puzzle-generation job, and the startup pool top-up. Pure HTTP + db + generators, no
  room/game/socket state. Exposes `handleApiRoute(req,res,url)` and `ensurePoolTopUp()`.
  (Live puzzle *play* — `serveRunPuzzle` and its socket flow — stays in the server.)
- `oauth.js` — provider login (Google / Discord, GitHub server-side, and the
  `DEV_AUTH` dev shortcut): reads its config from the environment, manages the CSRF
  `state` nonces, exchanges codes, resolves/upserts the user via `db`, and redirects
  to `/#token=<session>`. Exposes `handleAuthRoute(req,res,url)` (the server's HTTP
  handler early-returns on it), `DEV_AUTH`, `OAUTH_BASE`, and `providerFlags()` (which
  providers the client shows buttons for).
- `GameCreator.js` — board/game state factory + mine placement.
- `NoGuessGenerator.js` — `createNoGuessTemplate` + `analyzeSolvability`, which verifies
  no-guess solvability by running the **capped CSP solver** (`GEN_MAX_COMPLEXITY`, kept
  below the case-split threshold so generation stays fast) and, from that same solve,
  bakes a per-cell **difficulty map** (`template.difficultyByCell`, CSP complexity per cell).
- `RoomCreator.js` — room and best-of-N series state.
- `BotPlayer.js` — bot AI. Each bot has six per-move variables (`speedMs`, `difficultyMs`,
  `distanceMult`, `maxDifficulty`, `mistakeRate`, `chordRate`); `computeMoveDelay` scales the
  pause by the move's actual numeric difficulty (from the board's difficulty map) and the bot
  guesses when the easiest available move exceeds `maxDifficulty`. It finds that easiest safe move
  with `CSPSolver.findNextSafeStep` (capped at `BOT_COMPLEXITY_CAP` = 7.999 so bots never use the
  case split — they top out below it and guess instead). Also the random-knob
  generator (`randomBotConfig`), pool loader/picker (`loadPool` / `pickBotFromPool`), and
  casual presets (`configForDifficulty`). `configForElo` survives only as the offline
  calibration anchor — nothing at runtime calls it.
- `BotBench.js` — headless bot benchmarking: replays a bot's real decision loop on a
  virtual clock to measure solve time, calibrates time→Elo against the `configForElo`
  curve, and rates a config. Reads each board's difficulty map off the template. Used by
  `scripts/generate-bot-pool.js`; no I/O of its own.
- `CSPSolver.js` — the **one and only solver** (the old pass-based `PuzzleSolver` was removed; CSP both
  rates a whole board and serves the next move). `analyzeBoard(board, state, {revealCell, maxComplexity})`
  returns per-move numeric `complexity` and `solved`; `findNextSafeStep(board, state, {maxComplexity, allow})`
  returns the single easiest forced move (`{kind, clueCells, safeCells, mineCells, componentSize}`) — used by
  the in-game hint pointer and by bots (with `allow = canTarget` to restrict to a bot's reachable frontier in
  territory). It absorbed `constraintAt` + `findEnumSteps` so it has no dependency on any other solver.
  The `maxComplexity` cap prunes the search —
  it's both the generation difficulty ceiling and the model for a bot's skill ceiling. Hard deductions
  (beyond trivial/subset) use, in order: a **sound 1-cell case split** (`findCaseSplitStep`, cost
  `CASE_BASE`=8 + branch) then **sound enumeration** (`findEnumSteps`: enumerate every consistent mine
  configuration of a frontier component ≤ `ENUM_CAP`=18, take only cells forced across ALL of them).
  **Soundness of the case split:** it hypothesises a frontier cell safe-vs-mine and propagates each branch
  over the VISIBLE clues only — a deduced-safe cell is marked `SAFE` (removed from its neighbours' mine
  candidates) but is **never revealed and its clue is never read**, so a hypothesis can't consult the
  hidden solution. It concludes a cell only when one branch contradicts (forcing the other) or both
  branches agree. The previous case split was UNSOUND: its "safe" branch revealed the hypothetical cell
  and cascaded using the TRUE board clues, so it could "prove" cells that public info doesn't force (e.g.
  resolve a genuine 50/50 just because it's safe on this board). The sound version was verified by a
  per-step audit (brute-force the visible state before each case step; 0 violations over 159 adversarial
  corner boards). None of this touches the real game: generation/bots cap below `CASE_BASE` so they use
  only trivial/subset/enum — every stored puzzle's `csp_method` is trivial/subset/intersect/union, never
  case/enum — so the change only affects the uncapped Analyze modal and ratings of non-no-guess boards.
- **Puzzle difficulty score** (`PuzzleGenerator.complexityScore`): sort the solve's per-move
  complexities high→low and sum `c / X^rank` with `X = 3.5`. The hardest move counts fully; each
  further hard move adds a geometrically-decaying share (bounded by `c_max · X/(X-1) ≈ 1.4×`), so
  stacking hard deductions is rewarded while a long tail of easy moves saturates — many *hard*
  moves matter, raw *length* doesn't. `rating = max(0, round(240·(score − 0.5)))`; the difficulty
  *tier* (t1–t6) is bands on `maxComplexity` alone. Bump `db.CURRENT_SCORING_VERSION` when the
  formula changes — a startup backfill re-rates every stored puzzle below it.
- `db.js` — SQLite (`node:sqlite`) for accounts, sessions, and ratings.
- **Guests & auth.** There's no login wall: a visitor with no stored session auto-starts a **guest**
  (client emits `guest_session` on connect → `db.createGuest()` makes a real `users` row flagged
  `is_guest`, provider `"guest"`, name `"GuestNNNNN"`, default ratings; the server mints a session and
  returns its token in the `authenticated` payload so the guest persists across reloads). Guests are
  normal users — they play ranked and accumulate Elo — just hidden from the leaderboard (`topPlayers`
  filters `is_guest = 0`). **Upgrading:** when a guest hits Sign in, the client threads its session token
  as `?upgrade=<token>` into the OAuth login; the callback (`resolveOAuthUser` → `db.upgradeGuest`)
  attaches the provider identity to the SAME row (keeping id/rating/stats) — unless that provider account
  already exists, in which case it logs into the existing account and discards the guest (`switched`).
  Sign-out drops back to a fresh guest, never a login wall. Client: `Auth.js` (`applyConnected` →
  `guest_session` when tokenless; `applyAuthenticated` stores `data.token` + shows the guest "Sign in"
  button vs a real account's "Sign out"); the repurposed `#name_view` is the on-demand sign-in / rename card.
  **Cleanup:** drive-by guests are reaped by `db.pruneStaleGuests(maxAgeMs)` (deletes `is_guest=1` rows
  with `played=0` AND `puzzles_attempted=0` older than the TTL, plus their sessions/attempts; a guest who
  played anything is kept). The server runs it on startup and daily (`reapGuests`, TTL = `GUEST_TTL_DAYS`
  env, default 7).
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
- **Corner-mine starting positions** (`scripts/generate-corner-positions.js` → `starting_positions`
  table, admin "Starting positions" page `#/admin/starting-positions`, `StartingPositionsView.js`).
  A separate family from the plain 3×3 cascades: a **4×4 opening with one corner a covered mine the
  solver must deduce** (not pre-flagged) — the far interior still has a 0-cell, so it floods like a
  real cascade. The script enumerates every surrounding ring layout (2²⁰), dedups by revealed-clue tuple
  (76 352 distinct openings), and rates each **realistically**: it takes the lexicographically-smallest
  consistent ring layout (the same concrete board the Analyze modal rebuilds), constructs the real board,
  and solves it **with cascades** — recording **max** (hardest single deduction) and **total** (sum) from
  the analyzer's own `maxComplexity`/`totalComplexity`. NB this metric evolved: an early version analyzed
  the frozen opening with no layout and no cascades (inflating ratings), and it relied on the old UNSOUND
  case-split; with cascades + a concrete layout + the sound solver, the hardest openings now top out around
  **cx 11** (a sound case split). **Only ~58% (44 091/76 352) are fully solvable** — the surrounding ring
  is underconstrained, so these are families of boards, not single puzzles; the family is a curiosity, not
  a real source of hard puzzles. Forced safe/mine ring cells come from the exact brute-force closure
  (layout-independent). It
  stores a **~200 sample**: always the single hardest opening, plus an even random sample across the
  `floor(max)` bands. Stored as `size=4`, `variant="corner4"`, with `total_complexity`/`max_complexity`
  columns — so the admin **Family** filter (`3×3 cascade` vs `4×4 corner-mine`) keeps them apart from the
  plain cascades (default `size=3` view); `StartingPositionsView.js` renders them on a 6×6 board
  (`paintCornerPosCanvas`, corner drawn as a flag) with an **Analyze** button (`GET
  /api/starting-positions/:id/analyze` → `cornerStartingPuzzle` rebuilds the concrete board, reusing the
  All-Puzzles solver-trace modal). Re-run the script to regenerate the sample.
- **Puzzle scouts** (`scripts/scout-corner-positions.js`, `scripts/template-scout.js`) — report-only search
  tools for finding genuinely-hard *solvable* openings (the kind that require case analysis, not just a long
  subset chain). `scout-corner-positions.js` sweeps the H×W corner-mine family (env H/W, MAX_MINES);
  `template-scout.js` is the **general** version: you write a board template (text grid; tokens `0-8`
  revealed-fixed, `?` revealed-any, `#` covered-any/free, `*` covered-mine, `s` covered-safe-any, `A-I`
  covered-safe-fixed-0..8; aliases `.`=`#`, `M`=`*`) and it enumerates every consistent mine layout (sparse,
  `MAX_MINES`), buckets by the opening, **skips openings with no forced-safe cell** (unsolvable — no first
  move — found for free from the per-cell mine-frequency closure, never invoking the solver), solves the
  rest WITH cascades (capped at `ANALYSIS_CAP` to skip non-human brute-enum), and prints the hardest
  fully-solvable board. Findings so far: corner-mine families are nearly barren (3 case gems in 4×4, 0 in
  4×5/5×5); two coupled mines hit far more; constructive generation (`InsideOutGenerator`) makes hard
  *subset*-solvable puzzles (cap ~2600 rating) but structurally **cannot** produce case-analysis ones,
  because it follows the analyzer's cheapest forced move so a cheap solving path always exists by construction.
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
- `TerritoryGenerator.js` / `TerritoryGame.js` — the **Territory (versus)** mode: players grow from
  the corners of ONE shared board, claiming cells (vs the racing modes where each player has a private
  state matrix over a shared layout). Supported with **2 players** (opposite corners, 18×30) or **4**
  (one per corner — `generate({corners: 4})`, on a bigger 24×40 board; `territoryDims(players)` picks
  the size). The generator is generate-and-test: a random
  board with the top-left corner block mirrored onto every other corner (180° for 2; the full
  horizontal/vertical/180° set for 4) and every cascade capped, so all start openings are **identical**,
  plus a mine-free **start zone** (Chebyshev radius 3) at each corner, kept only if it's **no-guess
  solvable from EVERY corner** (verified per-corner with `NoGuessGenerator.analyzeSolvability`) — the
  interior is independent, not symmetric. `TerritoryGame` is N-player throughout (per-player owner /
  scores / capture); it holds the single `state` + an `owner` matrix,
  enforces contiguous growth (you may only reveal a covered cell adjacent to your own territory). Hitting
  a mine now simply **freezes** you for `FREEZE_MS` (3 s) via `g.hitMine` — the old self-explosion (which
  re-covered a patch of your own territory) was removed; the cell stays a covered mine. The ONLY thing
  that re-covers territory now is an opponent's **energy bomb** (see below). A re-cover that leaves a cell
  next to a revealed 0 is auto-revealed (`fillUncascaded`) but claimed by the OWNER OF THAT 0-cell, so a
  blast only ever feeds the player whose own open ground forced the reveal.
  **Energy bombs** (`g.requestBomb` / `g.detonateBomb`): spend `BOMB_COST` (1000) energy to launch a missile
  from a random generator (structure) you own at a target cell. After a distance-scaled flight the blast
  re-covers a Euclidean `BOMB_RADIUS` (≈2.6) circle as **neutral** ground, wiping flags + infrastructure
  (structures/lines) there. The mines under it are re-rolled at board density to a **no-guess-solvable**
  layout (`regenPatch` — border-constrained backtracking + `solvableFromBorder`, ≤`BOMB_REGEN_TRIES` tries;
  falls back to the existing layout if none found) and the changed clues are patched to clients. **Claim
  lock:** for `BOMB_CLAIM_LOCK_MS` (5 s) after impact only the launcher may take the crater — each crater
  cell gets `g.bombClaim["r,c"] = {pid, until}`, and `g.claimLocked(pid,r,c)` blocks everyone else in
  `canReveal`, the reveal cascade, and `fillUncascaded` (so neither a click nor a cascade nor an auto-fill
  can grab it); after 5 s it opens to anyone. `g.claimList(now)` (broadcast as `claims`, also prunes
  expired) drives the client overlay. Wiring: `territory_bomb` socket event → `requestBomb` (validate energy
  / pick silo / stage `_missile`) + broadcast, then a `setTimeout(flightMs)` → `detonateBomb(tr,tc,pid,now)`
  + broadcast. The blast reuses the `_explosion` payload (`{origin, recovered, clues, bomb:true}`);
  `bomb:true` makes the client clear EVERYONE's flags in the area. Client: HUD `tv-bomb-btn`
  (cost + affordability, `territoryToggleAim`) or the **S** hotkey → aiming mode (crosshair, Esc cancels) →
  next board click emits the bomb (`territoryLaunchBomb`, intercepted in `performAction`); the missile
  animates via `territoryMissiles`/`drawTerritoryMissiles`, and the claim lock pulses in the launcher's
  colour via `territoryClaims`/`drawTerritoryClaims`.
  Server wiring lives in `territory.js` (extracted from `minesweeperServer`): it owns the
  territory socket handlers + helpers (start/end/broadcast/bot-tick/world-tick) and the
  territory board sizes/density. Because it's both called from the core (start/leave/click)
  and calls back into it (`clearRoundTimer`, `applyRankedElo`, `broadcastRoomState`/`List`), those
  few callbacks + `io`/`COUNT_DOWN_TIME` are injected once via `territory.init(deps)` to avoid a
  circular require; `obfuscateBoard`/`isBot` come from `gameUtil` and everything else is `appState`. The server
  delegates: `room.gameMode === "territory"` →
  `territory.startGame` builds one shared game; `left_click` routes to `territory.handleReveal` → `tg.reveal(pid,r,c,now)`
  and broadcasts `territory_board` (`state`+`owner`+`scores`+`frozenUntil`); **there is no round clock**
  (`roundSeconds: 0` — and ranked formation now honors an explicit `0` via
  `typeof modeDef.roundSeconds === "number"`, so territory no longer silently inherits the
  120s default). **The game ends only on elimination** — when just one player still holds any ground
  (`maybeEndTerritory` → `tg.alive() <= 1`, "eliminated") — or a player leaves, or a genuine deadlock
  (`tg.deadlocked()`: nobody can expand AND no fort stands to re-open the board, "deadlock"). Clearing
  every safe cell is NOT an end — that's when the invasion war begins. Winner = most cells. **Entry points:** "Create
  Territory (1v1)" and "Create Territory (4-player)" buttons in the custom lobby (`create_room` with
  `players: 2|4`; `startTerritoryGame` accepts 2 or 4 and seeds one player per corner from
  `TERRITORY_COLORS = [cyan, amber, violet, rose]`), and **ranked** `territory_duo` (2-player) /
  `territory_quad` (4-player) modes chosen from the territory ranked picker (`RANKED_PICKER_META`,
  style `"territory"`, filled with bots like the other ranked modes) — both share the one
  `rating_territory` Elo ladder; `endTerritoryGame` applies rank-based Elo across all players (so it
  works for 4 as well as 2) and reports the delta in `territory_result`. **Client:
  `Territory.js` renders on the SHARED game board** (`#game0` / `renderPlayerBoard` / `drawCell`),
  not a bespoke canvas — it sets `myState` from the shared state, feeds an owner-colour grid that
  `drawCell` tints (via `view.getOwner`, null in other modes) — and applies **fog-of-clues**: clue numbers
  show only on cells you own PLUS opponent cells that border one of yours (the contested frontier);
  opponent cells deeper in their territory show their owner tint but no number (`view.hideClue`), so you
  can't read your opponent's board — and routes clicks through
  `Input.performAction`'s `"territory"` mode. Like the other modes it **predicts locally** — the
  client decodes the board, so `territoryLocalReveal` reveals+cascades+claims a safe move instantly
  and then emits; the server still owns mine hits (explosions), enclosure capture and validation. The
  next `territory_board` **merge-reconciles** rather than overwrites: a cell you've already revealed is
  never un-revealed by a server board unless that board's `explosion.recovered` list actually re-covered
  it — so a broadcast that races ahead of your reveal's echo (an opponent moving) can't flicker your
  cells back to covered, and the reverse-cascade animation is driven off that same `recovered` list
  (never a diff), so it only ever plays on the exploder's cells. Reusing the real board means keyboard focus, right-click `preventDefault`, hit-testing
  and animations all work for free. Racing chrome is hidden via a `.territory` class on `#game_view`
  plus a small territory score-bar HUD (chip · bar · chip for 2; a chips row over a segmented bar for
  4, built from `territoryInfo.players`). **Bots** use the same `BotPlayer.decideMove` AI as the
  racing modes, fed a game view with two extra knobs (no-ops for racing): `canTarget(r,c)` limits
  reveals to the bot's own frontier (`tg.canReveal` + excluding mines it has detonated) and
  `revealsOnly` drops flags/chords. `scheduleTerritoryBot` ticks it on a speed/difficulty-scaled
  cadence; `tg.mineKnown` keeps it from re-hitting a mine. Bots are picked for territory by a
  **separate measured rating** (`b.ratings.territory`): `TerritoryBench` replays a bot's decision loop
  clearing a no-guess territory board against a non-moving opponent on a virtual clock (mirroring
  `BotBench`, but mine hits cost a re-cover + freeze instead of a flat penalty), and
  `scripts/calibrate-territory.js` (fanned across `territory-bench-worker.js`) maps clear time to an Elo
  and writes `ratings.territory` onto every pool bot; matchmaking calls `pickBotFromPool(elo, w,
  "territory")` and targets the lobby's territory Elo. So the bot doesn't needlessly guess into mines,
  `CSPSolver.findNextSafeStep` takes the bot's `canTarget` predicate via its `allow` option (territory only)
  and only counts a
  safe deduction as a result when it has a cell on the bot's own frontier — a safe move the bot can't
  reach no longer short-circuits it into a guess; it keeps searching for a frontier-safe move. This
  both cuts territory mine-hits and gives the calibration real resolution across the Elo range.
  **Enclosure capture**
  (`tg.captureEnclosed`, run after every reveal): a region you've sealed off so that **only you can
  reach it** — two reachability floods (each spreads **8-connected** from a player's land through covered
  cells only, matching `canReveal`'s 8-adjacency expansion — using 4-connectivity under-counted reach and
  let the capture STEAL cells the opponent could still grab diagonally, ending games early; the
  opponent's land AND neutral dead ground are walls), capture = cells your flood reaches but the
  opponent's doesn't — is claimed. This captures regions pinned against a **board edge** too, not just
  interior pockets (the edge isn't an escape). Captured covered non-mines are revealed and claimed,
  mines stay a covered dead pocket. **Enemy pockets flip too** (second pass, connectivity-based):
  "freedom" = reaching the board border through any NON-your cell (your cells are the only walls). A
  player starts on the border, so they stay free until you wall their land off from every edge; anything
  you seal into the interior — opponent cells AND the neutral/covered ground trapped with them (e.g. bomb
  craters) — can no longer reach the border and is captured (enemy land revealed + claimed, sealed mines
  become your covered structures). A covered/neutral boundary cell no longer saves an island; only a real
  escape route to the open edge does. Both passes skip cells under a bomb claim lock (`g.claimLocked`).
  Fully surrounding an opponent away from the edges captures their territory and can eliminate them.
  **Structures + offensive beams (PvP invasion).** A connected blob of covered mines whose entire outer
  boundary you own becomes your **structures** (`g.updateStructures`, run after every board change — it
  flood-fills each 8-connected mine group and claims the whole group if one player rings it, so clusters
  of mines count, not just lone ones): owned by you (counts toward
  score, NOT toward `claimedSafe`), auto-flagged, rendered as a coloured flag with a charge gauge. Each
  has a **cooldown** that recharges faster the more territory you hold (`cooldownFor` ∝ your cell count).
  Left-clicking your charged structure fires `g.fireStructure` → a **directional beam** at the nearest
  enemy cell: it travels over your land/neutral, then re-covers a 3-wide channel of the enemy's territory
  (`BEAM_LEN` deep) — those cells go neutral and you re-claim them by expanding in. An enemy **structure
  in the path ABSORBS** the beam: it's destroyed (reverts to a neutral mine) and the beam stops there, so
  forts are sacrificial defence. Re-cover stays consistent via the shared `fillUncascaded` (reused from
  explosions). Wiring: `territory_fire` socket event; `broadcastTerritory` sends `structures`
  (`{r,c,owner,readyInMs,cooldownMs}`, client interpolates the gauge) and a one-shot `fire`
  (`{pid,from,to,recovered,destroyed}`) for the breach + beam-streak animation (`territoryBeams` /
  `drawTerritoryBeams`, a fading glowing line from fort to impact in the firer's colour). NB: beams
  re-open cleared cells to NEUTRAL (claimable by either side), so they don't permanently capture — a
  defended core a bot keeps re-revealing can stalemate, since elimination is now the only win. A beam
  that captures the channel for the firer (or a domination tiebreak) is the open follow-up.

  **Energy infrastructure (`TerritoryGame.js`).** A structure (claimed mine) is also an energy
  **extractor**: it spends `EXTRACTOR_BUILD_MS` (15s) under construction, then produces `EXTRACTOR_RATE`
  (1/s) energy for its owner. `g.extractorStartedAt["r,c"]` is stamped when the cell is first claimed (in
  `updateStructures`) and cleared when its enclosure breaks. Running extractors auto-wire **energy lines**
  to their nearest same-owner running extractors (`g.recomputeLines`, ≤ `LINE_MAX_LINKS`=3 each within
  `LINE_RADIUS`=6 Chebyshev), stored in `g.energyLines["r,c|r,c"] = {owner,startedAt}`; a line spends
  `LINE_BUILD_MS` (10s) building then adds `LINE_RATE` (0.6/s). Energy banks per player in `g.energy`
  (`g.accrueEnergy` integrates rate×Δt lazily; `g.energyRate` sums running extractors + completed lines).
  A server `setInterval` (`startTerritoryWorldTick`, ~1/s, cleared in `endTerritoryGame`) calls
  `g.tickWorld` (accrue + re-wire) and re-broadcasts so the economy advances even when nobody clicks.
  `broadcastTerritory` adds `energyLines` (`energyLineList`: endpoints + `buildInMs`/`buildMs`), per-
  structure `buildInMs`/`buildMs`, and `energy`/`energyRate` per player. **Client:** `territoryStructures`
  entries carry `builtAt`/`buildMs`; `drawCell` shows a construction ring (`drawExtractorBuild`) until
  built, then a glowing core (`drawExtractorCore`) + the beam gauge; `drawTerritoryEnergyLines` renders the
  grid as **faint orthogonal (Manhattan) traces** along the grid axes (`territoryGridPoint` routes
  horizontal-then-vertical; dashed while building, very low alpha when done) with occasional **energy
  packets** (`territoryPackets`) blipping along them — spawned on a randomised cadence by
  `territorySpawnPackets` from the 250ms tick (`territoryEnergyTickFn`), which kicks the rAF loop while a
  packet is in flight. The HUD chip shows banked energy (`territoryEnergy` +
  `territoryEnergyNow` interpolation, ticked every 250ms by `territoryEnergyTick`). Banked energy is the
  resource for the planned **energy explosions** (area wipe → re-covered cells, up for grabs) — not yet
  built; board re-randomisation of the wiped area is a later idea.
- `RingSeedGenerator.js` — turns a "4s and 2s" ring start (corners4-edges2) into a real solvable
  puzzle. That ring has exactly **2 symmetric solutions** and no single clue change breaks it (every
  change either over-constrains to 0 or loosens to 7–9 solutions), so it searches clue-change sets of
  increasing size (fewest first), keeps the ones that force a reveal, ranks by deduction complexity,
  and from the hardest down hands the seed to the inside-out generator to finish — keeping the first
  that comes out faithful (block clues still the ring values) and fully solvable. Two top-corner
  4→2 changes break the symmetry and grow into a solvable ~cx-7.9 board (rating ~2350). Driven by
  `combine-patterns.js` (group "Ring → solvable").
- `InsideOutGenerator.js` — deduction-driven generator: from a seed it asks the analyzer for the next
  forced move, commits each revealed cell's clue to the value that maximises full-solve complexity,
  and keeps only fully-classified (solvable-by-construction) boards. `constructFromSeed` is the shared
  loop, used by its own random-cascade `tryConstruct` and by `RingSeedGenerator`. NB: `analyzeBoard`
  returns *bundled* moves with `revealed`/`flagged` arrays and a `method` (no `action`); `applyMove`
  reads those — switching on `action` made it a silent no-op that produced zero puzzles.

**`src/common/`** — modules required by both runtimes (loaded via plain
`<script>` tag in the browser and `require()` on the server):
- `BoardLogic.js` — cascade, chord, neighbour iteration, the MINE/FLAGGED/
  UNKNOWN/KNOWN state sentinels.

**`src/client/`** — browser frontend, each file a single feature. `index.html`, `style.css`,
`favicon.svg`, `logo.svg` sit at the root; the JS modules are grouped into subfolders (served
transparently — the `<script src>` paths carry the subfolder, e.g. `/core/Main.js`):
- **`core/`** — the live-game runtime (`Main`, `Input`, `BoardRender`, `Animations`, `BoardDecoder`).
- **`ui/`** — cross-cutting UI infra (`Router`, `Auth`, `Overlay`, `Sound`, `Music`, `MobileLayout`,
  `Fullscreen`, `RoundTimer`, `DangerWarning`, `Keybindings`).
- **`views/`** — page/feature views (`Lobby`, `GameRoom`, `Profile`, `Leaderboard`, `Learn`, `Solo`,
  `Territory`, `PuzzlePlay`, `Ranking`, `MatchPanels`).
- **`admin/`** — admin views (`AdminList`, `BotsAdmin`, `PatternsView`, `StartPatternsView`,
  `StartingPositionsView`, `CombinedPuzzlesView`, `PuzzleLab`, `Puzzles`).

(File bullets below use bare names; resolve them under `core/`, `ui/`, `views/`, or `admin/`.)
- `index.html` — entry page: markup only. Every client module is a plain `<script>`
  tag (each becomes a global); they load in dependency order, with `Main.js` last.
- `Main.js` — the client entry / live-game core: the socket connection and all its
  `socket.on(...)` handlers (puzzle / solo / ranked / territory / game / tournament),
  the shared live-game state (`rows`, `cols`, `myState`, `playerCanvas`, the cell-state
  sentinels) the feature modules read as globals, and the top-level DOM/state wiring.
  Loaded last so those globals exist before anything uses them.
  **1v1 duel layout** (TetrisFriends-style battle): a 2-player racing match (`isDuoRacing()`) gets a
  side-by-side battle layout while playing — two equal boards facing off across a center VS column.
  The opponent board (`game1`) is sized to match the player board (`sizeOpponentCanvases()`) instead
  of the small sidebar thumbnail; the scoreboard/series side-cards are hidden. Each board has an
  **identity panel** (rank badge + name + tier via `buildDuelIdentity`/`fillDuelId`, reusing
  `buildRankBadge`/`tierFor`) and a **progress bar**; the center `#duel_center` holds a VS badge over
  a vertical **tug-of-war bar** (your colour rises from the bottom by your share of combined
  progress), and the **leading** board glows in its side colour — all updated per frame by
  `updateDuelHud()` in `draw_board`. Driven by a `duo` class on `#game_view` (CSS `.game-view.duo`,
  `--duel-you`/`--duel-opp`). Active during play, plus the ranked planning/reveal window so you see
  the opponent the moment you join (custom rooms stay normal in planning so their config shows); the
  opponent's board is painted covered (`paintOpponentCovered`) until their first real frame, so both
  boards show through the join + countdown. Both boards are pushed toward the center column so the VS
  sits exactly between them.
  The site footer is hidden whenever a game is on screen via a `body.in-game` class (added by the
  game entry points, removed in `hideAllViews`).
- `AdminList.js` — shared helpers for the paginated admin views: `renderPager` and the
  `applyQueryString` URL-filter-state write (All Puzzles / Bots / Patterns / Starting positions).
- `style.css` — all styles.
- **Routing** — clean History-API paths, no `#`. `Router.js`'s `navigate(path)` does `pushState` +
  `applyRouteFromHash()` (name kept for history; it now reads `location.pathname`); `popstate` handles
  back/forward; and a delegated document click handler turns same-origin `<a href="/…">` clicks into
  client-side navigations (so links just need a path href — `/auth/…`, external, hash, download, and
  new-tab links are left alone). Programmatic nav uses `navigate("/…")`. Filter views read state from
  `location.search` and `replaceState` it back. **Server SPA fallback:** any path with no on-disk file
  AND no file extension serves `index.html` (so `/learn`, `/privacy`, `/admin/bots` deep-link directly);
  paths with an extension still 404. The OAuth callback still returns the session token in a `#token=`
  fragment (orthogonal to routing — `Auth.js` strips it on load).
- **Legal pages** — Privacy Policy / Terms of Service render as ordinary in-app SPA views
  (`#privacy_view` / `#terms_view` in `index.html`, the `.legal` block from `style.css`), so the
  navbar stays like every other page. Routes `/privacy` and `/terms` (`showPrivacyView` /
  `showTermsView` in `Router.js`) are handled at the TOP of `applyRouteFromHash`, before the
  name-entry gate, so they're public (a signed-out OAuth reviewer can read them), and deep-link directly
  via the SPA fallback. Linked from the home page's `.site-footer`. `logo.svg` is the square brand tile
  (same design as `favicon.svg`); `logo-512.png` (repo root) is its rasterised 512×512
  PNG for upload as the OAuth consent-screen app logo.
- `BoardRender.js` — canvas paint + palette + animation timings + DPR.
- `Animations.js` — the cellAnims queue + RAF loop + per-frame board paint.
- `Input.js` — pointer/touch/keyboard handlers, local reveal/chord mirrors. Keyboard
  actions are resolved through `keybindings.actionFor()`. A chord that **detonates** clears every
  incorrect flag around that number (flagged but not actually a mine) in all modes — locally, and via
  a `right_click` per cleared flag in server-tracked modes (and via `territoryToggleFlag` in territory).
- `Keybindings.js` — rebindable in-game keyboard controls (persisted to `ms_keybinds`)
  and the Controls section rendered on the Profile page.
- `BotsAdmin.js` — admin bot browser (`#/admin/bots`): paginated/sortable/Elo-filterable
  view of the pool via `GET /api/bots`, plus the server-driven "watch a bot play" modal
  (`bot_demo_start`/`stop` → `bot_demo_board`/`move` sockets; renders frames with `drawCell`).
- `Fullscreen.js` — `enterGameFullscreen()` / `exitGameFullscreen()`: requests browser
  fullscreen when a game starts (any mode) and releases it on leave. Because the
  Fullscreen API needs a transient user gesture, `enterGameFullscreen()` is called straight
  from the committing click handlers (`readyButton` for casual, `findRanked` for ranked,
  `startSolo`, `renderPuzzlePlay`, territory create), never from a later socket/board
  callback; it's idempotent and fails silently if the browser blocks/doesn't support it.
  Exit is wired into every leave path (`leave_button`, `cancelRanked`, `exitSolo`,
  `exitPuzzle`, territory teardown, and the Router's navigate-away teardown).
  Fullscreen chrome (driven by `body.game-fullscreen`) hides the navbar + footer and, for the
  non-territory/non-puzzle modes, re-centers the play area (the windowed grid left-aligns the
  board in a `1fr` column + 320px sidebar, which jams it against the edge once `main`'s
  max-width is dropped in fullscreen).
  NB the "leaving counts as a loss" prompt (in `leave_button` and the Router navigate-away path)
  uses the app's own `showConfirm` modal, **not** `window.confirm()` — browsers suppress native
  dialogs while fullscreen (they return false silently, so the button looked dead in-game).
  Leaving goes through `leaveRoom()` (Main.js), which emits `leave_room` and then **tears the game
  UI down immediately client-side** (`teardownRoomUI`: clear room state + re-route, which hides
  `#game_view`) rather than waiting for the server's `left_room` echo — so the game never lingers
  if that echo is slow/dropped. The echo still arrives and applies any ranked Elo delta.
- `MobileLayout.js`, `Sound.js`, `Overlay.js`, `RoundTimer.js`,
  `DangerWarning.js`, `BoardDecoder.js`, `Router.js`, `Auth.js`,
  `Ranking.js`, `Leaderboard.js`, `Profile.js`, `Lobby.js`,
  `MatchPanels.js`, `GameRoom.js`, `Solo.js`, `Learn.js`,
  `StartPatternsView.js`, `CombinedPuzzlesView.js` — one feature each.
  (`Overlay.js` also holds `showConfirm(message, opts)` — the app's promise-based confirm
  modal, used app-wide instead of `window.confirm()`.)
- `Lobby.js`'s ranked search is a **waiting room** (`#ranked_searching`, a centred
  full-viewport overlay with a dimmed/blurred backdrop): `renderMatchRoster(info)` turns the `members`
  roster the server sends with every `ranked_searching` broadcast into a filling slot
  list (name + tier chip, "YOU" tag for self, dashed "Waiting for player…"
  placeholders for empty slots), above a mode label + flavour tagline (`MODE_TAGLINES`),
  progress bar, count, and a Leave button. Only newly-arrived rows animate in
  (`matchRosterShown` gate), so existing rows don't re-flash as bots trickle in.

The Learn page is an interactive deduction trainer (`LEARN_COURSES` data
array, ~16 puzzles + ~10 demos). No mine-count deductions — the game
hides the total.

## Configuration (`.env`, auto-loaded; gitignored)

- `PORT` — 1337 local, 8080 in prod.
- `DEV_AUTH=1` — enables the `/auth/dev` login button. **Never set in production.**
- `OAUTH_REDIRECT_BASE` — base URL for OAuth callbacks (`http://localhost:1337` local,
  `https://msbattle.net` prod).
- `google_auth_client_id` / `google_auth_client_secret` (and `discord_*` equivalents; GitHub is still
  wired server-side but no longer shown in the UI) — OAuth credentials. The server reads these plus
  `GOOGLE_CLIENT_ID` / `DISCORD_CLIENT_ID`-style UPPER_CASE names. Sign-in offers **Google + Discord**
  (Facebook is a planned addition); each provider's button only appears when its client ID is configured.

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
