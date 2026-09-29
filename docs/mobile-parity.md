# Web ↔ mobile parity — checklist (reference: the web app)

Audited 2026-09-29 against `src/app/page.tsx` + `src/app/screens/*` (web) and `mobile/src/*` (Expo,
Seeker flavor). Rule: the web is the reference; the phone differs only where the platform forces it.
Each phase ends with: mobile `tsc` green → x86_64 APK on the emulator → screenshot check → tick here.

## Phase 1 — money
- [x] 1.1 `WalletSheet` = web `BalanceSheet` wallet half (Paper / Real · Stocks / Real · Predictions, mode order)
- [x] 1.2 `RealDepositPanel` (balance, Deposit, Withdraw, "Make it spendable" WRAP)
- [x] 1.3 `DepositSheet` (network → address, minimum, warnings, funding declaration, arrival watch)
- [x] 1.4 `RealWithdrawCard` (bridge withdrawal, read-back confirmation, 700 ms dwell)
- [x] 1.5 HUD money chip = web (pocket by screen, `Paper ›` / `Real · Predictions ›` / `Real · Stocks ›`, gold/green), always opens the wallet sheet; unread = results + stock alerts
- [x] 1.6 Profile card no longer opens the browser (shared RealDepositPanel)
- [x] 1.7 `StakeSheet` — real stake presets + custom amount, opened from a STAKE chip on the card (real mode)
- [x] 1.8 Phase 1 verified on the emulator (wallet sheet, deposit list, stake sheet)

## Phase 2 — history and results
- [x] 2.1 One prediction row component = web `PredictionRow` (open + settled, side label, stake, P&L, Close with live exit quote)
- [x] 2.2 Wallet sheet History tabs Calls / Stocks / Hedges (= web BalanceSheet lower half, `Load more`, retry on failure)
- [x] 2.3 Results screen = web `NotificationsScreen`: settled feed + "In profit" stock-alert strip (`StockAlertRow`), acks both
- [x] 2.4 `RevealOverlay` on app open for unseen results (aggregate → featured → summary)
- [x] 2.5 Phase 2 verified on the emulator

## Phase 3 — account and progression
- [ ] 3.1 Profile = web order: header, tiles (Points, Virtual $, Streak, Shards), menu (History, Vault, Invite), real-money card, wallet, account (signed in as, logout, 𝕏 link/unlink), support contacts
- [ ] 3.2 Invite as its own screen from the menu (= web `InviteScreen`)
- [ ] 3.3 `VaultScreen` (shard ring, artifacts, card-skin shop)
- [ ] 3.4 HUD shard strip opens the Vault
- [ ] 3.5 GM screen = web `GmScreen` (week grid, streak window, recover)
- [ ] 3.6 Phase 3 verified on the emulator

## Phase 4 — deck extras and copy
- [ ] 4.1 `FeedScreen` post-cap feed (`MarketCard`) + Deck tab label "fresh deck in …" once the cap is spent
- [ ] 4.2 Login copy flavor-aware (Seeker ≠ "No wallet. No risk.") = web `Onboarding`
- [ ] 4.3 Boot screen: branded loading instead of a bare spinner
- [ ] 4.4 Phase 4 verified on the emulator

## Final
- [ ] F.1 Root + mobile `tsc`, `contract:check`, `npm test` green
- [ ] F.2 arm64 + x86_64 APKs rebuilt on the Desktop
- [ ] F.3 Every box above ticked

## Deliberate differences (keep)
- Play flavor: no real-money surface at all (`wallet.available === false`).
- Seeker stock pocket = the MWA-verified wallet (web: Privy embedded Solana wallet).
- Native sheets (`Modal`) instead of portals onto the phone mock.
