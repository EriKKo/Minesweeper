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
4. **Redis holds the ephemeral coordination** — matchmaking queues, presence, the game-server
   registry/capacity, the live lobby room list — so matchmaking + leaderboard are no longer trapped
   in one process (today's single-process ceiling).
5. **Replay blobs and growing binaries go to object storage**, not Postgres BLOBs, at scale.
6. **Auth across the boundary uses short-lived signed tokens** (HMAC/JWT) issued by main and verified
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
| `runtime/appState.js` | **Split** | Per-game-server: the rooms/games it hosts. Global bits (queues, presence, registry, accounts cache) → Redis + main. |
| `engine/NoGuessGenerator`, `CSPSolver`, `PuzzleGenerator`, `*Generator`, `BotBench` | **Offline/Build** | Not in the realtime path. |

### Allocation / match flow (target)
1. Client → main: `find_ranked {mode}`.
2. Matchmaker enqueues in Redis and forms a match (humans + trickled bots — reuse `ranked.js` logic).
3. Matchmaker **allocates a game server** (capacity-aware, region near players) and pushes the match config.
4. Main returns `{ gameServerAddr, matchId, signedToken }` to each client.
5. Clients open a WebSocket **directly to the game server**, which verifies the token and starts the series.
6. On match end the game server computes standings → reports to main → main applies Elo, writes
   `match_history`/`player_stats`, stores the replay (blob → object storage, metadata → PG).
7. Game server drains; on fly it can stop (scale-to-zero per match if allocated per-match).

## 4. Data layer

- **Postgres = system of record**: `users`, `user_identities`, `sessions`, per-style ratings,
  `match_history`, `player_stats`, `puzzles`, `daily_attempts`, `starting_positions`,
  `match_replays` (metadata). Port `db.js` query-by-query (the SQL is largely portable; the main
  change is connection pooling + async + parameterization, and replacing `addColumnIfMissing` with
  real migrations).
- **Redis = ephemeral coordination**: matchmaking queues, presence, game-server registry/capacity,
  the lobby room list.
- **Object storage (R2 / S3 / Tigris) = blobs**: replay payloads (move the gzipped BLOB out of PG),
  optionally generated puzzle artifacts.
- **Migrations**: introduce a real migration tool (e.g. node-pg-migrate / sqitch) — the current
  `addColumnIfMissing` + startup-backfill pattern doesn't carry to multi-instance Postgres.

## 5. Where to run it

**Recommendation: fly.io, used properly** (not today's single machine):

- **Main** = one fly app, auto-scaled replicas, in front of **managed Postgres** (fly's, or Neon/Supabase).
- **Redis** = Upstash or fly Redis.
- **Game servers** = a fleet allocated **per match via the fly Machines API**, placed in the region
  nearest the matched players; drains + stops at match end.
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

- **Phase 0 — Seams (no deploy change).** Within the monolith, draw a clean internal line between
  *control* modules (session/oauth/db/ranked-queue/puzzleApi) and *game* modules (game handlers/
  GameCreator/bots/territory/roomState/replay-capture). Stop adding cross-tier coupling. Pull game
  logic (`BoardLogic`/`GameCreator`/solver) toward a shared package.
- **Phase 1 — SQLite → Postgres.** Swap `db.js` to a Postgres-backed implementation (`pg` pool,
  async), add a migration tool, keep everything else single-process. This is the unlock for running
  more than one instance. (Optionally move replay BLOBs to object storage here.)
- **Phase 2 — Extract the control plane.** Split HTTP/auth/profile/leaderboard/**matchmaker-queue**
  into the stateless **main** service (N replicas, LB) on Postgres + Redis. The game still runs in a
  single backing process that main talks to.
- **Phase 3 — Extract game servers.** Move the live socket runtime (game handlers, GameCreator,
  bots, territory, replay capture) into a separate **game** service. Introduce the signed-token
  handoff: main allocates, clients connect **directly** to a game server. Start with a small fixed
  pool + Redis registry. Convert the client socket layer to address the assigned game server.
- **Phase 4 — Per-match allocation + multi-region.** Matchmaker allocates capacity (or spins a fly
  Machine per match) and places it near players; replay blobs → object storage; add reconnection
  (token re-resolves the same game server via main).
- **Phase 5 — Only if needed.** Graduate to Kubernetes + Agones, or migrate the realtime tier to
  Cloudflare Durable Objects, when real scale/latency demands it.

## 7. Cross-cutting concerns & open decisions

- **Reconnection / affinity**: a dropped player must rejoin the *same* game server — the signed
  token carries `gameServerAddr`+`matchId`; reconnection re-resolves through main.
- **Hidden information**: bots are disguised as humans in matchmaking and now also in replays
  (bot-ness is no longer recorded or shipped — see `replay.js`/`Replay.js`). Keep this invariant: no
  tier should leak bot identity to a client.
- **Result trust**: only main writes ratings; game servers *report* outcomes over an authenticated
  internal channel (don't trust the client; sign game-server→main reports too).
- **Static assets**: serve the client from a CDN regardless of tier choice (cheap immediate win even
  before any backend split — e.g. Cloudflare in front of fly).
- **Observability/cost**: more moving parts; mitigate cost with scale-to-zero game servers and
  scale-to-zero/auto-stop main replicas at low traffic.
- **Don't over-build**: a single beefier fly machine + Postgres carries a very long way for a
  click-paced game. Gate Phases 3–5 on measured need (matchmaking saturation, multi-region latency).
