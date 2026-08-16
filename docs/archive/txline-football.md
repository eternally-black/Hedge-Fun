# TxLINE World Cup Integration

Live World Cup football on top of HedgeFun's crypto/Polymarket core, sourced from **TxOdds TxLINE**
(cryptographically-verifiable, Solana-anchored sports data): a global live ticker, a World Cup hub,
swipeable Over/Under markets, and **settlement on Solana-anchored scores**. Shipped 2026-06-29
(commits `0b02004` + `cf26b08`), live at https://app.hedgeyour.fun. Prod upgraded to **mainnet SL12
real-time** 2026-06-30.

This doc is the full record: overview → Solana angle → architecture → verified API facts → on-chain
bootstrap & cost → settlement → data model → verification → deploy/ops runbook → limitations.

---

## 1. What shipped

- **Бегущая строка / ticker** — global strip on every screen: live scores + the market's Over-2.5
  read, with a goal / odds-move flash. Polls every ~5s; honors `prefers-reduced-motion`.
- **World Cup hub** (⚽ Cup tab) — read-only scoreboard of live / upcoming / recent matches.
- **Football betting deck** — binary Over/Under total-goals markets (lines 1.5 / 2.5 / 3.5) per match,
  as `Market` rows (`source = TXODDS`). They flow through the **existing** swipe → settle → history →
  results pipeline and **mix into the main deck** (crypto backfills when football is thin).
- **Verifiable settlement** — a settled football result carries a **⛓ Solana-anchored** badge linking
  to the TxLINE on-chain program; the score it settled on is committed to a Solana Merkle root.

Identity is preserved: the crypto deck is still the default; football is an additive layer.

## 2. Why it's Solana-native (not just an API read)

TxLINE serves data off-chain (REST) but commits **daily Merkle roots of every score** to a Solana
program, and gates access by an on-chain `subscribe()` transaction — our operator wallet is a
registered subscriber on-chain.

- **Proof of Solana sign-up** — the one-time `subscribe()` tx (free World Cup tier, 0 TxL):
  - **mainnet** (live, SL12 real-time — on-chain decode confirms `serviceLevelId=12`):
    `https://solscan.io/tx/3oB8RMLEjDHBtvdwNhb9DjYBCVL1Xo4QUHw3DK1XLhMAr1YeRercCDrPKJWXQLNd9xzGsXRGUVMhFC48DegXohpL`
  - devnet (SL1): `https://solscan.io/tx/29wXqMk2B8x7qa6HYWD41Nm1tT65bMXxjM5wNuEpKxqtReKpTCCA4v2SZR1aTQmGevT8T3wxyoJaijzpQ4zeVo11?cluster=devnet`
- **Verifiable settlement** — football bets settle on scores anchored to the program's Merkle roots;
  the result badge links the on-chain anchor (`onchainAnchorRef()` → Solscan, per network).
- **Deferred deepening** — full client-side Merkle-membership verification via the
  `/api/scores/stat-validation` proof endpoint. The anchor + subscription are on-chain today; the
  badge links the anchor, it does not claim the proof was recomputed.

## 3. Commercial path → Seeker / Solana Mobile

HedgeFun is a real product with distribution. The roadmap ships a React Native app (API contract
pinned in `src/lib/api-types.ts`, see `docs/android-readiness.md`) targeting the **Solana Mobile /
Seeker dApp Store**: install from the dApp store → swipe live World Cup matches → on-chain-verified
results. A swipe prediction game with verifiable settlement is a natural Seeker funnel.

---

## 4. Architecture

Runtime is **pure REST** — the only Solana code is the one-time bootstrap, kept out of the app and
the poller (verified: `dist/poller.cjs` is ~30 kB with no Solana deps bundled).

```
TxLINE (REST)                      HedgeFun
─────────────                      ────────
/auth/guest/start  ──┐
/api/fixtures        │   src/lib/txodds.ts ──► getTickerSnapshot() (8s in-mem cache)
/api/odds            ├─►   (guest-JWT auto-refresh on 401 + X-Api-Token)        │
/api/scores          │                                                         ▼
                     │   GET /api/football/ticker ──► Ticker.tsx (marquee) + FootballScreen.tsx
                     │
                     └─► scripts/refresh-football.ts ──► Market rows (source=TXODDS)
                              (poller tick, 60s)            │  question "World Cup — A vs B: Over X goals?"
                                                            ▼
                                              /api/deck + /api/feed (existing) ──► main swipe deck
                                                            │  swipe → Bet (existing pipeline)
                                                            ▼
                         scripts/poller.ts settleOne(source=TXODDS)
                              └─► scripts/settle-football.ts resolveFootball()
                                     (fetch scores → Over wins iff goals>line)
                                     └─► settleMarket() + stamp verifiedOnChain/onchainRef
                                            └─► /api/results ResultRow.verified ──► ⛓ badge
```

