# Hedge Fun

Swipe-prediction paper-trading app on real Polymarket markets. Web now (Next.js); Android (Expo) later reuses the same API.

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

## Where the open product rules land (change in one place)

| Open rule | File | Change |
|---|---|---|
| x2 trigger + cadence | `src/lib/multiplier.ts` → `ACTIVE_MULTIPLIER` | swap to a strategy |
| Login bonus size | `src/lib/config.ts` → `LOGIN_BONUS` | one constant |
| Referral params | `src/lib/referral.ts` → `ReferralRewardParams` | recompute over logged events (retroactive) |
| Leaderboard | ledger already ranks | add endpoint + UI |

## Layout

- `src/lib/` — domain engine (config, points, multiplier, swipe, login, streak, shards, referral, polymarket, privy)
- `src/app/api/` — `me`, `deck`, `swipe`, `login-mark` (the backend; Android reuses these)
- `src/app/` — single-screen UI + PrivyProvider
- `scripts/` — `poller` (F4 settlement), `settle`, `refresh-deck`, `smoke`, tests
- `prisma/schema.prisma` — full data model
