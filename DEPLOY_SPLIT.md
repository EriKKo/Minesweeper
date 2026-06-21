# Deploying the split (main + game) — P1-8

The app runs as a single binary in one of three roles via the `ROLE` env var (see `runtime/role.js`):

- **`both`** (default) — the monolith. This is what `fly.toml` deploys today; nothing about it changes.
- **`main`** — control plane: lobby/auth/matchmaking/puzzles/profile, owns SQLite, allocates matches.
- **`game`** — runs live matches handed to it by main; clients connect directly with a join token.

The split is **opt-in**: deploy `fly.main.toml` + `fly.game.toml` to run split, or keep `fly.toml` for the monolith. The same code, same tests; only the env differs.

## Why this gives no-downtime deploys
- A match runs entirely on a **game** server, not on main. **Deploying `main` never touches a live game** (lobby/matchmaking blips for a few seconds; the match keeps running on its game server, and clients' match sockets stay connected to it).
- **Deploying the game tier drains**: each game server, on `SIGTERM`, finishes its active matches and refuses new ones (`/internal/allocate` → 503), so main routes new matches to other servers. Done as a fleet rollover (below), no in-game player is cut.

## App layout
- **main = the existing `erik-minesweeper` app**, redeployed in the `main` role (`fly.main.toml`). It keeps
  its volume / ratings DB / `msbattle.net` domain / OAuth — nothing to migrate.
- **game = a new `msbattle-game` app** (`fly.game.toml`), stateless.

## One-time setup
```sh
fly apps create msbattle-game

# Shared secrets — INTERNAL_SECRET guards the main↔game API; MATCH_TOKEN_SECRET signs join tokens.
# Both MUST be identical across the two apps. (erik-minesweeper already has the OAuth secrets.)
SEC=$(openssl rand -hex 32); TOK=$(openssl rand -hex 32)
fly secrets set -a erik-minesweeper INTERNAL_SECRET=$SEC MATCH_TOKEN_SECRET=$TOK
fly secrets set -a msbattle-game     INTERNAL_SECRET=$SEC MATCH_TOKEN_SECRET=$TOK

# Push-to-deploy: create a deploy token and add it to GitHub as the FLY_API_TOKEN repo secret
# (repo → Settings → Secrets and variables → Actions → New repository secret).
fly tokens create deploy
```
Then **disconnect fly.io's built-in GitHub auto-deploy** in the fly dashboard (it deploys the monolith
`fly.toml` to erik-minesweeper and would fight the workflow below). `GAME_SERVERS` in `fly.main.toml` is
the game fleet's **public** URL (handed to the browser in `match_handoff`, so it must be client-reachable);
`MAIN_URL` in `fly.game.toml` uses fly's **private** network (`erik-minesweeper.internal`) for reports.

## Deploy
Push to `master` → `.github/workflows/fly-deploy.yml` deploys the game fleet, then the control plane.
Or manually, in the same order:
```sh
fly deploy -c fly.game.toml    # game fleet first, so main has somewhere to allocate
fly deploy -c fly.main.toml    # then the control plane (erik-minesweeper)
```

## Routing model (read this before scaling the game fleet)
- The browser loads the client from **main**, matchmakes there, then opens a **second socket directly to
  the game server** at the URL from `match_handoff`. Game servers enable CORS in code so this cross-origin
  socket is allowed; the signed join token is the real gate.
- **Single game machine (start here):** `https://msbattle-game.fly.dev` resolves to the one machine —
  everything just works. **This is enforced**: the deploy workflow runs `fly scale count 1` after deploying
  the game app, because fly creates 2 machines by default and there's no count field in `fly.toml` for
  Machines apps. With >1 machine the public hostname load-balances and a client's match socket can hit a
  different machine than the one main allocated to → the attach fails and matchmaking hangs at N/size.
  **Do not `fly scale count` the game app past 1** until per-machine routing (below) is wired.
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