### Files

| File | Role |
|------|------|
| `src/lib/txodds.ts` | TxLINE REST client: guest-JWT cache (refresh on 401) + `X-Api-Token`; `fetchFixtures/fetchOdds/fetchScores`; `fetchOuMarkets` (O/U → bp), `fetchMatchScore` (goals + phase); `getTickerSnapshot()` (module cache, in-flight coalescing, error-fallback to last rows); `onchainAnchorRef()`. **No Solana imports.** |
| `src/app/api/football/ticker/route.ts` | `GET` → `{ rows: TickerRow[] }` from the cache. Auth-guarded; degrades to `[]` if the token is unset. |
| `src/app/screens/Ticker.tsx` | Global marquee (`@keyframes hfTicker`), 5s poll, goal/odds-shift flash (refs for transient diff state), reduced-motion safe. |
| `src/app/screens/FootballScreen.tsx` | ⚽ Cup hub — vertical scoreboard from the same ticker endpoint. |
| `scripts/refresh-football.ts` | `refreshFootball()` — WC fixtures + O/U odds → upsert `Market` rows (`source=TXODDS`, synthetic id, prices in bp). Poller calls it each tick. |
| `scripts/settle-football.ts` | `parseTxMarketId`, `decideOuResolution` (pure), `resolveFootball` (fetch + decide). |
| `scripts/poller.ts` | `settleOne` branches on `market.source`: POLYMARKET → Gamma; TXODDS → `resolveFootball` + stamp `verifiedOnChain`/`onchainRef`. `tick()` also calls `refreshFootball()`. |
| `src/lib/api-types.ts` | `TickerRow`/`TickerResponse`; `ResultRow.verified?`/`onchainRef?` (optional = forward-compatible). |
| `src/lib/results.ts` | `toResultRow` maps `verifiedOnChain`/`onchainRef`. |
| `src/app/screens/NotificationsScreen.tsx`, `ui.ts`, `BottomNav.tsx`, `page.tsx`, `globals.css` | ⛓ badge, `Screen` union + `kickoffLabel`, ⚽ Cup tab, Ticker mount + FootballScreen render, marquee CSS. |
| `prisma/schema.prisma` + migration `20260629200350_txodds_football_markets` | `MarketSource` enum; `Market.source`/`verifiedOnChain`/`onchainRef` + index (additive). |

### Key design decisions

- **Reuse `Market`, no new table.** Football markets are `Market` rows with `source=TXODDS` and a
  synthetic `polymarketId = "txline:{fixtureId}:{kind}"` (kind = `OU15`/`OU25`/`OU35`). This avoids a
  nullable-column migration and lets the entire existing pipeline work unchanged. The `txline:` prefix
  cannot collide with Polymarket `0x…` conditionIds.
- **Category via question text.** Questions carry "World Cup", so the existing `categoryOf` →
  `sports` and `gameOf` → `Soccer` — zero category-enum churn. Football-only filtering uses `source`.
- **Ticker = in-memory cache (no DB).** Read-only display data; an 8s TTL + in-flight coalescing bound
  TxLINE to ~1 build/window regardless of traffic. The deck/settlement use `Market` rows + the poller.

---

## 5. TxLINE API — verified facts (devnet, 2026-06-29)

- **Auth = 2 headers** on every data call: `Authorization: Bearer <jwt>` + `X-Api-Token: <apiToken>`.
  The guest JWT (`POST {origin}/auth/guest/start`, empty body, 30-day) is free/unauthenticated and
  refreshable on 401; **a fresh JWT works with the existing apiToken** (the token is the subscription
  credential, not the session) — verified.
- **Hosts.** Devnet API `https://txline-dev.txodds.com`, mainnet `https://txline.txodds.com`. Solana
  RPC is the **public cluster** (`https://api.devnet.solana.com` / mainnet-beta), NOT the TxLINE host.
- **World Cup `CompetitionId = 72`** (filter on this, not a string match).
- **Fixtures** `GET /api/fixtures/snapshot` → `FixtureId(i64)`, `StartTime(ms)`, `Competition`,
  `CompetitionId`, `Participant1`(home)/`Participant2`(away).
