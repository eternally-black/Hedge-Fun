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
| Why Solana | The instruments ARE Solana tokens (xStocks by Backed, Token-2022 mints). A real buy is a Jupiter swap USDC→xStock signed by the user's own Phantom; the server never holds keys and books the lot only from the landed transaction. | `src/lib/jupiter-swap.ts`, `src/lib/stocks-real.ts` (attempt → confirm by reading the tx via Helius → poller sweep), `src/app/useBuyReal.ts` |
| Quality of execution | Money paths are typed, idempotent and tested: paper buys hold cash atomically (same hold as every bet), real buys are matched against the server-built attempt (payer, mint, ExactIn amount, min out), lots the wallet no longer backs are closed, alerts fire once per tier. 6 new unit suites + 4 DB suites in CI. | `scripts/test-stocks*.ts`, `scripts/test-stock-rules.ts`, `scripts/test-hedge-stock.ts`, `scripts/test-stock-alerts*.ts`; `.github/workflows/deploy.yml` |

## What was built (4 days)

- **Catalog + prices.** xStocks public API (≈830 Solana assets) upserted every 5 min; Jupiter Price v3 every
  minute for the served subset. Deck pool = top 150 by DEX liquidity, then market cap; only mints with
  a Solana pool are `tradable` (real buy), the rest are paper-only at the issuer's reference price.
- **Stocks deck.** Right = buy (paper: $10/$25/$50 chips; real: "Buy on Solana"), left = pass, up = skip.
  Toggle back to the prediction-market deck any time.
- **Portfolio.** Paper and on-chain lots, live mark, two-tap sell (paper), Solscan link (real), pending
  real buys, lots "moved in wallet" when Phantom sold them behind our back.
- **Hedge.** "$800 on flights this month" → *Hedge your travel costs with DALx* (10% sizing). Wallet
  holds BTC → *hedge 10% with GLDx*. Energy stocks +5% → *Spotted today* card for drivers. Deterministic
  rules first; the LLM only extracts entities/amounts when the rules miss.
- **Profit alerts.** +2/+5/+10% tiers, once per lot, delivered through the existing results inbox and bell.
- **Eligibility.** One consent sheet (self-declaration + xStocks terms) gates the first real buy; the
  limitations text (thematic exposure ≠ hedge, XLEx is a basket, sizing is a product rule) lives there.

## Verify it yourself

```bash
npm test                      # pure suites incl. test-stocks / test-stock-rules / test-stock-alerts
npm run test:db               # DB suites incl. paper buy/sell, real attempt→confirm→sweep, hedge stock cards, alerts
npm run refresh-stocks        # live: xStocks catalog + Jupiter prices → "8xx assets, 7xx priced, 150 deck-eligible"
```

## Facts that shaped the design

- Jupiter's price API silently caps a request at 50 ids; ~60 of 830 xStocks have any Solana pool
  (the 20th deepest is ~$3k), the rest carry only the issuer's reference price.
- Token-2022 ScaledUiAmount: raw balances are never scaled; the multiplier is display-only.
- A Phantom-side sell leaves no server event — so REAL lots are reconciled against the wallet balance.
