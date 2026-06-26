# Handoff: Hedge Fun — swipe-based prediction game

## Overview
Hedge Fun is a mobile-first, portrait, swipe-based prediction game built on real prediction-market data, played in **paper-trading mode** (virtual $ balance, zero real-money risk). It is a game, not a trading terminal. The feel is **Tinder × TikTok**: tactile card-swipe physics fused with full-bleed, immersive, momentum-driven flow.

Core loop: predict (swipe) → earn points → keep a daily streak → collect shards → return to relive resolved wins.

## About the Design Files
The files in this bundle are **design references authored in HTML** (Design Components — a thin React-over-template runtime). They are prototypes that demonstrate the intended look, motion, and behavior — **not production code to copy verbatim**. The task is to **recreate these designs in the target codebase's environment** (React Native / Expo for the primary Android target, or React for responsive web) using its established patterns, gesture libraries, and animation tooling. If no environment exists yet, pick the most appropriate stack (recommendation below) and implement there.

**Recommended stack:** React Native + Expo, `react-native-gesture-handler` + `react-native-reanimated` for the swipe physics, `react-native-haptic-feedback` for commit haptics. For web, React + Framer Motion (or a pointer-based drag) reproduces the same physics.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, motion timings, and interaction thresholds are specified below and should be reproduced precisely. The product ships in a single visual direction: **Neon Arcade**.

---

## Design Tokens

### Signal colors (LOCKED — semantic)
| Token | Hex | Meaning |
|---|---|---|
| `--yes` | `#B6FF2E` | YES · swipe RIGHT |
| `--no` | `#FF3B4E` | NO · swipe LEFT |
| `--skip` | `#4D9BFF` | SKIP · swipe UP |
| `--gold` | `#FFC24B` | shards / artifacts economy |

### Base tokens (Neon Arcade)
| Token | Value |
|---|---|
| `--bg` | `#0A0A0F` |
| `--bg2` | `#101019` |
| `--panel` | `#15151F` |
| `--panel2` | `#1C1C2A` |
| `--line` | `rgba(255,255,255,.09)` |
| `--text` | `#F4F4FA` |
| `--muted` | `#8B8B9E` |
| `--energy` (points/energy accent) | `#FF3DCD` |
| display font | Anton |

Category accent colors (the dot/glow on each card): crypto `#FF8A3D`, sports `#3D7BFF`, esports `#B14DFF`, weather `#19C8FF`, politics `#94A3B8`.

### Typography
- **Display** (`--df`): **Anton**. Used for market questions, big numbers (count-up, odds, balances, countdown), YES/NO/SKIP stamps, screen titles.
- **Body** (`--bf`): **Hanken Grotesk** — weights 400/500/600/700/800. All labels, descriptions, copy.
- **Numerals** (`--nf`): **Space Mono** 700 — every game number (points, $ balances, %, countdown, payouts). Tabular, "game-like".
- Question on card: 34px / line-height 1.02 / letter-spacing .2px / `text-wrap: balance`.
- Section labels: 9–10px, letter-spacing .12–.16em, uppercase, `--muted`.

### Spacing / radius / shadow
- Card radius: **26px**; panels/tiles: **14–18px**; chips/pills: **20–30px**.
- Screen horizontal padding: **16px** (deck card margin 14px).
- Card shadow: `0 24px 50px -18px rgba(0,0,0,.7)`.
- HUD/panel borders: `1px solid var(--line)`.
- Device frame (mock only — not part of the app): 402×872 logical, 38px inner screen radius.

---

## Screens / Views

The app shell = **persistent HUD (top) + screen body + bottom nav**. Overlays (auth, card detail, results reveal) sit above the shell.

### 0. App shell — HUD + bottom nav (persistent)
- **HUD top row** (left→right): Points pill (energy dot + `--nf` value + "POINTS" caption) · Streak pill (🔥 flame + day count, taps to GM) · spacer · Virtual-$ pill (right-aligned, `--yes` value, "VIRTUAL $") · **Bell** button (38×38 circle). Bell shows an **unread badge** (top-right, `--no` background, white `--nf` count, `hfBadgePop` on mount) and **swings** (`hfBellSwing`, 2.6s loop) while unread > 0.
- **HUD shard strip** (below row): `◆ {shards}/20` (gold) + progress bar (`linear-gradient(90deg,#c98a1e,--gold)`, width = shards/20) + "→ artifact". Whole strip taps to Vault.
- **Bottom nav** (5 items, active = `--energy`, inactive = `--muted`): Deck ⚡ · GM ☀ · Vault ◆ · Invite ＋ · You ◉.

