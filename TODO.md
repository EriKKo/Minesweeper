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
  - [ ] Optional background music
  - [ ] Optional opponent-finished cue (race tension)

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

## Later: new formats

- [ ] **Knockout mode with big lobbies**
  - Lobby size beyond current 6-player cap
  - Single-elimination bracket across rounds
  - Spectator view for eliminated players

- [ ] **Cup of the Day (Trackmania-style)**
  - One shared daily seed, same board for everyone
  - Global leaderboard by completion time
  - Scheduled "cup" event window with live bracket at the end
