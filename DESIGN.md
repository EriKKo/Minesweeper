# MSBattle — UX vision

A design-and-direction document for the site (not the game engine). Lives
alongside `CLAUDE.md` so anyone touching the project has the same map.

## 1. Audit — where we are

**Strengths**
- Ranked is solid: 1v1, 6-player, 16-player tournament, sub-tier ladder, instant
  Elo, animations.
- Custom lobbies for casual play.
- Mobile and desktop both work.

**Gaps as a *site* (vs. as a *game*)**
- No onboarding. A new player who's never played minesweeper drops straight
  into a ranked queue.
- No solo practice. You can't warm up without forming a casual room.
- No profile page. No match history, win rate, recent rating trend, or even
  total games played.
- Leaderboard is a thin strip on the home page. No mode filters, no time
  windows, no positions outside top 5.
- No "why I lost" content — no puzzle / training loop.
- Discoverability of features is poor. Nothing tells you what 6-player or
  tournament actually are until you click them.

## 2. Principles

1. **One verb per click.** Land → see clearly what you can *do*.
2. **Competitive is the spine, learning is the on-ramp.** New players need a
   path that doesn't require already being good.
3. **Daily reasons to return.** The reason chess.com works isn't the matches
   — it's the daily puzzle, the lesson streaks, the leaderboard you check.
4. **Identity over interface.** Your tier, your win streak, your medals —
   these should be visible and personal everywhere.

## 3. Direction

We're working toward Proposal **A — "Chess.com Hub"** (persistent top nav with
*Play · Learn · Practice · Puzzles · Leaderboard · Profile*, curated home
carousels). Getting there in phases via Proposal **B — "Game Launcher"**
(compact home + small top nav).

### Phase 1 (B layout, ship now)
- Add top nav links: *Learn*, *Practice*, *Leaderboard*, *Profile*.
- Each is a real page, even if MVP.
- Home cards (1v1 / 6p / Tournament / Custom) stay.

### Phase 2 (towards A)
- Daily speedrun on the home page.
- Leaderboard becomes its own full page with mode + tier filters and a time
  window selector.
- Profile shows match history + rating chart.

### Phase 3 (full A)
- Daily puzzle + puzzle rush.
- Watch / TV (live ongoing top-rated matches).
- Achievements.

## 4. Concrete sub-page sketches

### Learn  *(implemented)*

A single scrollable page (not a course): an interactive **deduction trainer**.
Eight collapsible lessons, ordered by difficulty, each with a written
explanation, a "watch out" pitfall, and clickable puzzle boards. Left-click marks
a cell safe, right-click (or a Safe/Mine toggle) flags a mine; the board grades
each move and reveals the reasoning once solved.

1. **Forced mines** — number == covered neighbours.
2. **Satisfied clear** — number == known mines, so the rest are safe.
3. **Subset rule — safe cells** — nested clues, equal counts.
4. **Subset rule — mines** — nested clues, count gap == extra cells.
5. **Named patterns** — 1-2-1 and 1-2-2-1.
6. **Chains** — multi-clue cascades, including islands.
7. **Enumeration** — assume-and-contradict case analysis.
8. **Smart guessing** — comparing local per-cell odds (no global mine count,
   matching the game).

Because the game never shows the total mine count, all whole-board counting
deductions are deliberately excluded — every technique is local.

Lesson + puzzle content is data-driven (`LEARN_LESSONS` in
`minesweeperClient.html`); the editable source-of-truth text lives outside the
repo in `../minesweeper-trainer/` (lesson plan + one `.txt` per puzzle). Ranked
rules stayed as a separate card on the same page.

### Practice

Four solo modes (no opponents, no Elo):

| Mode | What it is |
|---|---|
| Daily Speedrun | Same shared board everyone gets today. Race the clock. Daily leaderboard. **This is the killer feature.** |
| Free play | Any board size / density. Just play. |
| Pattern drills | Sequence of small ~6×6 puzzles focused on one technique. |
| Bot trainer | 1v1 against a specific Elo bot. |

### Profile

```
Erik          Gold III · 1402 · ▲ this week +12
─────────────────────────────────────────────
                  1v1    6-player  Tournament
Played            42     18        6
Win rate          54%    22%       33%
Avg place         —      2.4       4.5
Best finish       —      1st (×4)  3rd
─────────────────────────────────────────────
[Rating chart over time]
─────────────────────────────────────────────
Recent matches (last 10)
Achievements   3 / 24
```

Server-side most of this is already there (`users` has rating, played, wins).
Needs: per-mode breakdown, match history table, achievements.

### Leaderboard

```
Leaderboard                                  [All time ▾]
Mode:  [All]  [1v1]  [6-player]  [Tournament]
Tier:  [All]  [Master]  [Diamond]  [Platinum]  …

 1.  ghostFox     Master       1894   ▲22 (week)
 2.  Nora92       Diamond III  1742   ▲8
 …
14.  You          Gold III     1402   ▲5
```

Pagination, mode/tier filters, time window, your row pinned visible.

### Watch / TV (later)

Live currently-running matches of top-rated players. Click to spectate.
For 16-player tournaments, "watch the final" button after eliminated cuts.

## 5. Quick wins (do before full A)

- **Daily speedrun** card on the home page. "Today's board · 1 of 12 ranked
  players cleared in under 45s — try it →"
- **This week's top players** on home (we already have `db.topPlayers(20)`).
- **Achievement badges** on scoreboard rows ("🔥 3-streak"). Small backend
  work, big personality.
