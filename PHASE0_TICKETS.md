# Phase 0 — Seams (tickets)

> Prep work for the main/game-server split (see `ARCHITECTURE_PLAN.md` §6). **Everything here is
> doable today inside the current monolith — zero infra change, zero deploy change, and ideally zero
> behaviour change.** The goal is to make the eventual physical split *mechanical* by drawing the
> boundaries now: a clean game-logic library, explicit match-config / result-report contracts, a
> single persistence seam, idempotent result writes, and a documented lifecycle. Each ticket is
> independently mergeable and keeps `npm test` green.

**Definition of done for Phase 0:** the code is organised so that "move the game runtime into its own
process" is a deployment change, not a rewrite — the data crossing the boundary already flows through
explicit functions, and a lint/test guards the boundary from regressing.

## Status — ✅ COMPLETE
All nine tickets landed (full suite 41/41 green). New modules: `runtime/results.js` (MatchConfig +
ResultReport + idempotent `persistResult`), `runtime/lifecycle.js` (draining), `runtime/matchToken.js`
(join-token primitive), `engine/index.js` (game-core barrel); new tests: `boundary`, `idempotency`,
`elo`, `matchconfig`, `lifecycle`, `matchtoken`. P0-8's token primitive is built + tested but **not
wired into a join path** — there's no client→game-server handshake to attach it to until Phase 1, so
that wiring is deliberately deferred.

| Ticket | Status |
|---|---|
| P0-1 game-core boundary + barrel | ✅ |
| P0-2 MatchConfig | ✅ |
| P0-3 persistResult seam | ✅ |
| P0-4 pure computeRankedElo | ✅ |
| P0-5 idempotent persistence | ✅ |
| P0-6 appState boundary tags | ✅ |
| P0-7 lifecycle / draining | ✅ |
| P0-8 match-join token | ✅ primitive built; wiring → Phase 1 |
| P0-9 boundary guard test | ✅ |

---

## P0-1 — Carve out the shared game-logic library
**What:** Make `engine/*` + `common/BoardLogic` a self-contained game-core with **no dependency on
`runtime/*`, `db.js`, `socket.io`, or `appState`.** Both the future main (offline generation) and the
future game servers import it.
**Touch:** `engine/` (GameCreator, RoomCreator, NoGuessGenerator, CSPSolver, BotPlayer,
PuzzleGenerator, TerritoryGame/Generator, InsideOut/RingSeed, StartPatterns/Patterns), `common/BoardLogic`.
**Do:** audit each `engine/*` file for stray `require("../runtime/…")` / `require("../db")`; push any
such coupling out (pass it in as an argument instead). Add an `engine/index.js` barrel that defines the
public surface.
**Done when:** no file under `engine/`/`common/` imports `runtime/`, `db`, or `socket.io`; tests pass.
**Effort:** S–M · **Risk:** low (mostly moves/audits).

## P0-2 — Define the **MatchConfig** contract (match start)
**What:** A single self-contained object that fully describes a match, so a game server would need no
DB read. Build the match from it even though it's in-process today.
**Shape:** `{ matchId, rules:{mode, rows, cols, mineDensity, roundSeconds, series, modifier},
roster:[{playerId, name, avatar, country, skin, ratingForDisplay, isBot, botConfig?}], boardSeed }`.
**Touch:** `runtime/ranked.js` (`formRankedMatch`), `runtime/roomState.js`, `minesweeperServer.js`
(`startSeries`/`startGame`).
**Do:** add `buildMatchConfig(room, roster)`; route match setup through it instead of reading scattered
`appState`/`names`/`avatars`/`skins` maps inline.
**Done when:** a match is constructed from a `MatchConfig`; the identity/skin/rating data is read once,
at build time. No behaviour change.
**Effort:** M · **Risk:** low.

## P0-3 — Define the **ResultReport** contract + single `persistResult` seam (match end)
**What:** Collapse all match-end persistence behind one function the game runtime calls, mirroring the
future game-server→main report.
**Shape:** `{ matchId, perRound:[{standings, progress}], winnerId, replayBlob, ratingsBefore }` →
`persistResult(report)`.
**Touch:** `runtime/elo.js` (`applyRankedElo`/tournament variants), `runtime/standings.js`,
`runtime/replay.js` (`finishMatch`), `db.js` (`updateRating`/`recordMatch`/`saveReplay`/
`linkReplayToMatches`), `minesweeperServer.js` (`endSeries`).
**Do:** introduce `buildResultReport(room, standings)` + `persistResult(report)` that wraps the current
Elo + history + replay writes. The match-running code calls `persistResult`, never `db.*` directly.
**Done when:** match-running modules have **zero direct `db.` calls**; all match-end writes go through
`persistResult`. No behaviour change.
**Effort:** M · **Risk:** medium (touches the rating/replay path — cover with a before/after test).

