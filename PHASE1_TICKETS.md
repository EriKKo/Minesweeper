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

### Transport + processes (needs a real runtime env to validate; staged)
- **P1-4 — Client transport abstraction.** Wrap the client's single `socket` so lobby-ops vs match-ops
  are distinguishable; no behaviour change yet (prep for two connections).
- **P1-5 — Game-service process + internal API.** Stand up a separate game entry point; swap the
  in-process transport for a local HTTP/socket internal API behind the same `gameService` contract.
  main allocates over the wire; the game process runs matches and reports back (idempotent + retried).
- **P1-6 — Client dual-connection.** Browser keeps its main socket for lobby/matchmaking and opens a
  **direct** socket to the allocated game server for the match (addr + signed `matchToken` from allocate).
  Wire P0-8's token here. The big client change.
- **P1-7 — Reconnection + draining across the boundary.** A dropped player re-resolves the same game
  server via main; game servers drain (P0-7) as a fleet — new games to new instances, old finish + exit.
- **P1-8 — Deploy as two fly apps.** `main` (single Machine, SQLite volume) + `game` (Machines-API fleet,
  per-match/region). Static assets via CDN. See ARCHITECTURE_PLAN.md §5/§7.

## Out of scope (Phase 2+)
Per-match allocation/multi-region (Phase 2), Postgres (Phase 3), Redis + multi-replica main (Phase 4).