- **Recent matches** strip on home page so returning players see "Welcome
  back — you went 3-1 last night, ▲14 rating."

## 6. Visual & game-feel language

The dark/indigo base is good and stays. But today the product speaks in two
registers: the **chrome** (home, picker, leaderboard, profile) reads like a calm
dark SaaS dashboard, while the **game** (the duel HUD, board, countdown) is
genuinely vivid. The energy only switches on once you're in a match. The job is
to carry that in-game vividness *outward* into the menus, and to make the calm
parts calm *on purpose* (focus) rather than under-designed.

### Principles (hold everything to these)

1. **Clarity is sacred.** The board + live state read in a glance; chrome never
   competes with play. Nothing below overrides this.
2. **Juice the verbs.** Every action and transition (reveal, flag, chord, queue
   pop, win, rank-up) gets disproportionate feedback — easing, motion, a flash,
   a sound. Cheapest, highest-yield quality multiplier we have.
3. **Dramatize the contest.** Make other players present and the stakes visible
   — opponent boards, the live tug, KOs, "N playing now", spectating.
4. **Identity is the retention engine.** Tier, rating, streak, badges, name —
   surfaced everywhere and *celebrated when they change*. The ladder is the draw.
5. **One primary action per screen.** Land → instantly know the one thing to do.
6. **One language.** A single type scale, disciplined colour logic, motion
   grammar, and one motif (the minesweeper tile), applied consistently.

The ritual that ties them together — **anticipation → payoff**: queue →
match-found → reveal → countdown → GO → result. It's the spine of the UX.

### The system (formalized)

- **Type.** One display face (geometric grotesk, `--font-display`) for headings,
  brand, names, and **numbers** (ratings, timers, %, KO counts — heavy weight,
  tabular figures); system sans for body. Scale: `12 · 14 · 16 · 20 · 28 · 40 · 56`.
  A single flat weight is the #1 reason the menus feel inert.
- **Colour.** Keep navy + indigo as the base, layered as a *system*:
  - **Per-mode accents** (`--mode-sprint` amber, `--mode-standard` violet,
    `--mode-tournament` gold, `--mode-territory` cyan) tint a mode's card edge,
    hover glow, and in-game chrome — so each mode has identity.
  - **Energy accents** (`--energy-win` lime, `--energy-gold`, `--energy-streak`
    orange), used *rarely* so they punch — wins, streaks, rank-ups.
  - Raise interactive contrast: elevated card surface + a hairline that brightens
    on hover.
- **Motion grammar.** Three tokens — `--motion-micro 120ms` (hover/press),
  `--motion-standard 220ms` (cards, view transitions), `--motion-emphatic 400ms`
  (reveals, celebrations) — on a shared ease (`--ease`). Numbers count up, never
  snap. Respect `prefers-reduced-motion`.
- **Depth / the tile motif.** The board's tiles already have the right
  physicality (top highlight, gradient, bottom shadow). Make that the brand
  language: primary buttons and key cards are "tiles" — raised, with a press-down.
  The minesweeper cell *is* the identity; reuse it as button, logo, empty state.
- **Sound.** `Sound.js` is procedural and underused. Distinct cues for reveal /
  flag / chord / match-found / countdown / win / lose / rank-up. Toggleable.
- **Icons:** small set per section; existing emoji/symbols are fine — no icon
  library. **Cards:** one reusable chassis (mode / practice / learn / achievement).
  **Page transitions:** the 120ms `.view` fade stays.

### Build order (each multiplies the next)

1. **Foundations** — type scale + display face, motion tokens, mode-accent +
   energy colour system, the tile/elevation language. Low risk, lifts every
   screen at once. *(Done.)*
2. **Result moments** — win/lose/rank-up celebration, rating count-up, sound.
   Highest emotional payoff. *(Done: win-header glow/pop; rating counts up in the
   rank-swap column; sound cues — seriesWin/lose, rankUp/rankDown on tier
   crossings, matchFound when a ranked match forms. `playResultMoment` in
   MatchPanels.js drives it. Confetti was tried and removed — too much. The 1v1
   duel ends in two stages (TetrisFriends-style): big on-board YOU WIN / YOU LOSE
   banners (`showDuelOutcome`) + the win/lose sound, then ~2.2s later the results
   modal (rating count-up + rank-up sound + Play another/Back to menu). NB:
   "Play another"/"Find another game" re-queue and stay fullscreen; only the
   explicit "Back to menu/lobby" leaves exit fullscreen via `leaveRoom`.)*
3. **Home as a launcher** — a "you" strip (rank · rating · streak · ▲ week) + one
   hero CTA + vivid, differentiated mode cards.
4. **Leaderboard podium + profile identity** (rank badge + progress-to-next-tier).
5. **Polish pass** — hover/press juice, view transitions, count-ups everywhere.

**Guardrails:** clarity beats flash; stay asset-light (≤ one display face, no
heavy images); evolve the base, don't reskin it; honour reduced-motion + contrast.

**North star:** make the menus feel like the lobby of a competitive game, and
make every win feel earned.

## 7. Out of scope (for now)

- Forum / chat (moderation burden, kills momentum).
- Friends graph (doesn't pay back without scale).
- Membership / paid tiers (way too early).
- Full course system (a Learn scroll is enough).

## 8. North-star single change

If only one thing ships from this doc, ship the **daily speedrun** — same
shared board, weekly leaderboard reset. It hooks returning players, gives
non-competitive players something to do solo, and makes the site feel alive.
