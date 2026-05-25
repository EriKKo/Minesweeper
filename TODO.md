# Minesweeper TODO

## Near-term: core game polish

- [ ] **Visual improvements** — make the board and UI more enjoyable to look at
  - Tile reveal animations, flag-place animation
  - Number colors with better contrast / readable on small laptop screens
  - Per-player cursor colors visible to everyone
  - Win / loss / mine-hit effects
  - Round timer and score display refresh

- [ ] **Audio** — sound effects and (optional) music
  - Click / reveal / flag / chord sounds
  - Mine explosion, freeze-penalty cue
  - Round start countdown, round end, win/lose stingers
  - Volume + mute toggle, remembered per client

- [ ] **Hotkey-only mode** — fully playable without a mouse (laptop-friendly)
  - Arrow keys / WASD to move cursor
  - One key to reveal, one to flag, one to chord
  - Visible focused-cell indicator
  - Hotkey legend / help overlay

## Later: new formats

- [ ] **Knockout mode with big lobbies**
  - Lobby size beyond current 6-player cap
  - Single-elimination bracket across rounds
  - Spectator view for eliminated players

- [ ] **Cup of the Day (Trackmania-style)**
  - One shared daily seed, same board for everyone
  - Global leaderboard by completion time
  - Scheduled "cup" event window with live bracket at the end
