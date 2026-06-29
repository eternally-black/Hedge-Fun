# Handoff — Card backgrounds, skins & the Card Designs shop

This covers everything added after the "football-themed deck background" request. All of it lives in `Hedge Fun.dc.html` (the interactive prototype). Prior features (swipe deck, HUD, Results Reveal, bell/inbox, GM, profile, referral, leaderboard) are documented in the main README in this folder — this file is the delta.

## What was built

### 1. Football pitch — automatic category art (NOT a purchasable skin)
Football markets render a **soccer-pitch background automatically** as part of the free **Classic** look. It is category art, not a shop item — do not sell it.
- `buildPitch()` returns an inline `<svg viewBox="0 0 300 470" preserveAspectRatio="xMidYMid slice">` of pitch markings (outer box, halfway line, centre circle + spot, both penalty + goal areas, penalty arcs, corner arcs), stroke `rgba(225,255,235,0.26)`, `vectorEffect:non-scaling-stroke`.
- Background gradient (`grass`): mowed-stripe `repeating-linear-gradient(178deg, …46px/92px)` + a top green bloom + a deep green base `linear-gradient(170deg,#123a26,#0a2014)`.
- Football markets were added to the deck data (`this.markets`): Real Madrid–Barça, Man City–Arsenal over 2.5, Haaland first goal — category `football` (accent `#2ee36a`, ball icon in `this.cats`).

### 2. Card skins system (collectible, bought with artifacts)
A card's whole background is driven by the **equipped skin**. `cardView(i, skinId)` calls `skinStyle(skinId || this.state.equippedSkin, categoryColor, isFootball)` which returns `{ bg, overlay }`:
- `bg` → the card's CSS `background` (gradient string **or** an image `url()`).
- `overlay` → an optional inline-SVG layer rendered above `bg`, below content.

**Current catalog** (`this.skins`, after trimming):
| id | name | cost (🛡) | background |
|---|---|---|---|
| `classic` | Classic | 0 | category tints; football → auto pitch |
| `vapor` | Vapor | 2 | synthwave: layered radial blooms (magenta/amber/cyan) on deep-purple→black + `buildGrid()` perspective grid overlay |
| `aurora` | Aurora | 5 | **real image** `assets/skin-aurora.png` (`center/cover`) |
| `midas` | Midas | 7 | **real image** `assets/skin-midas.png` (`center/cover`) |

Removed earlier procedural skins (looked cheap): Mercury, Ember, Prism, plus old Carbon / On-Chain / Holo / Gold Leaf / Stadium. If you re-add skins, prefer **real images** over procedural CSS — that was the explicit direction.

A premium skin, when equipped, applies to **all** cards including football (overrides the pitch).

### 3. Image-backed skins — how to add one
Drop the file in `assets/` (portrait **2:3, 1024×1536**, dark/calm in the top ~22% and bottom ~35% so the question text and odds/controls stay legible), then in `skinStyle` add:
```js
case 'myskin': return { bg:"#070501 center/cover no-repeat url('assets/skin-myskin.png')", overlay:null };
```
and add a `this.skins` entry `{ id, name, cost, accent, blurb }`. That's the whole wiring — shop tile, preview, and live deck all read from the same `skinStyle`.
There is a saved GPT-Image prompt pack (system context + per-skin prompts, 2:3, "background only, dark top/bottom") in the chat history if more art is generated.

### 4. Readability scrim (important — keep it)
Because backgrounds are now busy, every card has a fixed scrim **above the background/overlay, below the content**:
```
linear-gradient(180deg, rgba(0,0,0,.34) 0%, transparent 22%, transparent 52%, rgba(0,0,0,.5) 78%, rgba(0,0,0,.72) 100%)
```
It darkens the top (category/countdown chips) and bottom (odds bar, Stake/Win tiles, swipe buttons) so pitch lines / patterns never bleed into text or the semi-transparent controls, while the middle stays vivid. Applies to all skins.

### 5. Card Designs shop — lives INSIDE the Vault (no separate screen)
On the **Vault** screen (`screen==='shards'`), below streak-recovery:
- An **artifact balance** chip (`🛡 {artifacts}`) near the top of the Vault.
- A **"Card Designs"** section: a 2-col grid of skin tiles. Each tile shows a live `skinStyle` swatch (`bg` + `overlay`) + name + blurb + a state badge:
  - **Equipped** (lime bg) / **Owned** (dark) / **🛡 {cost}** (gold if affordable, dark if not).
- Tile tap → `openPreview(id)`.

### 6. Preview-before-spend overlay
`previewOpen` overlay (z-60) renders the selected skin **on the user's actual next market card** (real question/odds/countdown) stamped `PREVIEW`, so they see it before paying. The CTA is state-driven:
- not owned & affordable → **"Unlock for 🛡 N"** → `unlockSkin(id)` (deducts artifacts, adds to `ownedSkins`, equips instantly).
- not owned & not affordable → **"Need 🛡 N"** (disabled) + hint about forging shards.
- owned, not equipped → **"Equip design"** → `equipSkin(id)`.
- equipped → **"Equipped ✓"** (disabled).
Preview is always free; artifacts are only spent on explicit confirm. `closePreview()` (✕) exits.

### 7. Artifact economy
- State: `artifacts` (starts 3), `ownedSkins` (`['classic']`), `equippedSkin` (`'classic'`), `previewSkin`.
- `unlockSkin` spends `artifacts` and equips; guarded against insufficient balance / re-buying.
- **Streak revive** now genuinely **spends 1 artifact** (`reviveStreak()` checks `artifacts >= 1`), tying the artifact economy together (20 shards → 1 artifact → either a skin or a streak revival).

## Key functions / state (in the logic class)
- `this.skins`, `this.cats`, `this.markets` — catalog + data.
- `buildPitch()`, `buildGrid()` — inline-SVG overlays (used). `buildSheen()/buildVeins()/buildCircuit()` exist but are now unused after the trim — safe to delete.
- `skinStyle(id, col, isFootball)` — the single source of truth for a skin's look.
- `cardView(i, skinId)` — applies a skin to a market; exposes `bgGrad`, `pitch` (overlay), `watermark`.
- Handlers: `goSkins`*/`openPreview`/`closePreview`/`equipSkin`/`unlockSkin`/`reviveStreak`. (*the standalone skins screen was removed; shop is in the Vault. `goSkins` may be vestigial — the Vault renders the grid inline.)

## Assets
- `assets/skin-aurora.png` — iridescent silk waves, deep black top/bottom (1024×1536).
- `assets/skin-midas.png` — gilded isometric architecture on black (1024×1536).
Both load correctly and are referenced from `skinStyle` via relative `url()`.

## Notes for production
- Skins are pure presentation: a skin id + equipped/owned arrays + an `assets/` image. No backend coupling.
- For RN/Expo, map each `skinStyle` case to an `ImageBackground` (image skins) or a gradient stack (`expo-linear-gradient`, for Vapor/Classic); keep the SVG overlays via `react-native-svg`; reproduce the readability scrim as an absolute gradient between background and content.
- Keep the "real image > procedural" rule and the 2:3 / dark-top-and-bottom art spec for any new skins.
