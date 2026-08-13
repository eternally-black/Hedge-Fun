# Handoff — the real-money layer that is not written yet

Written **2026-08-13**. Audience: the agent (or dev) who builds the Polymarket real-money path into
this repo. Everything below is either verified against production or explicitly marked as unknown.
Do not re-derive what is marked proven — it cost a day and about $9 of real money.

**Read first:** `docs/hedge-fun-phase2-spec.md` §6, §6.1–6.3 (the gates and the funding rules), then
`C:\Users\valera\poly-spike\HANDOFF.md` and `RESULT.md` beside it (the evidence log and every SDK
trap paid for the hard way). The spike lives **outside this repo** on purpose and holds the client's
builder credentials in a local `.env`.

---

## Scope in one paragraph

The app currently books hedge cards as **paper bets** (`Bet` rows, D6). The job is to make a swipe
place a **real order on Polymarket** for the user, non-custodially, without a Polymarket frontend
anywhere in the flow. Every mechanism this needs has been proven end to end in the spike; **none of
it exists in this repo**. There is no `@polymarket/client` dependency here — the app still talks to
Gamma/CLOB over plain HTTP for read-only market data.

---

## What is already proven — do not re-litigate

| Claim | Evidence |
|---|---|
| A third-party app can deploy a Deposit Wallet per user, gaslessly, from builder API credentials alone | `createSecureClient` did it from a fresh throwaway signer. `walletType`/`signatureType` are both `3` |
| Builder attribution rides inside the **signed** order | ERC-7739 contents descriptor ends in `bytes32 builder` — it cannot be stripped in transit |
| A CLOB order signed by the Deposit Wallet with POLY_1271 is accepted | posted, `status: live`, then cancelled |
| **We can wrap USDC.e → pUSD ourselves** | `wrap.mjs --send`, tx `0x248841f0…c38a1`, `status 0x1`. Same contract, same selector `0x0a3c4405`, same 1028-byte payload as polymarket.com's own transaction |
| Funding from Solana is free and needs no vendor | 2 USDC → `2.000000`, 5 USDC → `5.000000`. `bridge.polymarket.com/deposit` needs no API key |
| The geoblock endpoint is callable and CORS-open | `GET polymarket.com/api/geoblock`, `access-control-allow-origin: *` |

Still unproven: **builder attribution on a real fill**. `poly-spike/fill.mjs` is written and dry-runs
clean; it needs `--send` and about $3. Until it runs, `listBuilderTrades` returns `[]` by
construction, not by failure.

---

## The one architectural question to resolve FIRST

Everything downstream depends on where the signature happens, and the answer is not obvious from the
SDK. Facts, all checked:

- D5 requires **on-device signing, no server-held keys, no delegated sessions**.
- The SDK's Privy adapter is `signerFrom({ privy, walletId })` where `privy` is a `PrivyClient` from
  **`@privy-io/node`** — i.e. server-side signing. That is the delegated model D5 rejects, so this
  adapter is **not** the path.
- `Signer` is tiny and implementable against Privy's browser SDK:
  `getAddress()`, `signTypedData(payload)`, `signMessage(hex)`, `sendTransaction(req)`.
- Gasless workflows (`prepareGaslessTransaction`) are **async generators** that yield
  `requestAddress` / `signGaslessTypedData` / `signGaslessMessage` and take the answers back. That
  shape lets a server drive the workflow while a device answers each signature. `wrap.mjs` contains
  a working 8-line driver — copy it.
- **But orders have no equivalent public split.** `OrderWorkflow` exists as a type
  (`AsyncGenerator<SignOrderRequest, SignedOrder>`), yet `prepareMarketOrder` / `prepareLimitOrder`
  are **not exported** as free functions — only `client.createMarketOrder()`, which signs with the
  client's own signer. `postOrder(signedOrder)` *is* exported standalone.

So decide, with a spike, before writing app code:

1. Does `createSecureClient` work **without** builder API credentials (user CLOB creds only)? If yes,
   the browser can hold a client bound to the Privy signer, create and sign orders, and either post
   directly or hand the `SignedOrder` to our server to post. Builder attribution is just the
   `builderCode` field, which is not a secret.
2. If not, the server must build orders and the device must sign them — which currently means
   reaching past the public API surface, or asking Polymarket to export the order workflow.

