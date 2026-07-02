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

## Generating art (local ComfyUI)

Set up at `~/workspace/ComfyUI` (Intel Mac, CPU-only — the newest PyPI torch wheel for x86_64 macOS is
`2.2.2`, so ComfyUI is checked out at a pre-`comfy_kitchen` commit with `numpy<2` pinned for ABI
compatibility). Checkpoints in `models/checkpoints/`: `toonyou_beta6.safetensors` (SD1.5, cartoon,
reliable for animal/anthro features but drifts painterly if you add "furry"/"kemono" tags) and
`counterfeitV30_v30.safetensors` (SD1.5, much cleaner flat-vector linework matching the house style, but
needs the animal-feature tags pushed harder — plain breed names alone tend to render human/anime faces).

**Best recipe found so far — img2img from mine-teddy** (run through ComfyUI's `/prompt` API, not the UI):
composite `mine-teddy.png` onto a solid white background first (its transparent pixels are stored as
black, and ComfyUI's `LoadImage` drops alpha rather than compositing, so skipping this makes the output
background go black), `VAEEncode` it, then `KSampler` at `denoise: 0.6` (not full noise) so the pose/
chibi-proportions/composition carry over from teddy while the prompt swaps in the new subject. Prompt
shape: lead with `(chibi:1.3), (super deformed:1.2), huge head small body, short stubby arms and legs`,
then the subject with feature tags at ~1.2–1.4 weight (e.g. `(wrinkled bulldog snout:1.4), (black
nose:1.3)` — plain unweighted breed words are not enough), then
`bold dark outline, flat cel shading, simple flat solid white background, simple shapes, clean lineart,
minimal detail, full body shot, complete character within frame, not cropped, centered with margin`.
Negative: `worst quality, low quality, painterly, realistic fur texture, textured background, cropped,
portrait, adult proportions, human face` (avoid "no X" phrasing — negatives work as anti-conditioning on
the words themselves, not natural-language instructions). ~3–9 min per image on CPU depending on denoise.

After generating: `~/workspace/ComfyUI/make_avatar.py <src.png> <dst.png> <size>` flood-fills the white
background to transparent (from the corners, so it doesn't eat white used inside the character), crops to
the character's bounding box, pads ~6%, and downscales — `320` matches `mine-teddy.png`'s convention.
Verify it reads at 28px (avatars never render bigger in-game) before wiring it in via "How to add one" above.

## Status legend
`idea` = concept only · `art` = image generated · `wired` = added to `AVATAR_IMAGES`

---

## 🪖 Tactical mascots (siblings of mine-teddy)
| id | concept | status |
|---|---|---|
| `mine-teddy` | camo military teddy bear holding a rifle — the original art, downscaled to **320×320 PNG** (~73KB, was 1024² / 1.4MB; avatars never render above ~184px so it's lossless in practice). | wired |
| `recon-fox` | ghillie-hood sniper fox, one eye squinting down a scope | wired |
| `eod-bulldog` | chunky bomb-squad blast suit, calmly snipping a wire | wired |
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
