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

- `minesweeperServer.js` — HTTP + socket.io server: rooms, series, ranked matchmaking,
  OAuth/dev auth endpoints, bot orchestration.
- `minesweeperClient.html` — the entire client (markup + inline JS), canvas rendering.
- `style.css` — all styles.
- `GameCreator.js` — board/game state, mine placement, and the no-guess generator
  (`createNoGuessTemplate`) + deduction solver.
- `RoomCreator.js` — room and best-of-N series state.
- `BotPlayer.js` — bot AI (deduction + blunders), difficulty, and `configForElo`.
- `db.js` — SQLite (`node:sqlite`) for accounts, sessions, and ratings.

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
- Ranked uses a fixed ruleset (Best of 5, 2 min rounds, 5s mine penalty, 30 mines),
  pairwise Elo, tiers, and a leaderboard. Filler bots are tuned to the lobby's average
  rating and trickle into the queue like real players.