**Never ship the builder API key/secret/passphrase to a client bundle.** They are the client's
credentials and they authenticate wallet deployment.

---

## Build order

Each step depends on the one above it. Ship them behind a flag; paper bets stay the default until
the whole chain works.

### 1. Wallet provisioning
Every web user already has a Privy embedded EVM wallet — `src/app/providers.tsx` sets
`embeddedWallets: { ethereum: { createOnLogin: "all-users" } }` and the address is stored uniquely on
`User.embeddedWalletAddress`. That address is the **signer**. From it the SDK derives and deploys the
user's Deposit Wallet gaslessly. Persist the Deposit Wallet address next to the user; it is
deterministic, but reading it back beats re-deriving it on every request.

### 2. Funding screen
- Deposit address: `POST bridge.polymarket.com/deposit` with `{address: <depositWallet>}`, no auth.
  It returns `{evm, svm, tron, btc}` and is idempotent per wallet.
- **Enforce a hard minimum of $5 in the UI** even though the floor is $3. See §6.2: below the floor a
  deposit does not fail, it parks silently and indefinitely, and the floor moved within a single day.
- **Detect deposits by reading the chain**, never by polling `bridge.polymarket.com/status/<addr>` —
  that endpoint lost the pending record twice and lagged actual delivery by 15 minutes.
- Treat a deposit as *pending* until **pUSD** appears. It may arrive as pUSD (wrapped by their
  pipeline) or as USDC.e (not wrapped). Both happened on the same wallet on the same day.

### 3. Wrap
Port `poly-spike/wrap.mjs`. Two calls batched atomically through `prepareGaslessTransaction`:
`USDC.e.approve(CollateralOnramp, exactAmount)` then `wrap(USDC.e, depositWallet, amount)` at
`0x93070a847efEf7F70739046A929D47a521F5B8ee`. Approve the **exact** amount, not max.
Consequence of D5 worth designing for: the wrap needs the user's signature, so it **cannot run in the
background**. Run it while the funding screen is open; if the user leaves first, resume on next open
and show the balance as pending meanwhile.

### 4. Trading approvals
`client.setupTradingApprovals()`, once per wallet. It returns `undefined` and works through relayer
transactions — read the state back after a pause via `fetchBalanceAllowance` (which lives in
`@polymarket/client/actions`, not the root, not on the instance). It grants **unlimited** allowance to
two of three spenders; the third (NegRiskAdapter `0xd91E80cF…`) stays zero and only matters on
neg-risk markets.

### 5. Orders — market, not limit
Product rule (owner, 2026-08-13): **a swipe means the user is in the trade**, so orders are market
orders, not resting limits.

```
client.createMarketOrder({ tokenId, side, amount /* USD */, maxPrice, orderType: FAK, builderCode })
```

- `amount` is **USD notional**, not shares.
- `orderType: FAK` fills whatever is available now and cancels the remainder. Prefer it over FOK: a
  partial hedge beats no hedge.
- `maxPrice` is the slippage bound, and it reconciles this rule with D9's "never fill at a worse
  price" — immediacy with a ceiling, rather than a choice between them.

### 6. The card price must be the executable price, fees included
Owner's rule: the card shows what the user will **actually** pay, pessimistic, not top-of-book.
`estimateMarketPrice(client, { tokenId, side, amount })` returns the average price after walking the
book for that notional. That is the first half. On a live 5-minute market the top of book read `0.01`
while the honest estimate for a $1 order was `0.04` — a card quoting top-of-book would have lied 4×.

**The second half is the platform taker fee, and `estimateMarketPrice` does not include it.** Measured
on the real fill of 2026-08-13 and verified against the market's own `feeInfo`:

```
fee per share = rate × (p × (1 − p)) ^ exponent        // feeInfo, per market: rate 0.07, exponent 1
```

Predicted `0.08736`, charged `0.08736` — exact. As a share of notional that is:

| price | fee |
|---|---|
| 0.50 | **3.50%** |
| 0.70 | 2.10% |
| 0.90 | 0.70% |
| 0.97 | 0.21% |