## P0-4 — Compute Elo from the report, not from live state
**What:** Make the rating math a pure function of the `ResultReport` (standings + progress + each
player's prior rating, which the report carries), not of live `appState`/room/account objects.
**Touch:** `runtime/elo.js`, `runtime/standings.js`.
**Do:** pass ratings-before in the report (from `MatchConfig.roster[].ratingForDisplay` captured at
start); remove `appState` reads from the rating path.
**Done when:** `applyRankedElo` is callable from just a report (unit-testable with no socket/room).
**Effort:** S–M · **Risk:** medium (rating correctness — add a regression test vs current output).

## P0-5 — Idempotent result persistence (keyed by `matchId`)
**What:** `persistResult` applies a given `matchId` **exactly once** (rule 6 of the plan). This is the
linchpin that later makes a main blip / retried report safe — building it in-process now is free.
**Touch:** `db.js` (a `processed_matches` set/column or dedupe on `match_history`), `persistResult`.
**Do:** record applied `matchId`s; a second `persistResult` with the same id is a no-op (no double Elo,
no duplicate history/replay rows).
**Done when:** a unit test calls `persistResult` twice with one report and asserts Elo/history applied once.
**Effort:** S · **Risk:** low.

## P0-6 — Split `appState` into *coordination* vs *match* state
**What:** Today `appState` mixes global control-plane state (queues, names, accounts cache, registries,
timers) with per-match state (rooms/games). Reorganise/annotate into two labelled groups so the future
boundary (coordination → stays on main; matches → move to game servers) is obvious. **No physical split.**
**Touch:** `runtime/appState.js` (and its consumers' comments).
**Do:** group fields under e.g. `appState.coordination` vs `appState.matches` (or document each field's
side); leave behaviour identical.
**Done when:** every `appState` field is clearly tagged control-plane or game-plane.
**Effort:** S · **Risk:** low (rename/reorg).

## P0-7 — Lifecycle hooks for the game runtime (draining, in-process)
**What:** Express the game runtime's lifecycle (`active` / `draining`) and capacity now, so Phase 1's
real draining is a fill-in, not a redesign (plan §7).
**Touch:** new `runtime/lifecycle.js` (or on the game-runtime module), `minesweeperServer.js` (SIGTERM).
**Do:** expose `activeMatchCount()`, `canAcceptNewMatch()`, `beginDrain()`; on SIGTERM, `beginDrain()` →
stop accepting new rooms/matches, let active ones finish, then exit. In the monolith this just makes
shutdown graceful; the same hooks drive fleet draining later.
**Done when:** SIGTERM stops new-match acceptance and exits only after active matches end (or a cap).
**Effort:** M · **Risk:** medium (shutdown semantics — verify a deploy doesn't cut an active game).

## P0-8 — Match-join token seam (stub)
**What:** Route match joins through an `issueMatchToken(playerId, matchId)` / `verifyMatchToken(token)`
pair (HMAC) so the auth boundary exists before it spans processes. Trivial/loopback today.
**Touch:** `runtime/session.js`, `minesweeperServer.js` (join path).
**Do:** issue a signed token at match allocation; verify it on join. One process → same secret.
**Done when:** a match join is validated via the token function, not implicit trust. No UX change.
**Effort:** S · **Risk:** low. *(Optional in Phase 0; can slide to Phase 1.)*

## P0-9 — Boundary guard (lint/test)
**What:** Keep the seams from rotting.
**Touch:** `package.json` scripts, `test/`.
**Do:** a tiny check (grep-based npm script or a `node --test` case) that fails if `engine/`/`common/`
import `runtime`/`db`/`socket.io`, or if match-running modules call `db.*` directly (must go through
`persistResult`).
**Done when:** `npm test` enforces the import rules; CI/local catches a regression.
**Effort:** S · **Risk:** low.

---

## Suggested order
1. **P0-1** (game-core boundary) — unblocks everything; pure moves.
2. **P0-3** + **P0-2** (the two contracts) — the heart of the seam.
3. **P0-4** then **P0-5** (Elo-from-report, then idempotency) — de-risks the result path.
4. **P0-6** (appState split) — cheap clarity, can be done anytime.
5. **P0-7** (lifecycle/draining) — sets up seamless deploys.
6. **P0-9** (boundary guard) — lock in the gains. **P0-8** last (or defer to Phase 1).

## Out of scope for Phase 0 (deliberately)
No second process, no new hosting, no Postgres, no Redis, no client dual-connection. Those are
Phases 1+. Phase 0 only reshapes the **current** repo so those phases become mechanical.