- **Over/Under total goals** `GET /api/odds/snapshot/{fixtureId}` → payload where
  `SuperOddsType = "OVERUNDER_PARTICIPANT_GOALS"`, `MarketPeriod = null` (full match; `"half=1"` = 1st
  half), `MarketParameters = "line=2.5"`, `PriceNames = ["over","under"]`. Use **lines 1.5/2.5/3.5**
  (clean demarginalized `Pct`; quarter lines are `Pct:"NA"`). `Prices` = decimal odds ×1000; `Pct` =
  demarginalized % (3 dp) → bp via `round(pct*100)` (over → YES, under → NO). Also present:
  `1X2_PARTICIPANT_RESULT`, `ASIANHANDICAP_PARTICIPANT_GOALS`.
- **Scores** `GET /api/scores/snapshot/{fixtureId}` (JSON) → event log; each record has a numeric
  `Stats` map keyed `period*1000 + base`. **Total goals = `Stats["1"] + Stats["2"]`** (1 = P1 goals,
  2 = P2 goals; 3/4 = yellows, 5/6 = reds, 7/8 = corners). Game phase `F`(5) = ended.
  `/api/scores/updates/{id}` and `/stream` are **SSE** (`data: {...}`) — use `snapshot` for polling.
- **Supply is bursty** — only live / near-kickoff fixtures carry full O/U lines; many pre-match
  fixtures have 0–1. Hence the football deck **must** crypto-backfill (it does, automatically).

---

## 6. On-chain bootstrap + cost