The fee peaks at 50/50 — which is exactly where a hedge lives, because that is where the uncertainty
is. A $100 hedge costs $3.50 to enter. Any builder fee the client later sets (≤100 bps taker) stacks
on top. So the card's number is `estimateMarketPrice` **plus** this fee, and the order should use
`maxSpend` (the SDK's all-in spend cap, which accounts for both platform and builder fees) rather
than trusting `amount` alone. `poly-spike/fill.mjs` implements the price half; the fee half is not in
it yet.

### 7. Async pipeline (D9)
The swipe resolves instantly; signing and submission happen behind it, with per-bet status
`signing → submitting → open/filled/failed` surfaced in Results, never as a blocking modal.

### 8. Geo-gate
`GET https://polymarket.com/api/geoblock` — **from the user's browser**. §6.3 documents the trap: the
endpoint only ever describes whoever connected to it, `?ip=` is echoed but ignored, `X-Forwarded-For`
is ignored, and spoofing `CF-Connecting-IP` earns a 403 from Cloudflare. A server-side check silently
passes everyone. Also honour the `close-only` tier: a restricted user must still be able to **exit**.

---

## Budget the relayer, it runs out before the money does

The Unverified builder tier allows **100 relayer transactions per day**. Onboarding one user costs
roughly 3–4 (deploy + approvals + wrap), so the ceiling is about **25 new users a day**. Orders go to
the CLOB and do not consume it, but every wallet operation does. Verified (10 000/day) is an
application to `builder@polymarket.com` that expects existing flow — so this is sequencing, not a
gate, but it will bite during alpha if nobody counted.

---

## Traps already paid for

- `OrderBook.bids` ascend and `asks` **descend** — the best of each is the **last** element.
- `minOrderSize` is in **shares**, not dollars. It was 5 on every market seen; at price 0.60 that is a
  $3 minimum whatever the user asked for.
- **`maxPrice` / `minPrice` obey the tick rule too.** They are not free-form bounds: the SDK rejects
  anything that is not a whole multiple of `tickSize` (`maxPrice must conform to tick size 0.01 with
  at most 2 decimal places`) and anything outside `[tick, 1-tick]`. Derive the bound from
  `estimateMarketPrice`, then round it **up** to a tick for a BUY — rounding down turns the
  protection into an unfillable order.
- `fetchTickSize` is not a client method and is unnecessary: the book carries `tickSize` and
  `minOrderSize`.
- `fetchBalanceAllowance` / `updateBalanceAllowance` live in `@polymarket/client/actions`, return
  **BigInt**, and `JSON.stringify` throws on them without a replacer.
- `fetchBalances`, `listDeposits`, `fetchPortfolio` appear in the `.d.ts` but are not on the secure
  client. `fetchPortfolioValue` reports positions, not cash — it reads `0` with collateral present.
- `listOpenOrders(...).firstPage()` came back empty for an order that was demonstrably live. Read
  order state off the operation that acts (the cancel response), not off a query.
- Short-lived markets (`*-updown-5m-*`) are **invisible to `listMarkets`** — three pages, zero hits.
  Find them through Gamma with `end_date_min`.
- The SDK does not know about the bridge at all; `bridge.polymarket.com` is plain HTTP we
  reverse-engineered from the docs.
- Type definitions beat the docs and any model's priors. `@polymarket/bindings` holds `Market`,
  `OrderBook`, `OpenOrder`, `BuilderTrade`, `SignatureType`.

---

## Decisions already made — do not reopen

- **Non-custodial, no server-side signing.** Confirmed by the owner 2026-08-13. Server-held keys or
  Privy delegated actions would require licensing; the answer is no, permanently.
- **Web first, mobile after.** Real money gets proven in the web client; the React Native port comes
  once it works. Privy's silent EIP-712 signing is the standard path in a browser and the unproven
  one in RN, so this ordering also de-risks §6 gate 3.
- **Market orders, not resting limits.** A swipe is an entry, not a ticket.
- **The card shows the book-walked price**, not top-of-book.
- **No KYC beyond Polymarket's own.** The builder profile belongs to the client, and its jurisdiction
  is what geo-gating hangs off — nothing to configure in code, and there is no payout address to
  store (checked via `poly-spike/builder.mjs`: no API surface exposes one).

## Open, and owned by humans

- Terms: who is the counterparty and who answers when a deposit parks at a third party (§6.2).
- `poly-spike/fill.mjs --send` — the last proof, ~$3.
- Burn the spike wallet. Its private key reached a chat transcript; fine for a $9 throwaway, not for
  anything after it.
