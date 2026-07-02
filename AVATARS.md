# Player avatar ideas

A backlog of fun player avatars to generate. The first one shipped is **mine-teddy** (a camo military
teddy bear) — these are meant to read as one cohesive set with it.

## House style
Keep them cohesive so they feel like a collectible set:
- Chibi / cartoon, **bold dark outline**, soft cel shading.
- **Transparent background, square (1024×1024)**.
- Character **centered and head-heavy** so it stays legible at ~28px (the in-game HUD avatar size).
- Same lighting / palette family as the mine-teddy.

## How to add one
1. Drop the art at `src/client/avatars/<id>.png`.
2. Add an entry to `AVATAR_IMAGES` in `src/client/core/BoardRender.js` (`{ <id>: "/avatars/<id>.png" }`).
3. It then appears automatically in the profile avatar picker (value `img:<id>`). No other wiring needed.

Optional: gate the **rare** ones behind Puzzle Ladder tiers or achievements so they double as rewards.

## Status legend
`idea` = concept only · `art` = image generated · `wired` = added to `AVATAR_IMAGES`

---

## 🪖 Tactical mascots (siblings of mine-teddy)
| id | concept | status |
|---|---|---|
| `mine-teddy` | camo military teddy bear holding a rifle — the original art, downscaled to **320×320 PNG** (~73KB, was 1024² / 1.4MB; avatars never render above ~184px so it's lossless in practice). | wired |
| `recon-fox` | ghillie-hood sniper fox, one eye squinting down a scope | wired |
| `eod-bulldog` | chunky bomb-squad blast suit, calmly snipping a wire | idea |
| `night-cat` | black cat in a tactical vest with green night-vision goggles | idea |
| `para-penguin` | penguin in goggles with open parachute straps + tiny boots | idea |
| `commando-croc` | crocodile with face paint, bandana, (cartoon) knife in teeth | idea |
| `sgt-hamster` | hamster in an oversized helmet, whistle, cheeks full of "supplies" | idea |
| `demo-raccoon` | bandit-mask raccoon hugging a bundle of cartoon dynamite, grinning | idea |

## 💣 Minesweeper-object characters (most on-theme)
| id | concept | status |
|---|---|---|
| `lil-mine` | the classic round black bomb with a stubby fuse + big friendly eyes (signature) | idea |
| `mine` | the game's spiky **sea-mine**, drawn procedurally on canvas (avatar value `"mine"`, no art file) | wired |
| `flag-buddy` | the in-game red pennant-on-a-pole with arms and a determined face | idea |
| `tile-one` | a cheeky number "1" tile-creature | idea |
| `tile-three` | a cool number "3" tile-creature | idea |
| `tile-eight` | a wide-eyed number "8" tile-creature | idea |
| `defused-dud` | a bomb with cut wires throwing a relieved peace sign | idea |
| `detonator-gremlin` | tiny imp gripping a plunger-detonator, eyes wild | idea |

## 🎮 Broader fun (variety / crossover appeal)
| id | concept | status |
|---|---|---|
| `tactical-droid` | boxy minesweeper-bot, single scanner eye, flag antenna | idea |
| `bit-invader` | pixel-alien nod wearing a tiny helmet | idea |
| `sweeper-ninja` | masked ninja holding a flag like a shuriken | idea |
| `astrosweeper` | astronaut planting a flag on a "mine" moon | idea |
| `deduction-wizard` | robed owl/wizard pointing at glowing clue numbers | idea |
| `boom-skull` | friendly cartoon skull in a camo bandana | idea |

## ✨ Rare / signature (good as unlocks)
| id | concept | status | suggested unlock |
|---|---|---|---|
| `golden-mine` | gilded `lil-mine` with a sparkle | idea | Puzzle Ladder Legend / prestige |
| `champion-teddy` | mine-teddy with a medal + laurel | idea | top ranked milestone |
| `sapper-dragon` | small dragon hoarding mines instead of gold | idea | achievement |
