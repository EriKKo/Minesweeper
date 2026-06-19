# MSBattle — Long-term Architecture & Migration Plan

> Forward-looking plan. `CLAUDE.md` describes the system **as it is today** (a single stateful
> Node monolith); this file describes where we want to go and how to get there **incrementally**.
> Nothing here is built yet — it's the target and the ordered steps. Revisit each phase against a
> real need before starting it; do **not** migrate ahead of demand.

## 1. What kind of game this is (the thing the architecture must serve)

A **session-based real-time game**:

- Matches are **small** (2–6 racers, 2–4 territory, larger tournament lobbies), short-to-medium
  lived, and each match is an **independent authoritative simulation** — shared no-guess board +
  per-player state + round/world/bot tick loops.
- Real-time but **not twitch**: clicks, not 120 Hz aim. Tens of ms latency is fine; no rollback netcode.
- Around the matches is a **control plane** of relational, transactional data — accounts/OAuth,
  ratings, leaderboard, replays, puzzle catalog, matchmaking. This is what outgrows single-box SQLite.
- A largely-**offline** heavy-compute tier: no-guess generation, the CSP solver, bot-pool benchmarking,
  puzzle generation. CPU-bound, batchy, and mostly precomputed into committed artifacts already.

That decomposition dictates the target: **separate the control plane from the game runtime**, put
durable data in **Postgres**, and run matches on a **horizontally-sharded fleet of authoritative
game servers**. (This matches the "split main from game servers + SQLite → Postgres" instinct.)

## 2. Target architecture (platform-independent)

```
            ┌──────── CDN / edge: static client (JS/CSS/flags/avatars/skins) ────────┐
            │                                                                         │
 Player ───►│  MAIN (control plane)  ── Postgres (system of record) ── Redis          │
            │  auth · profiles · ratings · leaderboard · achievements · replays ·     │
            │  puzzle catalog · MATCHMAKER (queues + match formation + allocation)    │
            │  stateless, N replicas behind a load balancer                           │
            │        │ returns to client: { gameServerAddr, matchId, signedToken }    │
            │        ▼                                                                 │
 Player ─WS►│  GAME SERVERS (data plane)  — authoritative per-match runtime            │
            │  hold match state in memory · run round/territory/bot ticks ·           │
            │  terminate players' WebSockets · capture replay · ephemeral, sharded     │
            │  one match → exactly one game server · region-placed                     │
            │        │ on match end: POST results → MAIN                               │
            │        ▼                                                                 │
            │  Object storage (R2/S3): replay blobs, generated artifacts              │
            └──────────────────────────────────────────────────────────────────────────┘

 OFFLINE / BUILD tier (not in the request path): no-guess gen, CSP solver, bot-pool bench,
 puzzle generation → writes artifacts (bots-pool.json, deduction-patterns.json) + puzzles into PG.
```

### Non-negotiable design rules
1. **A match lives entirely on one game server** — single-writer, in-memory, no distributed
   consensus per move. Keeps the game loop simple and fast.
2. **Players connect directly to their assigned game server** (not proxied through main) — the
   low-latency path, and how dedicated-server games work.
3. **Only the main tier writes durable data**; game servers persist outcomes by reporting to main.
   Game servers never share mutable state with each other.
4. **Coordination state lives in main and must be rebuildable, never authoritative.** Matchmaking
   queues, presence, the game-server registry, and the live room list are a *projection* that main
   can reconstruct from (a) the DB for durable truth, (b) game-server heartbeats for live matches/
   rooms, and (c) client reconnects for queues/presence. This is what lets main restart without data
   loss. (While main is a single instance this projection lives in its own memory — **no Redis
   needed**; Redis only arrives when main itself becomes multiple replicas, which needs Postgres.)
5. **Game servers are immutable and drainable.** A deploy never replaces a running game server — new
   versions launch as new instances, old ones drain (finish active matches, refuse new ones) and
   self-terminate when empty. See §7.
6. **Result reporting is idempotent and retried.** Every game-server→main report is keyed by
   `matchId` and applied **exactly once**, with retry-with-backoff, so a main blip or a duplicate
   delivery never loses a result or double-applies Elo.
7. **Replay blobs and growing binaries go to object storage**, not Postgres BLOBs, at scale.
8. **Auth across the boundary uses short-lived signed tokens** (HMAC/JWT) issued by main and verified
   by game servers — game servers need no DB access for auth.

## 3. Service boundaries mapped onto today's modules

