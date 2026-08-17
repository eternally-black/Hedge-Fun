# Real-money build plan — v2 (post-advisor synthesis)

2026-08-13, branch `phase2`. v1 was reviewed by three independent advisors — Sol 5.6 (repo-grounded),
Kimi K3 (repo-grounded), DeepSeek v4 (max reasoning, files-grounded); full texts in
`.scratch/{sol,k3,deepseek}-real-money-review.md`. This v2 incorporates their convergent findings
and resolves their conflicts (appendix). Executor: DeepSeek v4-flash in small verified chunks,
orchestrated by Fable. Source spec: `real-money-handoff.md` + phase2 spec §6.

## 0. Ground truth

The full chain is proven against production: deposit-wallet deploy → Solana funding → wrap →
approvals → signed POLY_1271 order → **matched fill with builder attribution confirmed by control
test** (2026-08-13). The handoff's "attribution still unproven" line predates that run and is stale.
Platform taker fee `rate × (p(1−p))^exp` (0.07/1 measured) is real, absent from naive estimates,
and peaks at hedge odds (3.5% at p=0.5).

## 1. Gate 0 — expanded spike (blocks the order path only)

v1 scoped this as "does `createSecureClient` work creds-only". All three advisors said that is
necessary but not sufficient. The spike must prove, in a **browser**, with a **real Privy embedded
wallet** (not a raw-key throwaway — K3's top risk):

1. `createSecureClient` initializes with user CLOB creds only, **no builder API key**.
2. A hand-rolled `Signer` adapter over Privy's browser SDK (`getAddress` / `signTypedData` /
   `signMessage` / `sendTransaction`) produces a POLY_1271/ERC-7739 order the CLOB **accepts**;
   cancel it before match — costs nothing. **WRITTEN (S9): `src/lib/real-signer.ts`** — the spike is
   now "open `/real` and press the buttons", not "write an adapter first".
