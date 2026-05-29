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

### Learn

A single scrollable page (not a course):

1. **Read a number cell** — interactive grid. Hover a "1" cell, neighbouring
   squares highlight; one is the mine.
2. **Cascade reveals** — animated demo of why clicking a 0 opens up a region.
3. **Common patterns** — 1-1-2 wall, edge corner, 1-2-1 chain.
4. **Speed tricks** — chord (click number with enough flags), no-flag
   strategy, where to start.
5. **Ranked rules** — round timer, mine penalty, scoring, tournament cuts.

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

## 6. Design language

Current style works (dark, indigo, modal cards) — preserve it.

- **Icons:** small set per section. Existing emoji/symbols (🏆 🎯 📺 ⚙) are
  fine — don't introduce an icon library just for this.
- **Page transitions:** 120ms fade between views keeps the SPA feel (already
  used on `.view`).
- **Cards:** the home-card chassis is reusable. Practice mode, Learn topic,
  Achievement — same card, different content. Don't reinvent.

## 7. Out of scope (for now)

- Forum / chat (moderation burden, kills momentum).
- Friends graph (doesn't pay back without scale).
- Membership / paid tiers (way too early).
- Full course system (a Learn scroll is enough).

## 8. North-star single change

If only one thing ships from this doc, ship the **daily speedrun** — same
shared board, weekly leaderboard reset. It hooks returning players, gives
non-competitive players something to do solo, and makes the site feel alive.