A one-time, per-network operator step (kept **out** of the app). Source of truth for the IDL +
example: `github.com/txodds/tx-on-chain` (repo has `idl/txoracle.json` = mainnet IDL; the devnet IDL
is embedded in `documentation/programs/devnet.mdx`). Recon sandbox used:
`C:\Users\Valera\AppData\Local\Temp\txline-recon\` (`bootstrap.ts`, `probe.ts`, `pricing.ts`).

**Flow** (classic stack: `@coral-xyz/anchor` 0.31, `@solana/web3.js` 1.98, `@solana/spl-token`,
`tweetnacl`):

1. Create/load an operator Solana keypair; fund it with a little SOL.
2. **Create an empty TxL Token-2022 ATA** (required — `subscribe` throws `AccountNotInitialized`
   otherwise; the worldcup example omits it because their wallet already had one).
3. `program.methods.subscribe(serviceLevelId, weeks)` — accounts `user`, `pricingMatrix` (PDA seed
   `pricing_matrix`), `tokenMint`, `userTokenAccount`, `tokenTreasuryVault` (ATA of `token_treasury_v2`
   PDA), `tokenTreasuryPda`, `tokenProgram = TOKEN_2022`, `associatedTokenProgram`, `systemProgram`.
   Free WC tier = SL `1` (60s delay) or `12` (real-time, mainnet only).
4. `POST {origin}/auth/guest/start` → `jwt`.
5. **Sign** `nacl.sign.detached(utf8(`${txSig}:${leagues.join(",")}:${jwt}`), keypair.secretKey)` →
   base64. For the free tier `leagues = []`, so the message is `${txSig}::${jwt}`.
6. `POST {origin}/api/token/activate` `{ txSig, walletSignature, leagues: [] }` (Bearer jwt) →
   plain-text `apiToken` (e.g. `txoracle_api_…`).

**Measured cost (devnet, faithful for mainnet — same instruction):**

| Item | Cost | Note |
|------|------|------|
| TxL (free WC tier) | **0** | subscribe succeeded with an empty TxL ATA; `MIN_USER_BALANCE` is not enforced for free SL1 |
| TxL Token-2022 ATA rent | **0.00207908 SOL** | **refundable** on account close |
| `subscribe` tx fee | **0.000005 SOL** | the only truly burned cost |
| **Total** | **0.00208408 SOL** | ~99.8% refundable |

**Mainnet** `pricing_matrix` read confirms **rows 1 and 12 = price 0** (real-time SL12 is free); fund
the operator wallet ~0.01 SOL. Subscription term = multiples of 4 weeks — **re-subscribe to renew**.

---

## 7. Settlement reference

`decideOuResolution` (pure, unit-tested in `scripts/test-settle-football.ts`):

| Match state | Score | Result |
|-------------|-------|--------|
| Ended (phase `F`) or past settle-deadline **with** data | `total = Stats[1]+Stats[2]` | `resolved`, `resolvedYes = total > line` (Over wins iff goals exceed the line) |
| In play, before deadline | any | `open` (re-poll) |
| No score data (postponed/blank) | none | `open` (never settle a no-data match) |
| **Abandoned / postponed / suspended** | partial | `open` (never settle on a partial score — fixed after review) |

`resolutionDeadline = kickoff + 150 min` (90' + ET/stoppage cushion), doubling as the time-fallback
settle mark when the feed's phase lags. On settle, the poller stamps `verifiedOnChain = true` +
`onchainRef = onchainAnchorRef()` for the ⛓ badge.

---

## 8. Data model + migration

`MarketSource { POLYMARKET, TXODDS }`. `Market` adds `source` (default POLYMARKET), `verifiedOnChain`
(default false), `onchainRef` (nullable), and index `[source, status, resolutionDeadline]`. Migration
`20260629200350_txodds_football_markets` is **additive** (defaulted columns) → safe for prod
`migrate deploy`; existing rows backfill `source = POLYMARKET`. TXODDS rows reuse `polymarketId` as the
synthetic `txline:{fixtureId}:{kind}` key (no nullable change). `ResultRow.verified`/`onchainRef` are
optional contract fields (stale-client safe).

---

## 9. Verification

- `npm run verify:txline` — live canary: fixtures + WC filter, O/U extraction + bp ranges, score
  shape, settlement open-paths.
- `npm test` (DB-free) includes `test-settle-football` (Over/Under decision + id parser +
  postponed/abandoned guards).
- `npm run test:db` (DB-backed) — `test-api-contract` pins the `/results` row key-set (this caught the
  additive-field drift in CI; see §10).
- Build: `npm run build` (route in the manifest) + `npm run build:poller` (football code bundled, no
  Solana). All green before each push.

---

## 10. Deploy + operations runbook

**Env** (`.env` locally — loaded by Next AND the poller; and the VPS `/opt/hedgefun/.env`):

```
TXODDS_API_BASE=https://txline-dev.txodds.com   # mainnet: https://txline.txodds.com
TXODDS_API_TOKEN=<apiToken from the bootstrap>
TXODDS_WC_COMPETITION_ID=72
```

If `TXODDS_API_TOKEN` is unset, the ticker + football markets **degrade to empty (no error)**.
`.env.example` documents the template. Local devnet creds live in gitignored `.env`.

**Deploy pipeline** (unchanged): push `main` → GH Actions runs `test:db` + builds & pushes
`ghcr.io/eternally-black/hedge-fun` → VPS `deploy.sh` pulls + `migrate deploy` + `docker compose up -d`
(recreates `app` + `poller` with the new image + `.env`). Cold build ~9.5 min.

**Prod state verified 2026-06-29:** HEAD `cf26b08`; `app` + `poller` carry `TXODDS_API_TOKEN`; poller
logs `[football] refreshed 4 World Cup markets`; `GET /api/football/ticker` → 401 (live + guarded).

**CI note:** the first push failed `test:db` — `test-api-contract.ts` asserts the exact `/results` key
set, and the additive `verified`/`onchainRef` keys broke it. Fixed in `cf26b08` (expected key-set
updated; full `test:db` run locally before re-push). Lesson: run `npm run test:db` (not just `npm
test`) when changing a response contract.

### Runbook

- **Ticker empty in prod?** Check `docker compose exec app printenv TXODDS_API_TOKEN`. If missing, add
  `TXODDS_*` to `/opt/hedgefun/.env` and `docker compose up -d`. If present, the **devnet subscription
  likely expired** — re-run the bootstrap (ATA already exists → only ~0.000005 SOL) and update the token.
- **Go mainnet real-time (SL12):** re-run the bootstrap on mainnet (`serviceLevelId=12`, funded
  operator wallet ~0.01 SOL), then on the VPS set `TXODDS_API_BASE=https://txline.txodds.com` +
  the mainnet `TXODDS_API_TOKEN`, and `docker compose up -d`. Latency drops from ~60s to real-time.
- **Renew subscription:** every 4 weeks, re-run `subscribe()` + activate (re-subscribe; free WC tier
  has no cost beyond the tx fee).

---

## 11. Known limitations / deferred

- Prod runs **mainnet SL12 (real-time)** as of 2026-06-30. Devnet SL1 (60s-delayed) is the local-dev default.
- Devnet subscription is short-lived; re-bootstrap to refresh the token.
- Full client-side Merkle-membership verification (`/scores/stat-validation`) is deferred — the badge
  links the on-chain anchor, it does not recompute the proof.
- `GameState` "ended" string is matched defensively; the exact value should be confirmed on a real
  finished match (devnet replay reports `"scheduled"` even mid-match, hence the score/time fallbacks).
- Server-side SSE ingestion (vs the 5s/8s poll), 1X2 "team to win" (draw = PUSH), and BTTS are
  natural follow-ups (markets are goals-only today).
