# Stocklana submission — tokenized stocks in HedgeFun

Hackathon: [Stocklana](https://hackathons.solana.com/hackathons/stocklana) (Solana Foundation, $100k pool,
deadline Fri 18 Sep 2026 16:00 ET). Wedge: **Consumer — mobile-first investing + Investing — index
baskets / robo portfolios**, on top of an app people already use for paper predictions.

Live: **https://app.hedgeyour.fun** (email login is enough; no wallet to install, no SOL to buy).
Companion packet: [SUBMISSION.md](SUBMISSION.md) — requirement → evidence, one command per claim.

## The one question judges ask

> Could this be a real app that people will actually use? A real user and problem, a working
> end-to-end demo, a reason it belongs on Solana, and quality of execution.

| Criterion | Our answer | Evidence |
|---|---|---|
| Real user + problem | Your life creates financial exposure you never hedge: flights, fuel, rent, a crypto bag. HedgeFun turns each one into a one-tap tokenized-stock position, with a swipe deck for discovery and live data spotting the risk. | `src/lib/hedge/stock-rules.ts` (13 life situations, EN/RU/UK), `src/lib/hedge/stock.ts` (rules → cards, spotted triggers) |
| Working end-to-end demo | Web app live at https://app.hedgeyour.fun — Stocks deck (swipe right = buy), Portfolio with live P&L and two-tap sell, Hedge tab with life-cost chips and "Spotted today", profit alerts in the inbox. Paper (virtual $200) AND real, behind ONE switch. Connect a Phantom that already holds xStocks and they appear as lots. | `src/app/screens/StockDeck.tsx`, `PortfolioScreen.tsx`, `HedgeScreen.tsx`, `NotificationsScreen.tsx`, `ProfileScreen.tsx` |
| Why Solana | The instruments ARE Solana tokens (xStocks by Backed, Token-2022 mints), and Solana is the only chain where the onboarding disappears: an email login mints a Privy **embedded** Solana wallet (no Phantom, no extension, no seed phrase), and the app **sponsors the network fee** — the user's wallet signs, our fee-payer co-signs and sends, so all a user ever needs is USDC. The buy is still a real Jupiter swap USDC→xStock; the user's key never leaves their wallet and the lot is booked only from the landed transaction. A user who already has Phantom keeps it: same swipe, same sponsor, their own rent. | `src/app/providers.tsx` (embedded Solana wallet), `src/lib/sponsor.ts` + `src/app/api/stocks/real/submit/route.ts` (co-sign only a message we built), `src/lib/jupiter-swap.ts`, `src/lib/stocks-real.ts`, `src/app/useBuyReal.ts` |
| Quality of execution | Money paths are typed, idempotent and tested: paper buys hold cash atomically (same hold as every bet); real buys are matched against the server-built attempt (payer, mint, ExactIn amount, min out); the sponsor co-signs only the message it built — or that message plus nothing but a wallet's Lighthouse guard instructions, which is what Phantom hands back — and never more than `STOCK_SPONSOR_MAX_PER_USER_PER_DAY` sent transactions per user per day; lots the wallet no longer backs are closed; alerts fire once per tier. Monitored like the rest of the product: one public probe that turns 503 on a stale deck OR a drained fee-payer, and a poller block that pages Telegram once an hour while the sponsor is low. 6 unit suites + 4 DB suites in CI, incl. a Phantom-style rewrite with shifted lookup-table indexes. | `scripts/test-stocks*.ts`, `scripts/test-stock-rules.ts`, `scripts/test-hedge-stock.ts`, `scripts/test-stock-alerts*.ts`; `src/app/api/stocks/health/route.ts`, `scripts/poller.ts` (`[stock-sponsor]`); `.github/workflows/deploy.yml` |

## On-chain proof (mainnet, fee-sponsored)

Every row is a real transaction on Solana mainnet, built by the server, signed by the user's wallet,
co-signed and sent by the fee-payer `71TSncjaoA9S7WCpANR5TqD8MeRMEexZEnKDTzD9r6oi`, and booked only
after the landed transaction matched the attempt the server had recorded.

### 1. First round trip (dev build, 2026-09-15) — a fresh embedded wallet with $2 USDC and no SOL