### 1. Onboarding / auth (overlay, z-90)
- Full-screen radial-energy-glow background.
- Eyebrow "HEDGE FUN" (.3em tracking, energy) → display headline **"CALL IT. FARM IT."** (68px) → subcopy → three swipe-legend chips (⟶ YES / ⟵ NO / ↑ SKIP).
- Two stacked buttons: "𝕏 Continue with Twitter" (white) and "✉ Continue with Email" (panel). Footer: "No wallet. No seed phrase. No risk."
- Tapping either button = authenticate (no real OAuth in mock) and trigger the **daily-open ritual** (see Interactions).

### 2. Blitz Deck (HERO)
Full-bleed vertical card deck. Three stacked layers: third card (scale .88, opacity .5), next card (scale .93, preview of question + category), **top card (interactive)**.

**Card anatomy** (top card):
- Background: `radial-gradient(120% 80% at 80% 0%, <cat>2e, transparent 55%), linear-gradient(170deg, --panel2, --panel)` + large faint category-icon watermark bottom-right.
- Top row: category chip (dot + label) · countdown chip (⏱ + `--nf` time; turns `--no` with red border when < 1h to resolution).
- Center: market question (display, 34px).
- Odds split: label row `NO {n}%` (left, `--no`) · `{y}% YES` (right, `--yes`); bar fills NO from left (red) → YES from right (lime). **Direction matches the swipe.**
- Stake + payout row: Stake $100 tile · Win No tile (left, red-tinted) · Win Yes tile (right, lime-tinted). `--nf` numbers.
- Hint: "Tap for details · swipe to call".
- **Three direction overlays** (opacity driven by drag progress): YES = lime wash from right, NO = red wash from left, SKIP = blue radial glow centered.
- **Three stamps** (top of card): NO top-left (rotate -15°), YES top-right (rotate +15°), SKIP top-center. Each scales/fades in with drag progress.

**Fallback buttons** (below deck, for web/accessibility, never dominant): ✕ NO (red outline) · ↑ SKIP (blue) · ✓ YES (lime). 56/46/56px circles.

### 3. Card detail (bottom sheet overlay, z-50)
Tap a card → blurred backdrop + bottom sheet (`--bg2`, radius 28px top, slides up via `hfRise`). Grabber bar → category + countdown chips → question (display 30px) → resolution description → odds split (NO-left / YES-right, 16px bar) → 3-up grid (Stake / Volume / Resolves) → two big buttons (NO win $ / YES win $). Tapping a button commits that side and closes the sheet.

### 4. Results Reveal (overlay, z-88) — the dopamine peak
Plays on app open, **before the deck**, replaying what resolved while away. Three phases:

**a. Aggregate** — radial glow (green if net ≥ 0, else red). Eyebrow "While you were away" → **big net-$ count-up** (display 84px, e.g. `+$340`, glow in net color) → "net virtual P&L · {n} calls settled" → three tiles: Won (`--yes`), Lost (`--no`), +Shards (`--gold`). Pulsing CTA "Tap to relive your calls →". Each element staggers in via `hfBigIn`.

**b. Featured cards** — progress dots at top, then up to **5** result cards play sequentially. Each card: category chip + outcome badge (WON/MISSED/REFUNDED in accent color), the market question (muted), the **real outcome** in display ("Luka dropped 47"), "Your call" + side stamp, big `--nf` delta (+$235 / −$100 / $100), and a footer line (wins: "+N ◆ shards collected" in gold; losses: soft "So close — no payout this time"; void: "Market voided · your $100 stake was returned"). Card enters with a 3D flip (`hfFlipIn`, perspective 900px, rotateY 82°→0). **Wins** add a coin burst (`hfCoin`, 14 🪙 rising) + lime glow shadow. Auto-advance ~1.5s; tapping anywhere advances immediately.

**c. Summary / chain-forward** — 🎉 "That's a wrap" → shard-chain card ("+N shards collected", `{shards}/20`, progress bar, "M more to forge your next artifact") → collapsible "See all {n} results" (expands the inbox list) → "Continue →" CTA into GM/Deck.

**Peak-end ordering:** featured cards are NOT chronological — they end on the user's biggest win. In the prototype `featuredOrder = [0,1,2,3,5]` (drops the dullest loss, ends on the +235 win).

**Hard rules (must keep):**
- Persistent **Skip ✕** top-right on aggregate AND every card. One tap → instantly out → GM → Deck. No confirmation, no waiting.
- Skipping costs nothing — balances/shards already credited; the reveal only *shows*.
- Skipped results stay **unread in the bell** (badge persists). Watching through to summary clears unread.
- Hard ceiling: aggregate + max 5 cards + collapsed list — never more, regardless of resolution count.
- Void/cancelled → neutral "Refunded" card, never win/loss.