| Today (`src/server/...`) | Target tier | Notes |
|---|---|---|
| `runtime/session.js` (auth attach, login, set_name/avatar/country, get_match_history, get_replay) | **Main** | Profile/replay serving + identity. |
| `runtime/oauth.js` | **Main** | Provider login. |
| `db.js` | **Main** | Becomes a Postgres-backed repository (see §4). |
| `runtime/elo.js`, `runtime/standings.js` | **Main** (invoked at match end) | Game server reports results → main applies Elo + writes `match_history`/`player_stats`. |
| `runtime/ranked.js` (queues, `formRankedMatch`) | **Main → Matchmaker** | Queue + formation stays; the "run the match" half hands off to game-server allocation. |
| `runtime/puzzleApi.js` + generators/`scripts/*` | **Main / Offline** | Admin API in main; generation is offline/cron writing to PG + artifacts. |
| `minesweeperServer.js` socket runtime (`left_click`/`right_click`/`draw_board`, round/series lifecycle) | **Game** | The authoritative match loop. |
| `engine/GameCreator.js`, `RoomCreator.js`, `common/BoardLogic.js` | **Shared lib** | Used by game servers **and** offline generation. |
| `runtime/bots.js`, `engine/BotPlayer.js` | **Game** | Bots run inside the match. |
| `runtime/territory.js`, `engine/TerritoryGame.js` | **Game** | Includes the continuous world-tick loop. |
| `runtime/roomState.js`, `runtime/gameUtil.js` | **Game** | Broadcast/serialization. |
| `runtime/replay.js` | **Game** (capture) → **Main** (store) | Capture during the match; ship the finished blob to object storage + metadata to PG at match end. |
| `runtime/appState.js` | **Split** | Per-game-server: the rooms/games it hosts. Global bits (queues, presence, registry, room list) → main's memory while it's single-instance (→ Redis only once main is multi-replica). |
| `engine/NoGuessGenerator`, `CSPSolver`, `PuzzleGenerator`, `*Generator`, `BotBench` | **Offline/Build** | Not in the realtime path. |

### Allocation / match flow (target)
1. Client → main: `find_ranked {mode}`.
2. Matchmaker enqueues (in main's memory, or Redis once multi-replica) and forms a match (humans +
   trickled bots — reuse `ranked.js` logic).
3. Matchmaker **allocates a game server** (capacity-aware, newest healthy version, region near
   players) and pushes the **self-contained match config** (roster + identities + per-style ratings
   for display + rules + bot configs) so the game server never reads the DB.
4. Main returns `{ gameServerAddr, matchId, signedToken }` to each client.
5. Clients open a WebSocket **directly to the game server**, which verifies the token and starts the series.
6. On match end the game server computes standings → reports to main (idempotent, keyed by `matchId`)
   → main applies Elo, writes `match_history`/`player_stats`, stores the replay.
7. Game server frees the match; if allocated per-match it can stop (scale-to-zero).

## 4. Data layer

- **Postgres = system of record**: `users`, `user_identities`, `sessions`, per-style ratings,
  `match_history`, `player_stats`, `puzzles`, `daily_attempts`, `starting_positions`,
  `match_replays` (metadata). Port `db.js` query-by-query (the SQL is largely portable; the main
  change is connection pooling + async + parameterization, and replacing `addColumnIfMissing` with
  real migrations).
- **SQLite stays the system of record until main needs to be more than one process.** Because main
  is the **sole owner** of the DB file (game servers never touch it — see Phase 1), SQLite's
  single-process constraint is satisfied and the server split works *without* Postgres. Keep it on a
  fly volume in WAL mode; match-end write volume is tiny.
