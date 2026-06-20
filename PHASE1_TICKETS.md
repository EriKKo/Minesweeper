# Phase 1 — Split out game servers (tickets)

> Goal (ARCHITECTURE_PLAN.md §6, Phase 1): the live multiplayer runtime moves to a separate **game**
> service; **main** stays a single instance, sole SQLite owner + in-memory coordinator. No Postgres,
> no Redis. Phase 0 already built the seams (`results.js` MatchConfig/ResultReport/persistResult,
> `lifecycle.js` draining, `matchToken.js`, the boundary guard) — Phase 1 makes the boundary real.

## Strategy — collapse the boundary in-process FIRST, then make it a transport, then two processes
Phase 1 is large and the riskiest parts (networking, the client's second connection, two-process
deploy) are also the hardest to validate. So we stage it so the **monolith keeps working and the test
suite stays green at every step**:

1. **In-process boundary** (P1-1…P1-3) — define the `gameService` contract (allocate / reportResult /
   heartbeat) and route the existing flow through it, still one process. Fully testable here.
2. **Transport seam** (P1-4…P1-5) — put a swappable transport behind the contract; introduce a real
   game-service process talking to main over a local internal API. Same contract, different transport.
3. **Client dual-connection** (P1-6) — the browser connects to main for lobby and opens a second socket
   to the allocated game server for the match (address + token from allocate).
4. **Reconnection + draining + two-app deploy** (P1-7…P1-8).

## The central challenge: identity is `socket.id`
Today `playerID === socket.id`, and every live-game collection (`games`, `roomMapping`, `names`,
`accounts`, …) is keyed by it. In the split a player holds **two** sockets (main + game server) with
**different** ids, so the runtime needs a **stable player/match identity decoupled from the socket**.
This is the deepest coupling and the prerequisite for P1-6; P1-2 introduces a stable `playerKey` carried
in the MatchConfig so the game runtime keys off identity, not the transport socket.

## Tickets

### In-process boundary (safe, testable in this repo)
- **P1-1 — `gameService` contract + in-process transport.** New `runtime/gameService.js`: `allocate(...)`
  runs a match (in-process → calls the core's `startSeries`), `reportResult(report)` hands results to a
  registered handler (→ `persistResult`). Route the 3 `startSeries` call sites + the `endSeries` persist
  through it. Behaviour-identical. *(this ticket)*
- **P1-2 — Stable `playerKey` in the contract.** ✅ Add a transport-independent identity
  (`runtime/identity.js` `playerKeyFor`) carried in `MatchConfig.roster[].playerKey` — users/guests key
  off their account, bots off their id, so a player is identifiable across both sockets. **Refined scope:**
  the *runtime rekey* (live-game collections addressed by playerKey instead of socket.id) is deferred to
  **P1-5**, where the extracted game process builds its state fresh from the config keyed by playerKey —
  a contained change there, vs. a high-risk churn of the whole socket-keyed monolith now for no
  in-process benefit. P1-2 establishes the identity the token (P1-6) carries.
- **P1-3 — MatchConfig is a complete reconstruction spec.** ✅ Enrich `buildMatchConfig` so a game
  server can rebuild + run the match with no access to main's state: match identity, `roomId`, `size`,
  rules (board dims, density, round time, death penalty, series, modifier), and a roster where each bot
  carries its full AI config. The config-driven *construction function* (`buildMatchFromConfig`) is
  wired + integration-tested in **P1-5**, on the game server that consumes it — rather than landing as
  unwired code now.

### Transport + processes
- **P1-4 — Client transport abstraction.** ✅ Realized by `activeGameSocket()` (Main.js): in-match emits
  route to the per-match connection, lobby/auth stay on the main socket. Dormant in the monolith.
- **P1-5 — Game-service process + internal API.** ✅ **Done (server side).** `ROLE` (both/main/game;
  default = monolith, untouched) + `runtime/internalApi.js` (secret-guarded `/internal/health|report|
  allocate`). The `game` role builds a match from the spec, runs it, and posts a wire-safe `ResultReport`
  to main's `/internal/report` (idempotent). Humans attach to the game server with a join token
  (`attachGameClient`, bound to their seat by `playerKey`). The `main` role hands a formed match to a
  game server (`allocateMatchToGameServer`) and emits `match_handoff {gameUrl, token}`. Elo is applied
  from the report by `userId`/rating-before (`elo.applyRankedEloFromReport`). Proven across **real two-
  process** tests: `split` (bot match round-trip), `humanattach` (token attach + play + report),
  `endtoend` (client → main → game handoff loop), `elo`/`internalapi` (deterministic Elo-from-report +
  idempotent persist). The match-handler extraction (shared `registerGameplayHandlers`) is done.
- **P1-6 — Client dual-connection.** ✅ On `match_handoff` the client opens a direct socket to the game
  server (auth: join token) and bridges its events into the existing handlers via `onAny`; in-match emits
  route through `activeGameSocket()`. Game role sets CORS so the cross-origin connection is allowed.
  **Verified live in a real browser** against a main(1401)+game(1402) pair: matchmake → handoff → direct
  game-server connection → ranked 1v1 played on the game server, zero console errors. Dormant in the monolith.
- **P1-7 — Reconnection + draining across the boundary.** A dropped player re-resolves the same game
  server via main; game servers drain (P0-7) as a fleet — new games to new instances, old finish + exit.
- **P1-8 — Deploy as two fly apps.** `main` (single Machine, SQLite volume) + `game` (Machines-API fleet,
  per-match/region). Static assets via CDN. See ARCHITECTURE_PLAN.md §5/§7.

## Out of scope (Phase 2+)
Per-match allocation/multi-region (Phase 2), Postgres (Phase 3), Redis + multi-replica main (Phase 4).
