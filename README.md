# Hedge Fun

Swipe app over real Polymarket markets and tokenized stocks (xStocks on Solana), in paper or real money. Web now (Next.js); Android (Expo) later reuses the same API.

Stack: Next.js (App Router) · Prisma · Postgres · Privy auth. Money in integer cents, points in a raw ledger, x2 multiplier applied at read time (one swappable strategy).

## Local dev (Windows + Postgres in Docker)

Postgres 16 runs in a Docker container (`docker-compose.dev.yml`), published on a stable
`127.0.0.1:5432`. Prereq: **Docker Desktop** (WSL2 backend) installed and running.

```bash
npm install
npm run db:up        # starts Postgres in Docker (waits until healthy)
npm run db:push      # create tables (first time)
npm run refresh-deck # load real <=24h Polymarket markets into the cache
npm run dev          # web at http://localhost:3000  (or: npm run dev:db = db:up + dev)
npm run poll         # settlement poller (separate terminal)
```

`npm run db:down` stops the container (data persists in the `pgdata` volume).

Fill `.env.local` with your Privy keys (`NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`) to enable login. `DATABASE_URL` + `POLYMARKET_API_BASE` live in `.env`.

## Check it works

```bash
npm test                  # pure-logic unit checks (points, streak/shards, P&L)
npm run verify:polymarket # hits live Polymarket, asserts field mapping
npm run smoke             # full daily loop end-to-end on live DB + live API
```

## Tokenized stocks (Stocklana)

The deck also deals **xStocks** (tokenized US equities on Solana): swipe right = buy, left = pass,
up = skip. The stake is a chip on the card — `$10 · $25 · $50` or a fourth `$…` chip that takes any
amount and remembers it.

**Whose money a swipe spends is the app's ONE Paper/Real switch (Profile → Mode), the same one
predictions use.** There is no separate "buy on Solana" button, no second deck and no per-card
toggle: the mode changes what the same card, the same swipe and the same Sell row do.

| | Paper money (default) | Real money |
|---|---|---|
| Card | chips read `PAPER`; every asset is dealt (one with no Solana pool is tagged `PAPER ONLY`) | chips read `REAL` under a gold `REAL` tag; only assets with a Solana pool are dealt — nothing on a real-mode card is paper |
| Swipe right | holds virtual cash, like a bet | a Jupiter USDC→xStock swap from the user's own wallet; the lot is booked only from the landed transaction, sized down to the wallet's USDC when the chip exceeds it |
| Portfolio Sell (two-tap) | closes the lot against the stored price | an xStock→USDC swap that also closes the emptied token account |
| Hedge tab stock cards | "Hedge $X with SYM" holds virtual cash | the same card buys on Solana; a life situation whose tickers have no pool yields no card |
| Balance chip in the HUD | `PAPER` pocket, everywhere | never Paper: `REAL · STOCKS` on stock screens, `REAL · PREDICTIONS` on prediction screens, the current deck's pocket elsewhere |

The wallet is the Privy **embedded** Solana wallet an email login already creates (a Phantom linked
on the Hedge tab or the Profile is read for exposure; trades always run from the embedded wallet), and every real
transaction is **fee-sponsored**: the server builds the swap, the
wallet signs it, our own fee-payer (`STOCK_SPONSOR_SECRET`) co-signs and sends it, and fronts the
token-account rent that comes back on the sell — so a user needs USDC and nothing else. The first real
buy is gated by one consent sheet (eligibility self-declaration + xStocks terms). The UI names money
by purpose (`$`, Paper, Real), never by token. The Hedge tab turns a life cost ("$800 on flights this
month") into a stock card, and profit alerts land in the inbox. Design, on-chain proofs and the
verify-it-yourself commands: [docs/stocklana.md](docs/stocklana.md).

## Where the open product rules land (change in one place)

| Open rule | File | Change |
|---|---|---|
| x2 trigger + cadence | `src/lib/points.ts` → `scorePoints` | applied at read time; change the rule here |
| Login bonus size | `src/lib/config.ts` → `LOGIN_BONUS` | one constant |
| Referral params | `src/lib/referral.ts` → `ReferralRewardParams` | recompute over logged events (retroactive) |
| Leaderboard | ledger already ranks | add endpoint + UI |

## Layout

- `src/lib/` — domain engine (config, points, swipe, login, streak, shards, referral, polymarket, privy)
- `src/app/api/` — `me`, `deck`, `swipe`, `login-mark` (the backend; Android reuses these)
- `src/app/` — single-screen UI + PrivyProvider
- `scripts/` — `poller` (F4 settlement), `settle`, `refresh-deck`, `smoke`, tests
- `prisma/schema.prisma` — full data model