- **Postgres is the later unlock** (Phase 3): the migration is mandatory only when main itself must
  scale out or be HA (multiple replicas can't share a SQLite file). Port `db.js` query-by-query —
  the SQL is largely portable; the work is async + pooling + parameterization, and replacing
  `addColumnIfMissing` with a real migration tool (node-pg-migrate / sqitch).
- **Redis = ephemeral coordination, but only once main is multi-replica.** While main is a single
  instance its own memory holds the queues/presence/registry/room-list (rule 4); Redis arrives with
  Postgres + multiple main replicas (Phase 4).
- **Object storage (R2 / S3 / Tigris) = blobs**: replay payloads (move the gzipped BLOB out of the
  DB), optionally generated puzzle artifacts — whenever blob volume warrants it.

## 5. Where to run it

**Recommendation: fly.io, used properly** (not today's single machine):

- **Main** = one fly app. *Initially a single Machine* owning SQLite on a volume (no Postgres/Redis);
  later N replicas on Postgres + Redis once it must scale out.
- **Game servers** = a separate fly app, a fleet of Machines managed via the **Machines API** (not
  rolling `fly deploy` — see §7), placed in the region nearest the matched players; drains when a new
  version ships and stops when empty.
- **Postgres** (Phase 3+) = Neon/Supabase (cheap/serverless at small scale) or fly Managed Postgres.
- **Redis** (Phase 4+) = Upstash or fly Redis.
- **Object storage** = Tigris (fly-native) or Cloudflare R2 (zero egress).

Why fly fits *this* game:
- Natively does the one hard thing we need — "spin up an authoritative server for this match, in
  region X, now" — via fast-booting microVMs, without Kubernetes or a paradigm rewrite.
- CPU-heavy generator/solver/bench code stays ordinary code in the same runtime.
- Territory's world-tick is a natural long-lived loop, not an alarm-callback reconstruction.
- We can evolve there in **incremental, shippable** steps (below), same cloud throughout.
- Graduates cleanly to **Kubernetes + Agones** (industry-standard game-server fleet manager) if we
  ever go massive — same concepts, no redesign.

**Alternative: Cloudflare Workers + Durable Objects** — if global-edge reach and zero-ops
auto-scaling become top priorities. In that model a **game server per match _is_ a Durable Object**
(Cloudflare handles allocation, affinity, scale-to-zero, idle-connection hibernation), main is
Workers + Postgres-via-Hyperdrive (or D1), and heavy generation runs as scheduled/offline jobs. The
most *elegant* realization of "separate game servers per match", but it's a programming-model
commitment (V8 isolates; `node:sqlite`/socket.io don't port; the game must be expressed as actors).

**Not now: Kubernetes + Agones** — correct only at large scale; the ops cost isn't worth it for a
small team until matchmaking volume genuinely demands a real fleet orchestrator.

## 6. Phased migration (each phase is independently shippable)

> **Chosen sequencing: split the servers first, keep SQLite.** Because main stays the sole DB owner,
> the split needs neither Postgres nor Redis — those are deferred to when main itself must scale out.
> This delivers the scaling that matters (the WebSocket/CPU-heavy game tier) for the least migration cost.

- **Phase 0 — Seams (no deploy change).** Within the monolith, draw a clean internal line between
  *control* modules (session/oauth/db/ranked-queue/puzzleApi/puzzle-play/solo) and *game* modules
  (game handlers/GameCreator/bots/territory/roomState/replay-capture). Extract the game logic
  (`BoardLogic`/`GameCreator`/`CSPSolver`/generators) into a **shared package** both tiers import.
  Define the **main↔game contract** (§8) and the **lifecycle/draining behaviour** (§7) up front.
  **Broken into concrete tickets in [`PHASE0_TICKETS.md`](./PHASE0_TICKETS.md)** — all doable today
  with zero infra/behaviour change.
- **Phase 1 — Split out game servers; SQLite stays.** Move the live multiplayer runtime (game
  handlers, GameCreator, bots, territory + world-tick, replay capture) into a separate **game**
  service. **Main stays a single instance** and remains the sole SQLite owner + in-memory
  coordinator (queues, presence, room + game-server registries). Wire: signed-token handoff, the
  self-contained match config, **idempotent retried result reporting**, and **draining/graceful
  shutdown from day one** (§7). Client gains a second connection (lobby→main, match→game server).
  DB-coupled single-player surfaces (puzzle ladder, solo bests, profile, leaderboard, puzzle
  catalog) **stay on main**. *No Postgres, no Redis.*
- **Phase 2 — Per-match allocation + multi-region game servers.** Allocate game-server capacity (or
  spin a fly Machine per match) via the Machines API and place it near players; add reconnection
  (token re-resolves the same game server through main); optionally move replay blobs to object
  storage. Main is still single-instance SQLite.
- **Phase 3 — SQLite → Postgres.** Only when **main itself** is the bottleneck (matchmaking/HTTP/
  result-write load) or needs HA. Swap `db.js` to a `pg`-backed async repository + a real migration
  tool. This is the unlock for running more than one main.
- **Phase 4 — Multiple main replicas + Redis.** Make main stateless (N replicas behind a LB); move
  the coordination projection (queues/presence/registries) from main's memory into **Redis** so the
  replicas share it. Now main is HA too and deploys with no blip (rolling replicas).
- **Phase 5 — Only if needed.** Graduate to Kubernetes + Agones, or migrate the realtime tier to
  Cloudflare Durable Objects, when real scale/latency demands it.

## 7. Graceful deploys & instance lifecycle (design in from Phase 1)

The whole point of the split is that **shipping code should never interrupt a live match.** This only
works if it's built into the lifecycle from the start, not bolted on.

### Game servers — drain, don't replace
Game servers are **immutable and versioned**; a deploy is a *fleet rollover*, never an in-place restart:
1. **Never `fly deploy`-rolling over running game servers** — the default strategy replaces Machines
   and would kill active matches. Manage the fleet via the **Machines API** instead.
2. **Ship = launch new instances** running the new image; register them as `active`.
3. **Old instances flip to `draining`**: they keep running their active matches, **still accept
   reconnections to those matches**, but **refuse new allocations** (main stops routing new matches
   to them — it only allocates to the newest healthy version).
4. **Self-terminate when empty**: once a draining instance's active-match count hits 0, it destroys
   itself (Machines API) / exits. A long best-of-5 simply keeps its old game server alive until it ends.
5. **SIGTERM handling**: a game server traps SIGTERM → enters draining rather than dying immediately.
   Don't rely on fly's `kill_timeout` to hold a match open (it's capped at minutes and a series can
   exceed it) — draining is driven by *match completion*, not a fixed timeout.
6. **Allocation prefers the newest version**; the matchmaker tracks each instance's version + state +
   active-match count via heartbeats and skips anything `draining`.

### Main — restartable without disrupting matches
Main is single-instance (until Phase 4), so a deploy means a **brief main blip**. Make that blip
**non-destructive** rather than zero — active matches don't even notice it because they live on game
servers:
1. **Active matches are unaffected** — they run on game servers independent of main. This is the big
   payoff of the split: *main can restart anytime without touching live games.*
2. **In-flight results are never lost**: game servers buffer result reports and retry with backoff
   (rule 6), so reports that land during the blip just succeed on retry once main is back; idempotency
   makes duplicates safe.
3. **Coordination state rebuilds on boot** (rule 4): main comes up at a **stable internal address**;
   game servers re-register via heartbeat (rebuilding the game-server + room registries within
   seconds), and clients auto-reconnect and re-queue (rebuilding matchmaking + presence). Nothing
   durable was in memory.
4. **Graceful main shutdown**: on SIGTERM, stop accepting new lobby connections, finish in-flight
   result-report handling, flush/close SQLite cleanly, then exit. Only one process opens the DB at a
   time (old exits before new opens — a few seconds' gap is fine).
5. **Half-formed matches**: if main crashes mid-allocation, the un-joined game-server slot expires on
   an **allocation TTL** (game server self-cleans a match nobody joined), and the affected players
   simply re-queue on reconnect.
6. **Client UX during a blip**: lobby shows "reconnecting…"; matchmaking auto-resumes; a player *in a
   match* sees nothing because their game-server socket stayed up.

When true zero-downtime for the control plane matters, that's the trigger for **Phase 3 + 4**
(Postgres + multiple main replicas behind a LB → rolling deploys with no blip at all).

## 8. main ↔ game-server contract (define in Phase 0)

A small internal API over the fly private network (signed; not client-reachable):

- **`allocateMatch` (main → game server)** — `{ matchId, rules, roster:[{playerId, name, avatar,
  country, skin, ratingForDisplay, isBot, botConfig?}], boardSeed|template }`. Self-contained: the
  game server needs no DB. Returns `{ gameServerAddr }`. Carries an **allocation TTL**.
- **player join token (main → client → game server)** — short-lived signed `{ matchId, playerId,
  gameServerAddr, exp }`; the game server verifies the signature (shared secret), no DB lookup.
- **`reportResult` (game server → main)** — `{ matchId (idempotency key), perRound:[…standings,
  progress…], winnerId, replayBlob }`. Main applies Elo + writes history/stats/replay **exactly
  once** per `matchId`. Retried with backoff; consider reporting per *round* so a crash mid-series
  doesn't lose the whole match.
- **`heartbeat` (game server → main)** — `{ instanceId, version, state: active|draining,
  activeMatches, openRooms:[…], capacity }`. Drives the registry, the lobby room list, allocation
  targeting, and drain tracking. Re-registers automatically after a main restart.
- **`drain` (main → game server)** — optional explicit signal to start draining (otherwise inferred
  from a new version shipping / SIGTERM).

## 9. Cross-cutting concerns & open decisions

- **Reconnection / affinity**: a dropped player must rejoin the *same* game server (including while
  it's draining) — the signed token carries `gameServerAddr`+`matchId`; reconnection re-resolves
  through main.
- **Hidden information**: bots are disguised as humans in matchmaking and in replays (bot-ness is no
  longer recorded or shipped — see `replay.js`/`Replay.js`). Keep this invariant: no tier leaks bot
  identity to a client. The match config *does* tell the game server which seats are bots (it runs
  them) — that flag must never be forwarded to clients.
- **Result trust**: only main writes ratings; game servers *report* outcomes over the authenticated
  internal channel; sign those reports (don't trust the client, and don't trust an unsigned report).
- **Static assets**: serve the client from a CDN regardless of tier choice — a cheap immediate win
  available even before any backend split (e.g. Cloudflare in front of fly).
- **Observability/cost**: more moving parts; mitigate cost with scale-to-zero game servers (per-match
  allocation) and auto-stop on the main Machine at low traffic.
- **Don't over-build**: a single beefier fly machine carries a click-paced game a very long way. Gate
  Phases 2–5 on measured need (game-tier concurrency, multi-region latency, then main-tier load/HA).
