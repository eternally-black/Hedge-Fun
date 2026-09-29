# Web ↔ mobile parity (reference: the web app)

Audited 2026-09-29 against `src/app/page.tsx` + `src/app/screens/*` (web) and `mobile/src/*` (Expo,
Seeker flavor). Rule: the web is the reference; the phone differs only where the platform forces it
(no Play-flavor real money, native sheets instead of portals, MWA instead of Privy's Solana wallet).

## Gaps, by phase

### Phase 1 — money (blocks the first real order)
| Web | Mobile today | Action |
|---|---|---|
| `BalanceSheet` — ONE wallet sheet from the HUD balance chip: pockets Paper / Real · Stocks / Real · Predictions, ordered by mode | `TopupSheet` (paper top-up only); predictions money in a Profile card; "Add or withdraw funds" opened the browser | Port as `WalletSheet` (pockets part); HUD chip opens it in both modes |
| `RealDepositPanel` — pUSD balance, Deposit, Withdraw, "Make it spendable" (WRAP) on a DETECTED deposit | missing | Port verbatim (shared `runRealWorkflow`) |
| `DepositSheet` — pick network → address + minimum + warnings, declares the funding attempt, watches for arrival | missing | Port (native bottom sheet) |
| `RealWithdrawCard` — bridge withdrawal with destination checks | missing | Port (shared `withdrawViaBridge`) |
| `Hud` money chip — labelled by pocket (`Paper ›`, `Real · Predictions ›`, `Real · Stocks ›`), gold for real, green for paper; pocket follows the screen | `Real ›` / `Cash ›`, always green | Match labels, colours and pocket-by-screen |
| `StakeSheet` — real stake presets from the STAKE chip on the card | missing (stake editable only on web) | Port |

### Phase 2 — history and results
| Web | Mobile today | Action |
|---|---|---|
| `BalanceSheet` history tabs Calls / Stocks / Hedges with `PredictionRow` (live exit quote + Close) | `ResultsScreen` pending/settled list; Close added 2026-09-29 without exit quotes | Port the tabs into `WalletSheet`, reuse one row component |
| `NotificationsScreen` + `StockAlertRow` ("In profit" strip) | Results shows bets only | Add the stock-alert strip |
| `RevealOverlay` (app-open replay of resolved calls) | lands on Results instead | Port (animation-light first) |

### Phase 3 — account and progression
| Web | Mobile today | Action |
|---|---|---|
| Profile menu → History, Vault, Invite | Invite inline in Profile, no Vault, no History entry | Add menu rows; History opens `WalletSheet` |
| `VaultScreen` (artifacts, card skins shop) | missing | Port |
| Profile: 𝕏 link/unlink, Support contacts, dev tools | missing | Port link/unlink + Support |
| Profile tiles: Points, Virtual $, Streak, Shards | + Cash, + Artifacts tiles | Align to web |
| HUD shard strip opens Vault | display-only | Wire to Vault |

### Phase 4 — deck extras
| Web | Mobile today | Action |
|---|---|---|
| `FeedScreen` post-cap feed (`MarketCard`), nav tab turns into "fresh deck in …" | hard stop "Deck's done" | Port |
| `Onboarding` copy | `LoginScreen` copy is paper-only ("No wallet. No risk.") | Flavor-aware copy |

## Deliberate differences (keep)
- Play flavor: no real-money surface at all (`wallet.available === false`).
- Seeker stock pocket = the MWA-verified wallet (web: Privy embedded Solana wallet).
- Native sheets (`Modal`) instead of portals onto the phone mock.
