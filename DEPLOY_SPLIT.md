# Deploying the split (main + game) — P1-8

The app runs as a single binary in one of three roles via the `ROLE` env var (see `runtime/role.js`):

- **`both`** (default) — the monolith. This is what `fly.toml` deploys today; nothing about it changes.
- **`main`** — control plane: lobby/auth/matchmaking/puzzles/profile, owns SQLite, allocates matches.
- **`game`** — runs live matches handed to it by main; clients connect directly with a join token.

The split is **opt-in**: deploy `fly.main.toml` + `fly.game.toml` to run split, or keep `fly.toml` for the monolith. The same code, same tests; only the env differs.

## Why this gives no-downtime deploys
- A match runs entirely on a **game** server, not on main. **Deploying `main` never touches a live game** (lobby/matchmaking blips for a few seconds; the match keeps running on its game server, and clients' match sockets stay connected to it).
- **Deploying the game tier drains**: each game server, on `SIGTERM`, finishes its active matches and refuses new ones (`/internal/allocate` → 503), so main routes new matches to other servers. Done as a fleet rollover (below), no in-game player is cut.

## One-time setup
```sh
fly apps create msbattle-main
fly apps create msbattle-game
fly volumes create minesweeper_data -a msbattle-main -r arn -n 1   # SQLite lives here

# Shared secrets — INTERNAL_SECRET guards the main↔game API; MATCH_TOKEN_SECRET signs join tokens.
# Both MUST be identical across the two apps. Use long random values.
SEC=$(openssl rand -hex 32); TOK=$(openssl rand -hex 32)
fly secrets set -a msbattle-main INTERNAL_SECRET=$SEC MATCH_TOKEN_SECRET=$TOK \
    google_auth_client_id=... google_auth_client_secret=... discord_auth_client_id=... discord_auth_client_secret=...
fly secrets set -a msbattle-game INTERNAL_SECRET=$SEC MATCH_TOKEN_SECRET=$TOK
```

## Deploy
```sh
fly deploy -c fly.game.toml    # game fleet first, so main has somewhere to allocate
fly deploy -c fly.main.toml    # then the control plane
```
Point your domain (msbattle.net) at **msbattle-main**. `GAME_SERVERS` in `fly.main.toml` is the game
fleet's **public** URL (the browser is handed it in `match_handoff`, so it must be client-reachable);
`MAIN_URL` in `fly.game.toml` uses fly's **private** network (`msbattle-main.internal`) for result reports.

## Routing model (read this before scaling the game fleet)
- The browser loads the client from **main**, matchmakes there, then opens a **second socket directly to
  the game server** at the URL from `match_handoff`. Game servers enable CORS in code so this cross-origin
  socket is allowed; the signed join token is the real gate.
- **Single game machine (start here):** `https://msbattle-game.fly.dev` resolves to the one machine —
  everything just works. This is the recommended starting configuration.
- **Multiple game machines (scaling — NOT yet wired):** `msbattle-game.fly.dev` load-balances across
  machines, but a given match lives on **one specific** machine, so the client must reach *that* machine.
  That needs per-machine public addressing (fly-replay / a machine-pinned hostname) and main allocating to
  a specific machine + handing the client that machine's URL. The allocation already iterates
  `GAME_SERVERS` and falls through unhealthy ones, so the simplest multi-server setup is to list each game
  machine's own public URL in `GAME_SERVERS`. True per-match placement/affinity across an autoscaled fleet
  is the Phase 2 ("per-match allocation + multi-region") work.

## Draining / fleet rollover (deploying the game tier without cutting matches)
`fly deploy -c fly.game.toml` does a rolling replace by default, which would kill active matches. Instead:
1. Start new game machines on the new release.
2. The old machines receive `SIGTERM` → enter draining: finish active matches, refuse new ones (main
   routes elsewhere), then exit once empty (`runtime/lifecycle.js`; `kill_timeout` gives short matches
   time; longer ones keep the old machine alive until they end).
3. Destroy the drained old machines.
This is a Machines-API orchestration (a small deploy script), not a plain `fly deploy`. For a single game
machine with no players mid-match, a normal deploy is fine.

## Verifying
- Health: `curl -H "x-internal-secret: $SEC" https://msbattle-game.fly.dev/internal/health` →
  `{ok, role:"game", draining, activeMatches}`.
- Locally (what was used to verify P1-6 end-to-end), two processes on one box:
  ```sh
  RANKED_DB=/tmp/game.db ROLE=game PORT=1402 INTERNAL_SECRET=s MATCH_TOKEN_SECRET=t MAIN_URL=http://localhost:1401 node src/server/minesweeperServer.js &
  RANKED_DB=/tmp/main.db ROLE=main PORT=1401 DEV_AUTH=1 INTERNAL_SECRET=s MATCH_TOKEN_SECRET=t GAME_SERVERS=http://localhost:1402 node src/server/minesweeperServer.js &
  # open http://localhost:1401, queue ranked → the match runs on :1402
  ```

## Rollback
Deploy `fly.toml` (the monolith) to the main app — `ROLE` defaults to `both` and the whole app runs in one
process again. Nothing in the split changes the monolith's behaviour, so this is always safe.
