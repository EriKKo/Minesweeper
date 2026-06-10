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
- **Puzzle difficulty score** (`PuzzleGenerator.complexityScore`): sort the solve's per-move
  complexities high→low and sum `c / X^rank` with `X = 3.5`. The hardest move counts fully; each
  further hard move adds a geometrically-decaying share (bounded by `c_max · X/(X-1) ≈ 1.4×`), so
  stacking hard deductions is rewarded while a long tail of easy moves saturates — many *hard*
  moves matter, raw *length* doesn't. `rating = max(0, round(240·(score − 0.5)))`; the difficulty
  *tier* (t1–t6) is bands on `maxComplexity` alone. Bump `db.CURRENT_SCORING_VERSION` when the
  formula changes — a startup backfill re-rates every stored puzzle below it.
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
  scores / capture / explosion); it holds the single `state` + an `owner` matrix,
  enforces contiguous growth (you may only reveal a covered cell adjacent to your own territory), and
  on a mine hit triggers an **explosion** (`g.explode`): a patch of the hitter's own territory around
  the blast is re-covered (a reverse-cascade "unreveal" animation client-side) and its mines
  re-generated (`computeExplosion`, border-constrained backtracking) so every surrounding clue still
  holds AND the patch is no-guess solvable from its border — you re-clear it in place, no "going
  around". If the re-cover **splits your territory** into disconnected groups, you keep only your
  largest 8-connected group and the smaller cut-off sections are **re-covered** too (`loseSmallerSections`
  — orphaned ground always reverts to covered, never left as dead revealed cells); so "home" is never a
  fixed corner, it's just the biggest area you currently hold and can shift or shrink to a last stand
  (the generator's mine-free corner zone is now only a clean opening, no longer explosion-protected).
  An explosion is **confined to the hitter**: any cell left next to a revealed 0 by the re-cover is
  auto-revealed (no "uncascaded 0") but claimed by the OWNER OF THAT 0-cell — so a blast only feeds the
  player whose own open ground forced the reveal and can never reach across to alter the other player's
  cells. **Your last cells are always safe** — if a blast would re-cover your ENTIRE territory, the
  patch spares the owned cells farthest from the blast (a home), so a mine can never eliminate you
  outright. A 3 s freeze accompanies the hit; if no valid regen is found in a small search it falls back
  to a plain re-cover. Flags: `_explosion` carries the hitter's `pid` — the client clears the hitter's
  OWN local flags in the refilled area (recovered cells + neighbours), but an opponent's explosion
  never touches your flags.
  Server wiring in `minesweeperServer.js`: `room.gameMode === "territory"` →
  `startTerritoryGame` builds one shared game; `left_click` routes to `territory.reveal(pid,r,c,now)`
  and broadcasts `territory_board` (`state`+`owner`+`scores`+`frozenUntil`); **there is no round clock**
  (`roundSeconds: 0`) — it ends when the board is played out (`tg.stuck()`, i.e. neither player has a
  safe move left) or a player leaves → most cells wins (`territory_result`). **Entry points:** "Create
  Territory (1v1)" and "Create Territory (4-player)" buttons in the custom lobby (`create_room` with
  `players: 2|4`; `startTerritoryGame` accepts 2 or 4 and seeds one player per corner from
  `TERRITORY_COLORS = [cyan, amber, violet, rose]`), and **ranked** `territory_duo` (2-player) /
  `territory_quad` (4-player) modes chosen from the territory ranked picker (`RANKED_PICKER_META`,
  style `"territory"`, filled with bots like the other ranked modes) — both share the one
  `rating_territory` Elo ladder; `endTerritoryGame` applies rank-based Elo across all players (so it
  works for 4 as well as 2) and reports the delta in `territory_result`. **Client:
  `Territory.js` renders on the SHARED game board** (`#game0` / `renderPlayerBoard` / `drawCell`),
  not a bespoke canvas — it sets `myState` from the shared state, feeds an owner-colour grid that
  `drawCell` tints (via `view.getOwner`, null in other modes) and outlines (OpenFront-style: `drawOwnerBorder`
  strokes a bright owner-colour edge on any side of an owned cell facing a different owner / unclaimed
  ground / the board edge, so each territory has a crisp border) — and applies **fog-of-clues**: clue numbers
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
  `findFirstSafeStepCapped` takes the bot's `canTarget` predicate (territory only) and only counts a
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
  mines stay a covered dead pocket, and the opponent's own cells aren't stolen.
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

**`src/client/`** — browser frontend, each file a single feature:
- `index.html` — entry page: markup + the inline live-game socket handlers
  and DOM/state wiring. All other client modules are plain `<script>` tags
  loaded ahead of it (each becomes a global).
- `style.css` — all styles.
- `BoardRender.js` — canvas paint + palette + animation timings + DPR.
- `Animations.js` — the cellAnims queue + RAF loop + per-frame board paint.
- `Input.js` — pointer/touch/keyboard handlers, local reveal/chord mirrors. Keyboard
  actions are resolved through `keybindings.actionFor()`. A chord that **detonates** clears every
  incorrect flag around that number (flagged but not actually a mine) in all modes — locally, and via
  a `right_click` per cleared flag in server-tracked modes (and via `territoryToggleFlag` in territory).
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
