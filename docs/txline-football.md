# TxLINE World Cup — Brief Technical Doc

HedgeFun is a swipe-to-predict game. This integration adds **live World Cup football** on top of the
existing crypto/Polymarket core — a global live ticker, a World Cup hub, and swipeable Over/Under
markets that **settle from Solana-anchored data** — sourced from **TxOdds TxLINE**.

## What's live

- **Бегущая строка / ticker** — global strip (all screens) of live WC scores + the market's Over-2.5
  read, with a goal/odds-move flash. Updates every ~5s.
- **World Cup hub** (⚽ Cup tab) — read-only scoreboard of live/upcoming/recent matches.
- **Football betting deck** — binary Over/Under total-goals markets (lines 1.5 / 2.5 / 3.5) per match
  mix into the main swipe deck (`source = TXODDS`), flowing through the same swipe → settle → history
  pipeline as Polymarket. Crypto backfills the deck when football is thin.
- **Verifiable settlement** — a settled football result carries a **⛓ Solana-anchored** badge linking
  to the TxLINE on-chain program. The score the bet settled on is committed to a Solana Merkle root.

## Why it's Solana-native (not just an API read)

TxLINE is cryptographically-verifiable sports data: TxODDS publishes the actual data off-chain (REST)
and commits **daily Merkle roots of every score** to a Solana program. Access is gated by an on-chain
`subscribe()` transaction — our wallet is a registered subscriber on-chain.

- **Proof of Solana sign-up:** the one-time `subscribe()` tx (free World Cup tier, 0 TxL):
  `https://solscan.io/tx/29wXqMk2B8x7qa6HYWD41Nm1tT65bMXxjM5wNuEpKxqtReKpTCCA4v2SZR1aTQmGevT8T3wxyoJaijzpQ4zeVo11?cluster=devnet`
- **Verifiable settlement:** football bets settle on scores anchored to the program's Merkle roots;
  the result badge links the on-chain anchor. (Full client-side Merkle-membership verification via the
  `/scores/stat-validation` proof endpoint is the next deepening — the anchor + subscription are on-chain today.)

## Commercial path → Seeker / Solana Mobile

HedgeFun is a real product with distribution. The roadmap ships a React Native app (contract pinned in
`src/lib/api-types.ts`, see `docs/android-readiness.md`) targeting the **Solana Mobile / Seeker dApp
Store** — a swipe prediction game with on-chain-verifiable World Cup settlement is a natural Seeker
funnel: install from the dApp store → swipe live matches → on-chain-verified results.

## Architecture

Runtime is **pure REST** — the only Solana code is the one-time bootstrap (kept out of the app).

- `src/lib/txodds.ts` — TxLINE client: guest-JWT (auto-refresh on 401) + `X-Api-Token`, fixtures/odds/
  scores fetchers + mappers, the `getTickerSnapshot()` server-cache, O/U extraction, score reading.
- `GET /api/football/ticker` — server-cached ticker rows (TTL 8s; ~1 upstream build/window regardless of traffic).
- `scripts/refresh-football.ts` — generates/refreshes `Market` rows (TXODDS) from WC fixtures + O/U odds. Poller calls it each tick.
- `scripts/settle-football.ts` — `resolveFootball()` settles a TXODDS market from scores (Over wins iff
  total goals > line); the poller stamps `verifiedOnChain` + `onchainRef`. Pure decision unit-tested in `scripts/test-settle-football.ts`.
- `prisma/schema.prisma` — `Market.source` (`POLYMARKET | TXODDS`), `verifiedOnChain`, `onchainRef`.
  TXODDS markets reuse the `polymarketId` key as a synthetic `txline:{fixtureId}:{kind}` (no nullable migration).

## Setup

1. **One-time bootstrap** (operator, per network): subscribe to the free WC tier + activate the API
   token. Devnet (SL1, 60s-delayed) costs ~0.000005 SOL + ~0.0021 SOL refundable rent, **0 TxL**.
   Mainnet SL12 (real-time, also free, verified `pricing_matrix` row 12 = 0 TxL): same flow, fund the
   operator wallet ~0.01 SOL. (Bootstrap script + IDL live outside the app — see memory `hedgefun-txline-integration`.)
2. **Env** (`.env`, and the prod VPS `.env`): `TXODDS_API_BASE`, `TXODDS_API_TOKEN`, `TXODDS_WC_COMPETITION_ID`.
   Without `TXODDS_API_TOKEN` the ticker degrades to empty (no error).

## Verify

- `npm run verify:txline` — live canary: fixtures + WC filter, O/U extraction + bp ranges, score shape, settlement open-paths.
- `npm test` includes `test-settle-football` (Over/Under decision + market-id parser).