| Step | Signature |
|---|---|
| Buy $2 USDC → 0.00213222 MUx | [4pNH9FKM…W2BvQX](https://solscan.io/tx/4pNH9FKM8Rsyive8NArkFKhPEbCBKTEQNo69ewVXpP7ZuJPAwWexzpKdsFGL5eqGh4buMNpgCQehMEP7Z3W2BvQX) |
| Sell 0.00213222 MUx → $1.998 USDC, token account closed | [3fUrmEb9…B4NpJ](https://solscan.io/tx/3fUrmEb9SWUBRDHHq6FFjhmAtSbb6yHFdk7PdwUb9KR5WEAh9uCLgEYLqYFxtaWGzUy2jH6Qb5zspzktZs7B4NpJ) |

Sponsor before → after: 0.050000 → 0.049980 SOL. Two network fees; the ≈0.00157 SOL of token-account
rent was fronted on the buy and refunded on the sell. The $10 chip was sized down to the wallet's $2.

### 2. Production, embedded wallet (app.hedgeyour.fun, 2026-09-16 → 18)

| Step | Signature |
|---|---|
| Buy $1.99 → QQQx | [53TPRiKE…npaV](https://solscan.io/tx/53TPRiKEmP2d8cPiz2hbV5ozLFB41yPj2JdHu8gnRk4YjVTKZY1Pzn6gpPjMBaHbLqLYcR59zAf1YGF8QxpcnpaV) |
| Sell QQQx → USDC (3-hop route via SOL and USDT; token account closed) | [4CQNUq68…CyPX](https://solscan.io/tx/4CQNUq68c4nyeqwHBfUzK3VpnX2s6FiabZXWSPCJNkh1ZR5nW8LyopEUBBFuU8rdkcvo1HdWobQrx4w14nuJCyPX) |
| Buy $1.99 → NFLXx / Sell | [5fpeQm54…Mea4](https://solscan.io/tx/5fpeQm54Mp5ufzGap4c1ZXLtmAjxGidN5s9CGBv2vguJQsq6hpmPHz2L5Lrx6nSgoG7EgHKRTh84Ppw4xWnNMea4) / [Maa7LVT6…D7Mb](https://solscan.io/tx/Maa7LVT6bibAVtTrK1mqyvKBdVsytfk5MJLa5EdYALnpxk9a4nWdA3jFLCCT2LRUaC5RSZa87ChPachXaqwD7Mb) |
| Buy $1.94 → PLTRx with the ONE Paper/Real switch on Real (swipe right, no separate button) / two-tap Sell | [5FBqh6Pi…AddRR](https://solscan.io/tx/5FBqh6Pi1fJarsJMw4TfyGGAPuGWtqZKfN1eHZMduk6qwrg9Vw6oGw5UzzkyEU8JboDsJko5CrybD4edSMfAddRR) / [55E4zaFk…GKJC](https://solscan.io/tx/55E4zaFkxjea2DY7QfrYGXviVueAtrJc9NAizrC3EeNu3nRK6yVx6gdv4QG1VvXKAZAPGziwZGtyrjPiAAK5GKJC) |
| Buy $1 → HOODx / Sell (deck with the card leaving on the swipe and the footer narrating the buy) | [4mhAocc1…7htx](https://solscan.io/tx/4mhAocc1zWcc8yrGNxu3dQFdFtittRHdxshmQZq9osryqHmWt97fFzmWnnodWBWZTDQX3dKUZ9zd8Lc3pk9x7htx) / [5AqFTLkc…o9aT](https://solscan.io/tx/5AqFTLkcsfZobWPt2THbbyp8sCT1uqzWg6a8J7wcquU1wyvkuDUsyfsrXLK5RDfBi7AEi39tMfdpU2ZKsRpmo9aT) |
| Buy $1 → AAPLx / Sell | [4qGwCFsW…7TiT](https://solscan.io/tx/4qGwCFsW5q5tqHf2aPFEimrNDiFopF4ra2iSX5qyruMpuYbzeikvJr5f85iYXnGfm6srxyrUynkCY5v4UYBS7TiT) / [Gvb4z79B…dg4T](https://solscan.io/tx/Gvb4z79BaCNPFqbvfu4zPnBC6C3LfqJuY8pJxfDcqcJY6iLPozGLWAnhsZtXEHijwGVpfWoCsuDWNWhwBubdg4T) |
| Buy $1 → AMDx / Sell | [49Vay96h…3cUp](https://solscan.io/tx/49Vay96h9TLYUhrCrtuzSc69guE7a9qVF95Zoyc3239zkXCXXVWZrmuiNZkYPwjuEaFUmDLN71wWXbfTwmB53cUp) / [nM6AYtih…JKPg](https://solscan.io/tx/nM6AYtihmd8N1wuUtWs89YG5P5DVXmhNByTNCnDezWesa6sSpJXS6e1o8XCJkDzwUUjyayQyBjBrBHCnu2zJKPg) |

The first production sell exposed a leak: Jupiter's cleanup instruction refunds the wrapped-SOL
account's rent to the user even when the sponsor funded it. Fixed the same hour (the refund follows
whoever paid); the NFLXx round trip cost the sponsor exactly 20,045 lamports — two network fees —
with every rent it fronted returned. Flipped to Paper, the same card and the same swipe hold $10 of
play money instead.

### 3. Production, a connected Phantom (2026-09-18)

The wallet had held NVDAx and AAPLx for months, bought elsewhere. Connecting it imported both as lots;
selling them, then buying and selling TSMx, all went through the same sponsored path — Phantom's own
transaction rewrite and its scanner included (see *What the external-wallet path taught us*).

| Step | Signature |
|---|---|
| Sell NVDAx, imported from Phantom | [4SpmCLBJ…KuP3](https://solscan.io/tx/4SpmCLBJ1AGiU6ziqF5fw3EaMJC1zM43WicUg1vm3EYywsobfTVSdswjJWggRZnWG7nyEUxvDv8z1sHwZogrKuP3) |
| Sell AAPLx, imported from Phantom | [3ziD9awA…MA5W](https://solscan.io/tx/3ziD9awAHFrzgkCf8g2i8ZZLaDKSJwPmqNV2QEeYMhJrGp1tXKGeLqZpjjJxB86eystfKYdLNWVLCdT2mqg5MA5W) |
| Buy $1.11 → TSMx (fee sponsored, rent the wallet's own, Lighthouse guards accepted) | [nsLUDZeS…Apit](https://solscan.io/tx/nsLUDZeSDUADmtywFQh4vCV6aYPqxNKitX8jP4ZxJ1waCqXXZhsRoJVjTSx1PMh5UwKaDCw9NPcvzrmZ9NfApit) |
| Sell TSMx → USDC | [3wFWumhv…HXoh](https://solscan.io/tx/3wFWumhvxyXnRtUykQXMZBJz7U6h6sNuEd7tTtzTxgBESsKRLAsKm4iykpahkpkuugYV1URsuQvzUvKevaxBHXoh) |

Sponsor cost per Phantom transaction: ≈11,000 lamports (one network fee, no rent — the wallet fronts
its own). Per embedded round trip: ≈20,000 lamports, rent out and back.

## What was built (5 days)

- **Catalog + prices.** xStocks public API (≈930 Solana assets) upserted every 5 min; Jupiter Price v3
  every minute for the served subset; a one-line LLM blurb per asset. Deck pool = top 150 by DEX
  liquidity, then market cap; only mints with a Solana pool are `tradable` (44 today), the rest are
  paper-only at the issuer's reference price.
- **Stocks deck.** Right = buy, left = pass, up = skip; the stake is a chip (`$10 · $25 · $50` or any
  amount, remembered). Whose money a swipe spends is the app's ONE Paper/Real switch, the same one
  predictions use (Profile → Mode). In Real only assets with a Solana pool are dealt — nothing on a
  real-mode card is paper; the card leaves on the swipe and the footer narrates the buy (price → sign
  → send → confirm); a wallet below the $1 minimum switches the deck off with *Add money / Sell a
  stock*. In Paper every asset is dealt and a swipe holds virtual cash. Toggle back to the
  prediction-market deck any time.
- **Wallets.** Email login mints a Privy embedded Solana wallet — no extension, no seed phrase, no SOL.
  A Phantom connected on the Hedge tab or the Profile is verified through Privy; Profile → Wallet shows
  every verified wallet and picks which one trades (the embedded one by default). xStocks already
  sitting in a connected wallet are imported as lots ("imported at" the price of the day they were
  first seen) and sold, alerted on and reconciled like any other.
- **Fee sponsorship.** Real buys and sells are sponsored: the server builds the swap (direct route
  first), the user's wallet signs, our fee-payer co-signs and sends. The server never signs bytes it
  did not build — it re-derives the message, or verifies a wallet's rewrite is ours plus nothing but
  Lighthouse guards — and caps sent transactions per user per day. The embedded wallet's token-account
  rent is fronted and reclaimed; a connected wallet fronts its own.
- **Portfolio.** Paper and on-chain lots, live mark, two-tap sell — paper against the stored price,
  REAL as a sponsored xStock→USDC swap that closes the emptied token account in the same transaction.
  Solscan link per lot, pending buys shown confirming, lots "moved in wallet" when sold elsewhere.
- **Hedge.** "$800 on flights this month" → *Hedge your travel costs with DALx* (10% sizing). Wallet
  holds BTC → *hedge 10% with GLDx*. Energy stocks +5% → *Spotted today* card for drivers. Deterministic
  rules first; the LLM only extracts entities/amounts when the rules miss. In Real, a rule is offered
  only for a ticker with a Solana pool.
- **Profit alerts.** +2/+5/+10% tiers, once per lot, delivered through the existing results inbox and bell.
- **Eligibility.** One consent sheet (self-declaration + xStocks terms) gates the first real buy; the
  limitations text (thematic exposure ≠ hedge, XLEx is a basket, sizing is a product rule) lives there.
- **Money named by purpose.** The HUD chip states the pocket the screen spends — Paper, Real · Stocks,
  Real · Predictions — and the wallet sheet draws the three pockets in one layout. No token names.
- **Monitoring.** A public probe, `/api/stocks/health`, answers the two questions that kill the
  surface silently: is the deck still priced, and can we still pay for trades. It is 503 below 20
  fresh deck assets or below 0.02 SOL in the fee-payer. The poller's `[stock-sponsor]` block reads
  the same balance every 5 minutes and pages Telegram once an hour while it is low.

## What the external-wallet path taught us

Sponsoring fees for a wallet the app did not create is where "sign-then-co-sign" meets a wallet's own
safety layer. Each of these was found on mainnet with real money and is covered by a test:

1. **Phantom rewrites an unsigned transaction on sign.** It appends Lighthouse guard instructions
   (assertions that fail the transaction if the outcome is not what the simulation showed), re-sorts
   the account table and raises the compute-unit limit. A byte-exact check refuses every Phantom
   signature. `sameMessageModuloGuards` in `src/lib/sponsor.ts` decompiles both messages against the
   same lookup tables and accepts only our instructions, in order, with program, accounts, roles and
   data equal (the unit limit may only be raised, within a bound) plus Lighthouse instructions and
   nothing else.
2. **Pre-signing does not help.** A transaction that already carries the sponsor's signature cannot
   be rewritten — and Phantom blocks it outright as "could be malicious".
3. **Rent to a stranger is blocked.** Phantom's scanner refuses a transaction that closes the user's
   account with the lamports going to anyone else. So a connected wallet fronts its own rent (it has
   SOL; only the embedded wallet does not), and routes are quoted direct first so no wrapped-SOL
   account is opened and closed inside the swap.
4. **Buys need the built bytes stored too.** The guard check compares against what the server built;
   sells had stored it from day one for retries, buys had not — every Phantom buy was refused until they did.

## Verify it yourself

```bash
npm test                      # pure suites incl. test-stocks (guard-tolerant co-sign cases) / test-stock-rules / test-stock-alerts
npm run test:db               # DB suites incl. paper buy/sell, real attempt→submit→confirm→sweep, wallet import, hedge stock cards, alerts
npm run refresh-stocks        # live: xStocks catalog + Jupiter prices → "9xx assets, 7xx priced, 150 deck-eligible"
curl -s https://app.hedgeyour.fun/api/stocks/health   # live monitoring probe, no auth
```

A healthy probe is HTTP 200 and says so in the body (503 with the same shape when it is not):

```json
{"ok":true,"assets":927,"deckFresh":150,"oldestFreshAgeSec":50,"stuckAttempts":0,"sponsorLamports":"45049783","sponsorOk":true}
```

## Known limits

- The Privy app is in Development mode (150 users) until the client upgrades it.
- The fee-payer holds ≈0.045 SOL — roughly 4,000 sponsored transactions; the probe and the poller
  page before it runs dry. Topping it up is a transfer to `71TSncjaoA9S7WCpANR5TqD8MeRMEexZEnKDTzD9r6oi`.
- A life situation whose tickers have no Solana pool (flights, rides, rent, power bill today) yields no
  card in Real mode; it does in Paper.
- An imported lot's cost basis is unknowable here — it is entered at the price it was first seen, and
  its row says "imported at", never "entry".
- Web only; the Android app (Expo) reuses the same API and is not part of this submission.

## Facts that shaped the design

- Jupiter's price API silently caps a request at 50 ids; ~44 of 930 xStocks have any Solana pool
  (the 20th deepest is ~$3k), the rest carry only the issuer's reference price.
- Token-2022 ScaledUiAmount: raw balances are never scaled; the multiplier is display-only.
- A Phantom-side sell leaves no server event — so REAL lots are reconciled against the wallet balance,
  and adopted lots (imported) are closed before booked ones when the balance falls short.
- Helius retired its v0 balances endpoint mid-build; balances are read over plain JSON-RPC.
- A sponsor's daily cap must count what was sent or is still live — a dozen expired, never-signed
  builds locked a user out of a sale after 7 real trades.