3. **CORS from our origin** for cred derivation, books, and `postOrder`. This decides the posting
   locus: if the browser can post directly, it should (Sol: server posting shows the CLOB *our* IP
   and defeats Polymarket's own geo enforcement — the "real barrier" of §6.3). If CORS blocks it,
   the server posts and the IP-enforcement question escalates to `builder@polymarket.com`.
   **S9 finding: the SDK ships the missing half of the browser arm** —
   `remoteBuilderSigning({url})` has the browser client fetch builder HMAC headers from our own
   `/api/builder/sign` per request, so the browser gets builder attribution AND gasless without the
   secret entering the bundle. What browser-posting still costs is the booking story: our server
   would only learn an orderId, so it must book from `src/lib/reconcile.ts` (exchange trade records)
   rather than from a client receipt — client receipts stay REFUSED either way.
4. User CLOB creds **cannot** place an order without the signer (prove, don't assume); measure what
   cancel access allows (blast radius for custody decision).
5. Exact FAK response semantics: payload shape, order id, fill ids, what a partial and a zero fill
   look like. Whether reposting an identical `SignedOrder` is exchange-idempotent.
6. `maxPrice` semantics: per-share ceiling vs aggregate cap (if per-share, the bound must come from
   the **marginal ask**, not VWAP — Sol); whether the platform fee applies per level or on VWAP.
   `maxSpend` resize behavior.
7. ~~Gasless-generator determinism~~ **ANSWERED STATICALLY (S4 review round): the generator is
   non-deterministic by construction** (fresh nonce + deadline=now+600s per build, verified in
   0.6.0 source) — §2.4 was amended to the live-session engine. Gate-0 instead exercises the
   LIVE relay end to end: start → device signs → advance → relayer accepts; plus a
   lost-session restart mid-flow.
8. Do resolved positions in a Deposit Wallet **auto-redeem**? (Funds-recovery question — Sol.)
9. ~~**Withdrawal mechanics** — proven nowhere; the bridge endpoint we use is deposit-only.~~
   **ANSWERED (2026-08-15): the bridge does withdrawals too**, documented at
   `docs.polymarket.com/trading/bridge/withdraw` and implemented as `BRIDGE_OUT`:
   `GET /supported-assets` → `POST /withdraw {address,toChainId,toTokenAddress,recipientAddr}` with
   `X-Builder-Code` → send pUSD to the returned **evm** address (even for Solana — the deposit
   wallet lives on Polygon) → poll `GET /status/{address}`. No Polymarket fee; per-asset minimums
   (Solana USDC: $2, chain id is the STRING `1151111081099710`). Gate-0 now only has to run it once
   with real money, not discover whether a path exists.

Path B (if 1 or 2 fails): server builds orders, device signs — requires reaching past the public
API. Escalate to Polymarket; funding/wrap work (§3 steps 1–4) is unaffected and proceeds.

## 2. Architecture v2

One new dependency: `@polymarket/client` (+ `@polymarket/bindings`). ~~Only the server ever sees
builder creds.~~ **CORRECTED (S9 review):** the browser client authenticates as our builder through
`/api/builder/sign`, and the SDK's contract requires that response to carry the builder API KEY and
PASSPHRASE — they travel as request headers. Only the HMAC **secret** never leaves the server. Two
related precisions the reviewers insisted on: "non-custodial" means **no on-chain signing keys** on
the server, not "no keys" — the user's L2 CLOB creds are deliberately server-held and encrypted
(owner decision Q4), and a server breach yields cancel + read, not custody.

### 2.1 Two-phase order protocol (replaces v1's "validate and post")

All three advisors rejected trusting a client-supplied envelope. The signed order is the only
authoritative object, and every parameter in it must be server-derived **first**:

1. `POST /api/real/intent` — server checks flag + consent + geo verdict + market open/deadline +
   per-user caps, derives exact order params from a **fresh fee-inclusive quote** (token id for the
   side, all-in cap, share amount, marginal-ask `maxPrice` tick-rounded up for BUY / down for SELL,
   `minOrderSize` satisfied, builderCode, FAK), persists an `OrderAttempt` row (single in-flight
   per user+market enforced by unique constraint), returns params + `intentId`.
2. Client signs **exactly those params** with Privy (silent EIP-712).
3. Submit: client sends the signed order **verbatim** (never reserialized — BigInt/salt wire-format
   trap) plus `intentId`. Server validates signed fields **against the stored intent**: maker =
   user's deposit wallet, signer = verified embedded EVM wallet, `signatureType == 3`, tokenId,
   side, amounts, price bound, builderCode = ours, freshness window; verifies the signature
   locally; atomically claims the intent `SUBMITTING`.
4. Posting per locus (`REAL_ORDER_LOCUS`). Server arm: the server posts and its response is the
   authoritative receipt. Browser arm (**decided 2026-08-17, and the only working one from VPS1**:
   the CLOB answers our host "Trading restricted in your region" — Contabo, France — and that check
   is about the TRADER, so a server post put our datacentre in front of a decision about the user):
   `/api/real/submit` stops right after the CAS claim and returns `{ status: "approved" }`, the
   browser posts with its own SecureClient, and it reports **only the order id** to
   `POST /api/real/posted`. A client RECEIPT is refused in both arms — `/api/real/posted` re-reads
   the order server-side (`fetchOrder`; reads are not geoblocked), proves it against the persisted
   signed order (`matchesExchangeOrder`: token, side, maker = deposit wallet, size to one
   micro-share, created-after-intent) and books through the ordinary reconcile path, so every
   number on the ledger still comes from the exchange's own trade records.
   Either way the full response is persisted on the attempt; order hash and external order id are
   unique columns (replay-proof).
   4a. **Orphan discovery** (`discoverOrphanAttempts`, run by the reconcile route on the poller's
   cadence) closes the browser arm's residual risk: a browser that posts and dies before reporting
   leaves a live order on a SUBMITTING row with no `externalOrderId`, which every reconcile scan
   filters out and which the one-in-flight partial index turns into a permanently wedged market.
   The sweep asks the exchange (open orders, then the taker-order ids of the account's trades on
   that token), adopts the order if the identity check passes, and only kills the attempt when
   every read succeeded and nothing matched — an incomplete read is "unknown", never a kill.
5. Zero fill → attempt `KILLED`, **no position row** — the market slot frees for a retry.
   Fill(s) → `Fill` rows and a real `Bet` position row created/updated from **actual** fills.
   A receipt reports the ORDER's **cumulative** matched totals, so booking subtracts what the
   attempt already holds and writes the delta; the row is keyed by the WHOLE trade set (a
   `tradeIds[0]` key either double-books the overlap or drops the new trades). FILLED-vs-PARTIAL
   and the position vwap are derived from cumulative aggregates, never from one batch. Q1
   participation (swipe counter + point) fires once per POSITION — and never via a caught P2002:
   a swallowed unique violation inside a Postgres transaction turns the COMMIT into a silent
   ROLLBACK, which discarded a whole booking while reporting FILLED (found 2026-08-14).
6. Poller reconciles any attempt stuck in `SUBMITTING` (crash between post and record — Sol's
   "distributed-state divergence", the plan's biggest named risk). **Implemented as
   `src/lib/reconcile.ts` + `POST /api/real/reconcile`:** the poller stays SDK-free and pings the
   route (shared secret, machine-to-machine); the route probes `fetchOrder` + `listAccountTrades`
   and hands an SDK-free verdict to the module. A verdict resolves the attempt: terminal with zero
   matched → KILLED (slot frees); matched → the trades are booked as an order-cumulative fill, so
   the delta lands and the fee ESTIMATE is replaced by the CHARGED total (`trueUpAttemptFee`,
   per-trade fee at each trade's own price and rate — the fee is convex in price). Unreachable or
   unpriced → no writes, the next pass retries. Only POSTED attempts carrying an exchange order id
   are reconcilable; a SUBMITTING one has no id to ask about and stays with the ops watcher.

**WITHDRAW truncation:** the collateral-return service truncates a plan it cannot fit in one
router call. The run then drains only part of the balance and still converges (convergence only
asks whether pUSD went down), and the next POST re-binds while pUSD > 0 — so the remainder does
drain, but silently. A truncated plan now warns and pages ops with the operation count and
`netPusdOut`. WHERE the funds land is still the owner's Gate-0 question (Q2).

**REDEEM binding (pre-Gate-0 items 5+6, `src/lib/redeem.ts` — pure, so it is testable at all):**
the candidate window is classified before anything binds. A LOST position redeems to zero
collateral, so it is booked and consumed with NO run — a relay run would spend a device prompt and
a relayer submission to move no money, on a convergence arm that cannot tell did-it-run from
didn't. A NEG-RISK position is never bound: redemption routes through the NegRisk Adapter, which
the explicit alpha approval set deliberately does not grant (it covers the two exchanges only —
widening it is an owner decision), so the workflow surfaces it to ops (`neg_risk_redeem_manual`)
instead of asking for a signature that cannot land. Entries on neg-risk markets are already
fail-closed, so such a position can only arise from a stale flag.

The server is a policy gate, not a barrier (K3): a determined user holding their own creds can
bypass us and post directly — server validation protects the integrity of *our* records and fees,
not the exchange. That posture is accepted in spec §6.3.

### 2.2 Data model (append-only ledger under a product aggregate)

- `OrderAttempt`: user, market, dir (ENTRY/EXIT), idempotency key ⊎, approved-params snapshot,
  signed-order hash ⊎, external order id ⊎, state machine
  (`ISSUED → SIGNED → SUBMITTING → POSTED → FILLED | PARTIAL | KILLED | FAILED`), error, raw
  post response. (⊎ = unique)
- `Fill`: external fill id ⊎, attempt, shares, spend/proceeds, fee, price, ts — **exchange atomic
  units (6-decimal micro-USD / share decimals), not cents** (Sol: aggregate cents discards fill
  precision).
- `Bet` stays the product aggregate: add `mode` (`PAPER`|`REAL`), real aggregates (filledShares,
  spendMicro, feeMicro, vwapBp, closedShares, realizedPnlMicro), and widen the unique key to
  `(userId, marketId, mode)` so a paper bet never blocks a real position. The real Bet row is
  created **on first fill**, not at swipe.
- `WalletWorkflow` (§2.4), `FundingAttempt` (§2.5), `RelayerTx`
  (`@@unique([userId, kind, workflowKey])`, status included — counters must distinguish onboarding
  spend from retry spend, K3 R7).
- `User`: `depositWalletAddress` ⊎, funding state, real-mode consent timestamp.
- `ClobCredential` (if server custody — owner decision Q4): dedicated table, authenticated
  ciphertext + nonce + key version + revocation state; key outside DB backups; log redaction.

**Paper-economy isolation sweep (K3 + Sol, must land before any real row exists):** `mode` filters
in `scripts/settle.ts` (today it would paper-settle a real bet with virtual dollars), the virtual
cash hold in `src/lib/swipe.ts:118–123` (real mode **never touches `VirtualBalance`**), and
**mobile-facing responses filter `mode=REAL` out entirely** until the RN client supports it
(K3 R4). Real positions settle from chain/fills; the app's settle path for them is reconciliation
only. Per owner decision Q1 (2026-08-13), real swipes **fully participate** in the paper game
economy: they consume the DECK cap and earn points like paper swipes. Derived rule (owner may
override): cap consumption and points are booked **at fill time**, not at intent — a zero-fill
FAK costs the user nothing and frees the slot. Real P&L stays out of virtual-cents leaderboard
aggregation; points participation is the link between the economies. The deck/feed anti-join
stays **mode-agnostic on purpose** (step-1 review ruling): a card is swiped once per user ever —
a REAL position consumes it exactly like a paper bet; the mode split on the unique exists for the
hedge path, not to re-deal swiped cards.

### 2.3 Wallet identity + provisioning

- `extractIdentity` can currently capture an **external Solana wallet** as `embeddedWalletAddress`
  (Sol) — before anything else: verify chain + embedded status when extracting, normalize, and
  build the backfill/refresh path (precedent: `/api/link/sync`). Step-1 acceptance includes it.
- The deposit wallet address is deterministic from the signer: derive locally, read its on-chain
  deployment state, upsert on the unique column — double-click and crash collapse into the same
  write, and no relayer tx is spent re-deploying an existing wallet (K3).
- Intent-first everywhere: the durable operation row is written **before** the external call, the
  result reconciled after; never an external call inside `runSerializable`.

### 2.4 Signature relay (wrap, approvals) — live-session engine (AMENDED, S4 review round)

The original rebuild-and-replay design is impossible against the real SDK: the generator refetches
the wallet nonce and stamps `deadline = now+600s` on every build (verified in 0.6.0 source), so
regenerated yields can never byte-match. Shipped design (`bb3ba15`):

- The generator lives **in memory** for the seconds-long signature roundtrip (single app
  container), keyed by a per-RUN id with a hard envelope-age TTL. The `WalletWorkflow` row is the
  single-flight slot per (user, kind), the SUBMIT fence, and the audit transcript.
- Lost session before the fence (restart/TTL) → the run restarts cleanly with a fresh envelope —
  one extra device prompt, never a stale signature. All transitions are CAS on (state, runId).
- Answers bind by runId + request digest; signature SHAPE is validated pre-fence. Recovered-signer
  validation is **deliberately deferred to the Gate-0 bundle** (needs keccak/secp; the relayer's
  own ERC-7739 validation is the enforcement meanwhile).
- Ambiguity rule (unchanged): after the fence, converge from **chain state** only (on-chain
  allowance floors + isApprovedForAll for approvals; the run's attempt-bound finalized pUSD delta
  for wrap), never resubmit blindly; expired SUBMITTING + verifiably-nothing-happened releases
  the slot. Approvals use OUR explicit 4-call set, not the SDK's generic MAX-to-everything setup.
- **Run-scoped convergence (K3 S6/S7 M1).** Wallet-wide pUSD deltas are shared state: a concurrent
  fill, wrap or withdrawal can satisfy a `verify` (false DONE) or mask one (false "nothing
  happened" → a second submission of an op that already landed) — the same defect in three
  costumes. The money verbs (WRAP/REDEEM/WITHDRAW) therefore converge on **this run's relayer
  transaction**: `WalletWorkflow.txHash` holds the relayer `transactionId`, and `fetchTransaction`
  gives a per-run verdict — `STATE_CONFIRMED` = landed, `STATE_FAILED`/`STATE_INVALID` = terminal
  failure, anything else = in flight (the SDK's own `TransactionHandle.wait` semantics). A definite
  verdict overrides the balance predicate; only an unreachable probe (or a run that never handed
  off) falls back to it. APPROVALS is deliberately NOT wrapped — its verify is a live allowance
  check whose state semantics must survive an external revocation. Ceiling: a relayer tx stuck in a
  non-terminal state holds the slot in SUBMITTING rather than releasing it at expiry.
- Wrap needs the user's signature so it only runs with a screen open; resume on next open.
- Step-4 acceptance also verifies the **conditional-token approval a SELL needs** (Sol R5 — the
  close path ships broken otherwise), and neg-risk markets are excluded from the real-mode
  allow-list for alpha (third spender is unapproved; `TokenBook` drops `neg_risk`).

### 2.5 Funding + deposit watcher

- Funding screen: deposit address via `bridge.polymarket.com/deposit` proxy (idempotent, cached);
  **hard $5 minimum**; states `awaiting → detected (USDC.e, wrap-needed) → funded (pUSD)`.
- Watcher in the poller, **balance-delta based** (all three advisors): persist baseline balances
  per `FundingAttempt`, poll USDC.e + pUSD via multicall3 aggregate — one HTTP call per tick for
  the whole pending set; raw JSON-RPC over `fetch` (~30 lines), **no viem/ethers** — the poller is
  deliberately zero-EVM-deps (K3). Delta, not nonzero-balance, is the transition (Sol: residual
  balances lie). Contract addresses pinned from the spike's verified transactions.
- Tiered cadence (Sol): every tick for the first hour after a declared deposit, 5 min through 24h,
  30 min through 7 days, then slow sweep; re-arm on funding-screen open. **Never declare user
  money failed** — below-floor deposits park indefinitely and release on top-up (§6.2). Alert ops
  at `awaiting` >60 min (the parked-deposit scenario) and on watcher-level failures (5 consecutive
  failed scans); RPC errors never transition state.
- Implementation notes from the S3 review round (K3): baselines are
  `min(live, previous FUNDED close)` so a deposit that lands *before* the declare still fires;
  **S6 prerequisite** — once trading/withdrawal can move pUSD out mid-attempt, deltas go negative
  and the accounting needs cumulative tracking or a baseline floor. **Half-closed:** the *workflow*
  side of this (WRAP/REDEEM/WITHDRAW convergence) no longer reads wallet-wide deltas at all — it
  converges on the run's own relayer transaction state (§2.4, `runScoped`). **CLOSED (2026-08-14):** the *watcher* side now
  ATTRIBUTES deposits from ERC-20 Transfer logs — `eth_getLogs` for `Transfer(_, wallet, value)`
  over a per-attempt cursor (`scanBlock`, advanced in the same write as the transition), with the
  totals accumulated on the row (`inUsdceMicro`/`inPusdMicro`) and the transaction recorded
  (`lastDepositTx`). An outflow can no longer mask a deposit, and "any inflow counts" is replaced
  by a named transfer. The span is bounded (9k blocks/pass, free RPCs reject wide ranges) so a
  long-parked attempt still converges across passes; balances are still read for
  `latestUsdceMicro` (the WRAP amount pins to it), and with no chain probe passed the old
  delta path stands unchanged as the fallback;
  multicall3 batching is deliberately deferred (2 sequential RPC calls per attempt at alpha scale).

### 2.6 Honest pricing — one shared primitive

- Extend `quoteBuy` (`src/lib/quote.ts`) into the single fee-aware primitive returning
  `{vwap, shares, marginalAsk, allInPrice, fee}` for a budget; used by **display, lock, and order
  construction** — v1's lock-only placement was wrong because `evalSideAsks` /
  `quoteMarketForDisplay` / `quoteSideForDisplay` all bypass the lock (Sol), and a display/lock
  split trips `quotedPriceBp` fairness checks on every swipe (K3 R2).
- `feeInfo` is **per-market**, cached on the `Market` row and refreshed with the depth fields;
  `config.ts` holds only a pessimistic fallback (K3 R1 + DeepSeek). Builder fee fixed at 0 for
  alpha — an unknown additive fee cannot be honestly displayed (Sol).
- Stake semantics — **REVERSED BY THE OWNER 2026-08-17, and this is the rule now: the stake is the
  ORDER, the platform fee rides on top of it** out of the free balance. A $1 swipe posts a $1 order
  and debits about $1.04 (`amount = stake`, `maxSpend = stake + fee`). Shares stay the derived
  quantity. What forced it: the old reading (below) shrank a $1 stake into a $0.96 order and the
  exchange refused it live — *"invalid amount for a marketable BUY order ($0.96), min size: 1"* —
  so the product's own minimum stake was unbuyable by construction. The cap carries the WORSE of
  our per-level fee quote and the fee at the bound price, because the SDK reserves at the bound and
  would otherwise shrink the order back under $1.
  *Superseded (kept for the record, it was settled 2:1 by K3+Sol): the displayed stake was the
  user's all-in debit cap (`maxSpend = stake`), shares shown net of fee, no pre-shrinking.*
- `maxPrice` derives from the **marginal ask** (tick-rounded up for BUY), not VWAP; fee resizing
  must still satisfy `minOrderSize` (shares!) — minimum viable stake ≈
  `minShares × maxPrice × (1+fee)`, which nearly touches the $5 deposit floor on expensive
  markets; enforce client-side before signing.
- SELL/close quoting **walks bids**, which `TokenBook` currently drops — the primitive needs the
  bid side plumbed through before step 7.

### 2.7 Geo, flag, security

- Geo verdict: browser calls `polymarket.com/api/geoblock` at funding-screen open and at **every
  intent issuance**; server records all verdicts, refuses ENTRY intents without a fresh non-blocked
  verdict, always allows EXIT intents (close-only tier, and a failed re-check must never trap a
  position). The verdict is policy, not proof — Polymarket's IP rejection is the barrier, which is
  why the posting locus (§1.3) matters.
- Flag: a persisted per-user consent timestamp (Sol: env list ≠ user opt-in) — an explicit "enable
  real money" step, never a silent flag. SUPERSEDED 2026-08-16: the env allowlist in front of it
  (`REAL_MONEY_EMAILS`/`REAL_MONEY_TWITTER`, unset = nobody) was the alpha gate and is removed; with
  no real users and no campaign running it only blocked the owner's own accounts. Consent is now the
  only per-user gate, which puts more weight on the geo verdict directly above — still policy, not
  proof.
- Before the flag opens beyond the owner: CSP/security headers on the web app (none exist today),
  origin checks on money routes, creds never in `localStorage`, money routes distinguish
  auth-invalid from infra-failure instead of `authUser`'s single 401 path.

## 3. Build order v2 (resequenced per all three reviews)

| # | Step | Acceptance |
|---|---|---|
| 0a | **Owner:** rotate builder creds, burn spike wallet | new creds live, old ones dead — hard gate before any code reads them |
| 0b | Gate-0 spike (§1, browser + real Privy wallet) | signed order accepted+cancelled creds-only; posting locus decided; generator replay byte-matches |
| 1 | Schema + state machines + **paper isolation sweep** | migrations in; paper test suite green; a synthetic real Bet row provably untouched by `settle.ts`, holds, caps, points, mobile responses |
| 2 | Wallet identity fix + backfill + provisioning | embedded EVM wallet verified & backfilled for existing users; deposit wallet persisted idempotently; RelayerTx intent-first |
| 3 | Funding attempts + watcher + funding screen | $5 Solana deposit surfaces from chain deltas; parked-deposit alert fires; bridge `/status` nowhere in the state machine |
| 4 | Durable signature relay: wrap + approvals | USDC.e→pUSD via user-signed gasless wrap; allowances (incl. SELL-side conditional token) read back; restart/double-click tests pass |
| 5 | Fee-inclusive quote primitive everywhere | fixture tests; display = lock = order params, all fee-inclusive; feeInfo cached per market |
| 6 | Order path: two-phase intent + async statuses + geo enforcement + partial booking | first real FAK fill books from actual fills; predicted fee == charged `feeUsdc`; zero-fill frees the slot; D9: no blocking UI |
| 7 | Close path (bid-walk SELL) + redemption + withdrawal (Q2: full cycle) | position closed for a geo-restricted test user; a win redeemed to pUSD; pUSD withdrawn back toward Solana end to end |
| 8 | Rollout hardening | CSP/origin checks, consent UI, ops counters (onboarding vs retry relayer spend), docs de-staled |
| 9 | Browser half: device signer + builder-signing endpoint + `/real` console | a device signs; provisioning, funding, wrap/approvals and recovery all drivable from the browser; builder secret never in the bundle. **The real-mode SWIPE is deliberately NOT here** — it needs Gate-0's posting locus and real FAK response shape |

Steps 1–4 do not depend on Gate-0's answer; 0b runs in parallel with them. Step 6 is where v1's
steps 5–7 merged: pricing, async pipeline, and geo enforcement all land **before or with** the
first real order, not after (unanimous advisor resequencing).

## 4. Owner decisions — LOCKED 2026-08-13

1. **Points / DECK-cap: real swipes fully participate** (cap consumed, points earned, same as
   paper). Executor consequence in §2.2: booked at fill time; `VirtualBalance` untouched.
2. **Funds recovery: full cycle in alpha.** Both redemption of resolved positions and withdrawal
   back toward Solana ship before the flag opens beyond the owner. Gate-0 gains item §1.9; step 7
   acceptance includes a completed withdrawal.
3. **Monitoring: `ops-monitoring` merged into `phase2`** (done same day, fast-forward — GlitchTip
   capture, `/api/health`, poller failure counters and the VPS2 stack are now on this branch).
   Real-money paths use `src/lib/glitchtip.ts` capture from step 2 onward.
4. **CLOB user creds: encrypted server-side** (`ClobCredential` table per §2.2) — enables
   unattended reconciliation; accepted blast radius is read + cancel-griefing, verified in
   Gate-0 §1.4.

## 5. Trap checklist for the executor

All v1 traps stand (bids ascend/asks descend — best is **last**; `minOrderSize` in shares; tick
rule on price bounds; BigInt vs `JSON.stringify`; `.d.ts` lies; `listOpenOrders` unreliable —
read state off acting responses; 5-minute markets need Gamma `end_date_min`; bridge is plain HTTP;
approve exact amounts). New from review:

- Forward the signed order **verbatim**; any reserialization risks digest/wire mismatch.
- Balance **deltas**, never nonzero-balance, drive funding transitions.
- `maxPrice` from the **marginal ask**, not VWAP; fee-per-level vs on-VWAP is unverified until
  Gate-0 §1.6.
- SELL needs the **bid** side, which the current book parsing drops.
- Repo book shape (asks cheapest-first) vs SDK shape (descending) must never mix in one function.
- ~~Neg-risk markets excluded from real mode until the third approval is implemented.~~ **REVERSED
  (owner, 2026-08-15): neg-risk is SUPPORTED.** Its legs are ordinary Yes/No cards that pass the
  binary-only ingest filter — a live Gamma sample put them at 28 of the 100 soonest-ending open
  markets, so excluding them refused about a quarter of the deck in real mode. The alpha approval
  set grew to eight calls (both collateral adapters). Gate-0 must still verify one thing: neg-risk
  positions are ERC-1155 on the `negRiskAdapter` contract and Polymarket's own required-approvals
  list grants nothing there — if a live neg-risk redemption reverts, an operator right on that
  contract is the first thing to add.
- No external call inside `runSerializable`; durable intent row **before** every external call.

## 6. Ops & rollout

Relayer: ~3–4 relay txs per onboarded user, 100/day Unverified cap ⇒ ~25 users/day; the realistic
drain is **retry storms, not growth** — idempotency constraints are budget protection, and the
`RelayerTx` counters must separate the two. Verified-tier application once flow exists
(owner-owned). Monitoring: the merged GlitchTip/ops stack — capture on every real-money server
path, watcher-specific dead-man alerts via the poller's existing counter pattern.

## 7. Human-owned

Rotate builder creds + burn spike wallet (step 0a, release blocker); Terms/counterparty (§6.2);
Verified-tier application; ~$10 of real funds for step-6/7 acceptance; owner decisions Q1–Q4.

## 8. Execution model

DeepSeek v4-flash generates code in chunks of ≤~150 lines against precise per-file specs derived
from this plan; Fable applies, compiles (`tsc`), and runs the repo's `tsx` test scripts after every
chunk; each build-order step lands as its own commit(s) on `phase2` with its acceptance check
demonstrated. Sol/K3 are escalation reviewers for any step that deviates from this plan.

## Appendix — advisor conflicts and resolutions

- **maxSpend vs stake:** DeepSeek wanted the stake pre-shrunk to net notional; K3 and Sol both
  argued stake = all-in debit cap with shares derived. Resolved for K3/Sol — it also matches the
  locked owner rule ("card shows the all-in price"). DeepSeek's `A/(1+f/p)` math survives as the
  share-count derivation.
- **Geo sequencing:** DeepSeek wanted geo before provisioning; K3 before first order. Resolved:
  verdict collection starts at the funding screen (cheap, satisfies the spirit), enforcement is
  mandatory at intent issuance (step 6).
- **Position model:** DeepSeek's separate fills table, Sol's attempts+fills, K3's
  intent-vs-actuals all converge on §2.2; creating the real Bet row on first fill (not at swipe)
  dissolves K3's zero-fill/unique-constraint deadlock without an owner decision.
- **v1's `estimateMarketPrice`:** dropped entirely — the repo's own quote math is richer; the SDK
  is used only for signing, posting, and wallet operations.
