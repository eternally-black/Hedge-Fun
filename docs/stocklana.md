# Stocklana submission — tokenized stocks in HedgeFun

Hackathon: [Stocklana](https://hackathons.solana.com/hackathons/stocklana) (Solana Foundation, $100k pool,
deadline Fri 18 Sep 2026 16:00 ET). Wedge: **Consumer — mobile-first investing + Investing — index
baskets / robo portfolios**, on top of an app people already use for paper predictions.

## The one question judges ask

> Could this be a real app that people will actually use? A real user and problem, a working
> end-to-end demo, a reason it belongs on Solana, and quality of execution.

| Criterion | Our answer | Evidence |
|---|---|---|
| Real user + problem | Your life creates financial exposure you never hedge: flights, fuel, rent, a crypto bag. HedgeFun turns each one into a one-tap tokenized-stock position, with a swipe deck for discovery and live data spotting the risk. | `src/lib/hedge/stock-rules.ts` (13 life situations, EN/RU/UK), `src/lib/hedge/stock.ts` (rules → cards, spotted triggers) |
| Working end-to-end demo | Web app live at https://app.hedgeyour.fun — Stocks deck (swipe right = buy), Portfolio with live P&L, Hedge tab with life-cost chips and "Spotted today", profit alerts in the inbox. Paper (virtual $200) AND real. | `src/app/screens/StockDeck.tsx`, `PortfolioScreen.tsx`, `HedgeScreen.tsx`, `NotificationsScreen.tsx` |
| Why Solana | The instruments ARE Solana tokens (xStocks by Backed, Token-2022 mints), and Solana is the only chain where the onboarding disappears: an email login mints a Privy **embedded** Solana wallet (no Phantom, no extension, no seed phrase), and the app **sponsors the network fee** — the user's wallet signs, our fee-payer co-signs and sends, so all a user ever needs is USDC. The buy is still a real Jupiter swap USDC→xStock; the user's key never leaves their wallet and the lot is booked only from the landed transaction. | `src/app/providers.tsx` (embedded Solana wallet), `src/lib/sponsor.ts` + `src/app/api/stocks/real/submit/route.ts` (co-sign only a message we built), `src/lib/jupiter-swap.ts`, `src/lib/stocks-real.ts`, `src/app/useBuyReal.ts` |
| Quality of execution | Money paths are typed, idempotent and tested: paper buys hold cash atomically (same hold as every bet), real buys are matched against the server-built attempt (payer, mint, ExactIn amount, min out), the sponsor co-signs only a transaction whose message is byte-identical to the one it built (hash stored on the attempt), and at most `STOCK_SPONSOR_MAX_PER_USER_PER_DAY` sponsored transactions per user per day, lots the wallet no longer backs are closed, alerts fire once per tier. It is monitored like the rest of the product: one public probe that turns 503 on a stale deck OR a drained fee-payer, and a poller block that pages Telegram once an hour while the sponsor is low. 6 new unit suites + 4 DB suites in CI. | `scripts/test-stocks*.ts`, `scripts/test-stock-rules.ts`, `scripts/test-hedge-stock.ts`, `scripts/test-stock-alerts*.ts`; `src/app/api/stocks/health/route.ts`, `scripts/poller.ts` (`[stock-sponsor]`); `.github/workflows/deploy.yml` |

## On-chain proof (mainnet, 2026-09-15, fee-sponsored, Privy embedded wallet)

A real buy and a real sell of MUx (Micron xStock) from a freshly created Privy embedded Solana wallet
holding **only $2 USDC and no SOL** — the server fee-payer covered both transactions and fronted the
token-account rent, which came back on the sell:

