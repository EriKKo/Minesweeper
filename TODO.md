# Minesweeper TODO

## Near-term: core game polish

- [ ] **Visual improvements** — make the board and UI more enjoyable to look at
  - [x] Tile reveal animations (staggered ripple from click), flag-place bounce
  - [x] Number colors with better contrast / readable on small laptop screens
  - [x] Raised/recessed tile depth, flag + bomb glyphs
  - [x] Win / loss / mine-hit effects (mine flash + board shake)
  - [ ] Per-player cursor colors visible to everyone
  - [x] Round timer warning/urgent states; per-round + series result panels (placement, clear times, points); scoreboard score-gain flash

- [~] **Audio** — WebAudio synthesis (no asset files)
  - [x] Reveal/cascade (pitched ripple), flag/unflag, mine explosion
  - [x] Countdown beeps + GO, win/lose + series stingers
  - [x] Mute toggle + volume slider, remembered in localStorage
  - [x] Opponent-finished cue (race tension; pitch rises with rivals done)
  - [ ] Optional background music

- [x] **Hotkey-only mode** — fully playable without a mouse (laptop-friendly)
  - Arrow keys to move; Shift+arrow skips revealed cells in that direction
  - Tab / Shift+Tab cycles to next / previous unknown cell anywhere
  - Space or X to reveal (chords on a known cell)
  - Z to flag (also chords)
  - Yellow focus-cell indicator drawn on the player canvas
  - Hotkey legend below the board
  - Mouse still works; clicking also moves the focus

## Later: powerups

- [ ] **Auto-chord on flag** — flagging a cell immediately chords every adjacent
  numbered cell whose mine count is now satisfied, revealing their other neighbors
  - Implemented in `GameCreator.js` behind `game.autoChordOnFlag` (default off)
  - Needs: a way to grant/activate it per player, UI affordance, balancing as a powerup

## Ranked mode

- [x] **Ranked mode** — accounts + pairwise-Elo ladder, matchmaking queue with bot fill
  - [x] Phase 1: SQLite accounts/sessions (`db.js`, node:sqlite), GitHub OAuth +
    env-gated dev login, authenticated socket, "Signed in as X · rating" badge.
    Guest nickname path still works. Real GitHub login needs an OAuth app +
    `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`; dev login via `DEV_AUTH=1`.
  - [x] Phase 2: "Find ranked match" queue (12s wait, live countdown), fixed ruleset
    (Bo5 / 2min / 5s / 30 mines), fills with bots; ranked rooms hidden from lobby,
    locked settings + RANKED tag in-game
  - [x] Phase 3: pairwise Elo after each round (K40 provisional <10 games, else K20),
    delta normalized by lobby size; bots use a fixed 1000 rating; persisted to DB;
    rating delta shown in the result panel + live badge update
  - [x] Phase 4: rank tiers (Bronze→Master, Unranked while provisional) on the badge,
    and a top-20 ranked leaderboard in the lobby

## Later: new formats

- [ ] **Knockout mode with big lobbies**
  - Lobby size beyond current 6-player cap
  - Single-elimination bracket across rounds
  - Spectator view for eliminated players

- [ ] **Cup of the Day (Trackmania-style)**
  - One shared daily seed, same board for everyone
  - Global leaderboard by completion time
  - Scheduled "cup" event window with live bracket at the end