### 5. Notifications inbox (bell screen) — calm counterpart
Durable feed of every resolution receipt, newest first, grouped by day ("Today"). Header "Results" + "Replay" button (re-runs the reveal). Each row: category icon tile (accent-tinted) · question + "Your call {side} · {outcome}" · right side delta (`--nf`, accent) + tag (Won/Lost/Void) + "+N ◆" if shards. Lean-back, scannable, calm — opening this screen sets unread to 0.

### 6. Daily GM / check-in
Radial energy glow. 🔥 (64px, `hfFlame` loop) → "GM, DEGEN" (display 54px) → "Day N bonus is ready" → 7-day week row (done days gold 🔥, today outlined energy) → reward card (+100 Points / +1 ◆) → primary button. Before claim: "☀ Claim & keep streak" (claims: streak+1, +100 pts, +1 shard, fires confetti `hfConfetti`). After claim the button becomes "Enter the deck →" and a "Skip to the deck →" link appears.

### 7. Profile / Wallet
Avatar + handle + rank chip → 2×2 stat grid (Points / Virtual P&L / Streak / Shards) → action row (Daily GM / Invite) → Prediction history list (side tile YES/NO + question + category + status won/lost/pending + delta).

### 8. Shards → artifact + streak recovery (Vault)
"The Vault" → circular shard progress ring (SVG, gold stroke, `{shards}/20` center, ◆ glyph) → "M more shards to forge your next artifact" → Artifacts row (owned "Ember Sigil" 🛡 pulsing + locked slots) → **streak-recovery card**: when alive, shows "Streak protected" + a "simulate a burned streak →" preview link; when burned, shows "Streak burned out" 💀 + "3 days to revive" + gold CTA "🛡 Spend 1 Artifact → Revive 6-day streak".

### 9. Referral / invite
🤝 → "Farm faster with friends" → invite link row (`hedge.fun/r/dana-XXXX`) + Copy button (→ "Copied!" 1.6s) → share row (𝕏 / Telegram / More) → 2-up stats (Friends joined / Points earned) → recent invites list (avatar + name + status).