| Step | Signature |
|---|---|
| Buy $2 USDC → 0.00213222 MUx | [4pNH9FKM…W2BvQX](https://solscan.io/tx/4pNH9FKM8Rsyive8NArkFKhPEbCBKTEQNo69ewVXpP7ZuJPAwWexzpKdsFGL5eqGh4buMNpgCQehMEP7Z3W2BvQX) |
| Sell 0.00213222 MUx → $1.998 USDC, token account closed | [3fUrmEb9…B4NpJ](https://solscan.io/tx/3fUrmEb9SWUBRDHHq6FFjhmAtSbb6yHFdk7PdwUb9KR5WEAh9uCLgEYLqYFxtaWGzUy2jH6Qb5zspzktZs7B4NpJ) |

Sponsor wallet before → after the round trip: 0.050000 → 0.049980 SOL (≈20,000 lamports for two
transactions; the ≈0.00157 SOL rent was fronted on the buy and refunded on the sell). The $10 chip was
sized down to the wallet's $2 USDC by the server, and the lot was booked only after the landed
transaction matched the attempt the server had built.

### Production, 2026-09-16 (app.hedgeyour.fun, same wallet, fee-sponsored)

| Step | Signature |
|---|---|
| Buy $1.99 USDC → QQQx | [53TPRiKE…npaV](https://solscan.io/tx/53TPRiKEmP2d8cPiz2hbV5ozLFB41yPj2JdHu8gnRk4YjVTKZY1Pzn6gpPjMBaHbLqLYcR59zAf1YGF8QxpcnpaV) |
| Sell QQQx → USDC (3-hop route via SOL and USDT; token account closed) | [4CQNUq68…CyPX](https://solscan.io/tx/4CQNUq68c4nyeqwHBfUzK3VpnX2s6FiabZXWSPCJNkh1ZR5nW8LyopEUBBFuU8rdkcvo1HdWobQrx4w14nuJCyPX) |
| Buy $1.99 USDC → NFLXx | [5fpeQm54…Mea4](https://solscan.io/tx/5fpeQm54Mp5ufzGap4c1ZXLtmAjxGidN5s9CGBv2vguJQsq6hpmPHz2L5Lrx6nSgoG7EgHKRTh84Ppw4xWnNMea4) |
| Sell NFLXx → USDC | [Maa7LVT6…D7Mb](https://solscan.io/tx/Maa7LVT6bibAVtTrK1mqyvKBdVsytfk5MJLa5EdYALnpxk9a4nWdA3jFLCCT2LRUaC5RSZa87ChPachXaqwD7Mb) |
| Buy $1.94 USDC → PLTRx (swipe right in Real mode, no separate button) | [5FBqh6Pi…AddRR](https://solscan.io/tx/5FBqh6Pi1fJarsJMw4TfyGGAPuGWtqZKfN1eHZMduk6qwrg9Vw6oGw5UzzkyEU8JboDsJko5CrybD4edSMfAddRR) |
| Sell PLTRx → USDC (two-tap Sell on the portfolio row) | [55E4zaFk…GKJC](https://solscan.io/tx/55E4zaFkxjea2DY7QfrYGXviVueAtrJc9NAizrC3EeNu3nRK6yVx6gdv4QG1VvXKAZAPGziwZGtyrjPiAAK5GKJC) |

The first production sell exposed a leak: Jupiter's cleanup instruction refunds the wrapped-SOL
account's rent to the user even when the sponsor funded it. Fixed the same hour (the refund now
follows whoever paid); the NFLXx round trip cost the sponsor exactly 20,045 lamports — two network
fees — with every rent it fronted returned. The PLTRx pair is the final flow: the same Paper/Real switch predictions use decides whose money a swipe spends; flipped to Paper, the same card and the same swipe held $10 of play money instead.

## What was built (4 days)

- **Catalog + prices.** xStocks public API (≈830 Solana assets) upserted every 5 min; Jupiter Price v3 every
  minute for the served subset. Deck pool = top 150 by DEX liquidity, then market cap; only mints with
  a Solana pool are `tradable` (real buy), the rest are paper-only at the issuer's reference price.
- **Stocks deck.** Right = buy, left = pass, up = skip. Whose money a buy spends is the app's ONE
  Paper/Real switch, the same one predictions use (You → Mode): in Real mode a swipe right buys on
  Solana from the user's own wallet, fees sponsored; in Paper it holds virtual cash. An asset with no
  Solana pool stays paper in either mode. Toggle back to the prediction-market deck any time.
- **Wallet + fees.** Email login mints a Privy embedded Solana wallet — no extension, no seed phrase;
  an external Phantom still works for anyone who has one. Real buys and sells are **fee-sponsored**:
  the server builds the swap, the user's wallet signs it, our fee-payer co-signs and sends it. The
  server re-derives the message before co-signing (it never signs bytes it did not build) and caps
  sponsored transactions per user per day. Funding a position needs USDC and nothing else.
- **Portfolio.** Paper and on-chain lots, live mark, two-tap sell — paper against the stored price,
  REAL as a sponsored xStock→USDC swap that closes the emptied token account in the same transaction,
  so its ≈0.0016 SOL rent returns to the sponsor. Solscan link, pending real buys, lots "moved in
  wallet" when the user sold them elsewhere behind our back.
- **Hedge.** "$800 on flights this month" → *Hedge your travel costs with DALx* (10% sizing). Wallet
  holds BTC → *hedge 10% with GLDx*. Energy stocks +5% → *Spotted today* card for drivers. Deterministic
  rules first; the LLM only extracts entities/amounts when the rules miss.
- **Profit alerts.** +2/+5/+10% tiers, once per lot, delivered through the existing results inbox and bell.
- **Eligibility.** One consent sheet (self-declaration + xStocks terms) gates the first real buy; the
  limitations text (thematic exposure ≠ hedge, XLEx is a basket, sizing is a product rule) lives there.
- **Monitoring.** A public probe, `/api/stocks/health`, answers the two questions that kill the
  surface silently: is the deck still priced, and can we still pay for trades. It is 503 below 20
  fresh deck assets or below 0.02 SOL in the fee-payer. The poller's `[stock-sponsor]` block reads
  the same balance every 5 minutes and pages Telegram once an hour while it is low.

## Verify it yourself

```bash
npm test                      # pure suites incl. test-stocks / test-stock-rules / test-stock-alerts
npm run test:db               # DB suites incl. paper buy/sell, real attempt→confirm→sweep, hedge stock cards, alerts
npm run refresh-stocks        # live: xStocks catalog + Jupiter prices → "8xx assets, 7xx priced, 150 deck-eligible"
curl -s https://app.hedgeyour.fun/api/stocks/health   # live monitoring probe, no auth
```

A healthy probe is HTTP 200 and says so in the body (503 with the same shape when it is not):

```json
{"ok":true,"assets":832,"deckFresh":50,"oldestFreshAgeSec":41,"stuckAttempts":0,"sponsorLamports":"1043210000","sponsorOk":true}
```

## Facts that shaped the design

- Jupiter's price API silently caps a request at 50 ids; ~60 of 830 xStocks have any Solana pool
  (the 20th deepest is ~$3k), the rest carry only the issuer's reference price.
- Token-2022 ScaledUiAmount: raw balances are never scaled; the multiplier is display-only.
- A Phantom-side sell leaves no server event — so REAL lots are reconciled against the wallet balance.