### 10. Leaderboard (secondary/stretch)
"Leaderboard" + weekly reset countdown → 3-up podium (sized bars, gold ring on #1) → ranked list; the current user's row is highlighted with an energy border and labeled "(you)".

---

## Interactions & Behavior

### Swipe physics (the product — get this exactly right)
- Card follows the pointer/finger 1:1: `translate(dx, dy) rotate(dx * 0.05deg)`.
- **Direction detection** on move: if `|dy| > |dx| * 1.15 && dy < 0` → SKIP (up); else `dx > 0` → YES, `dx < 0` → NO.
- **Progress** = `min(1, axisDistance / 130px)`. Overlay opacity = progress. Stamp opacity = `clamp((progress - 0.15) / 0.5, 0, 1)`, stamp scale = `0.6 + 0.4*progress`.
- Stack behind animates with drag: next card scale `0.93 + 0.07*dragMag`, third `0.88 + 0.05*dragMag` where `dragMag = min(1, (|dx|+|dy|)/200)`.
- **On release**: if `progress >= 1` (past threshold) → **commit**; else spring back via `transition: transform .45s cubic-bezier(.34,1.4,.5,1)` (overshoot bounce).
- **Tap** (no movement, < 300ms) → open card detail.
- **Commit fling**: YES → `translate(150%,-12%) rotate(26deg)`; NO → `translate(-150%,-12%) rotate(-26deg)`; SKIP → `translate(0,-170%) rotate(-3deg)`. Transition `.38s cubic-bezier(.45,0,.25,1)`, opacity→0. After 360ms the card is replaced by the next.
- Implied **haptic** on commit (light impact for YES/NO, selection tick for SKIP) + optional micro-sound.

### Bet-placed micro-moment (deliberately lightweight)
On commit, a small `+50` (YES/NO) or `+5` (SKIP) floats up at the **Points pill** in the HUD (`hfPts`, .65s), colored by side, while the old card flings away. **No full-screen burst** — an earlier heavy centered celebration was removed because it visually collided with the incoming card. Points increment immediately; a shard is awarded ~50% of the time on a bet (mock).

### Daily-open ritual (one coherent sequence, not competing popups)
`auth success → if unrevealed results exist: Results Reveal → GM check-in → Deck; else: GM → Deck`. A brand-new user with no results never sees an empty reveal.

### Reveal state machine
`enterReveal()` → phase `aggregate` → tap → `cards` (auto-advance 1.5s timer per card, tap advances) → after last featured card → `summary` (sets unread 0) → "Continue" → clears reveal, go GM. `skipReveal()` clears the reveal and goes to GM **without** zeroing unread (the safety net). `replayReveal()` (from inbox) re-enters.

### Other
- Copy button: optimistic "Copied!" for 1.6s.
- Countdown ticks every 1s (paused during drag).
- Text selection disabled app-wide (`user-select:none`) so dragging never selects card text.

---

## State Management
Top-level state (prototype keeps it all in one component; in production split into contexts/stores):
- `screen`: 'deck' | 'profile' | 'gm' | 'shards' | 'referral' | 'leaderboard' | 'notifications'
- `idx`: current deck index (markets are cycled modulo length)
- `points`, `vbal` (virtual $), `streak`, `shards` (0–20), `unread`
- `drag`: `{ active, dx, dy, dir, progress }` — transient gesture state (keep off React state for 60fps; use Reanimated shared values)
- `fly`: committed direction during fling | null
- `pop`: `{ amt, color }` for the HUD points float | null
- `detail`: card-detail payload | null
- `reveal`: `{ phase, i }` | null
- `seeAll`, `gmDone`, `streakBurned`, `copied`, `auth`
- `history[]`: prediction history (question, side, category, status, delta)
- `results[]`: resolutions settled while away (question, cat, side, status win|loss|void, outcome, delta, shards)
- Derived: `agg` (net/won/lost/shards), `featuredOrder` (peak-end indices)

State transitions are driven by: gesture commit, nav taps, GM claim, reveal advance/skip/finish, invite copy.

---

## Data shapes (mock — replace with real market/resolution API)
```
Market   { cat, yes (0–100), hrs (to resolution), q, desc, vol }
Result   { q, cat, side 'YES'|'NO', status 'win'|'loss'|'void', outcome, delta (±$), shards }
History  { q, side, cat, status 'won'|'lost'|'pending', delta }
```
Payout (virtual): stake fixed at $100; `payout = round(100 / max(0.02, sideProbability))`.

## Motion language (timings & easings — all in the prototype's `@keyframes`)
- `hfPts` .65s — HUD points float on commit.
- `hfFlipIn` .5s `cubic-bezier(.3,1.1,.5,1)` — reveal card 3D flip.
- `hfCoin` 1–1.7s — win coin burst.
- `hfBigIn` .4s — staggered aggregate entrance.
- `hfBadgePop` .4s — bell unread badge.
- `hfBellSwing` 2.6s loop — bell while unread.
- `hfFlame` 1.6s loop — streak flame.
- `hfConfetti` ~1.3–2.5s — GM celebration.
- `hfRise` .28s — bottom-sheet entrance.
- `hfPulse` 2s — artifact / CTA attention pulse.
- Spring snap-back: `cubic-bezier(.34,1.4,.5,1)`; fling-off: `cubic-bezier(.45,0,.25,1)`.

## Copy constraints
English UI. Keep ALL copy **neutral about tokens/airdrops** — "collect points," "forge artifacts," promise nothing. No real-money or wallet-signature language anywhere — it's virtual, keep it game-like.

## Responsive / platform
Mobile-first portrait, primary target Android. Thumb-reachable, one-handed, gesture-first. On web the same layout centers in a phone-width column; gestures map to pointer drag, and the fallback ✕/↑/✓ buttons cover non-touch/accessibility. The device bezel in the mock is presentation chrome only — do not ship it.

## Assets
No raster assets. Category icons are inline SVG paths (see `cats` in the logic). Fonts load from Google Fonts (Anton, Space Mono, Hanken Grotesk) — swap for bundled fonts in production. Emoji (🔥 🛡 🪙 🎉 ☀ 🤝 🔔) are used as lightweight game iconography; replace with a consistent icon set if the brand requires.

## Files
- `Hedge Fun.dc.html` — the full interactive prototype: all 10 screens, swipe physics, reveal, bell/inbox, single Neon Arcade direction. **Primary reference.**
- `Hedge Fun - System & States.dc.html` — flat spec board: color/type/motion system + every swipe state (resting → mid-drag each direction → committed → bet-placed).

These are Design Components (a template + a `class Component extends DCLogic` logic class). Read them for exact values/structure; the logic class holds the physics math, state machine, and data. Treat the `React.createElement` reveal-card builder as a spec for the card layout, not as code to port.
