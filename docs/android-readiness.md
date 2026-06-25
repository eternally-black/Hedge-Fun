# Android readiness — what's done, what's left

Audit of the web codebase for the Android (Expo/React Native) app landing in ~5–10 days. The
backend is reused as-is; Android is a second client on the same API + same Privy identity. This
doc tracks the architectural decisions to lock BEFORE Android depends on them, so we don't rewrite.

Sibling doc: [`share-and-android.md`](./share-and-android.md) covers sharing + deferred deep links
in depth. This doc is the broader readiness checklist.

---

## ✅ Already right (don't touch)

| Decision | Where | Why it holds for Android |
|---|---|---|
| **Bearer token, not cookies** | [`useApi.ts`](../src/app/useApi.ts), [`privy.ts`](../src/lib/privy.ts) | Origin-agnostic. RN sends the same `Authorization: Bearer`. No CORS/cookie/SameSite pain. |
| **All routes return pure JSON** | [`src/app/api/`](../src/app/api/) | No redirects, server components, or relative URLs. Contract transfers 1:1. |
| **`share.ts` env-free + `ShareIntent`** | [`share.ts`](../src/lib/share.ts) | RN imports verbatim, adds only a native opener. |
| **Server is the source of truth** | swipe-cap, points, streak computed server-side | Device renders numbers from `/api/me`, never re-derives the economy. |
| **Pure cores extracted from DB code** | `scorePoints`, `evaluateBurn`, `rollUp`, `decideSkip`, `inviterAccrualDelta` | If Android ever wants client-side previews, it reuses these — no drift. |

## ✅ Done in this pass

- **`SHARE_BASE_URL` → env-overridable** ([`share.ts`](../src/lib/share.ts), `NEXT_PUBLIC_SHARE_BASE_URL`
  in [`.env.example`](../.env.example)). Web unchanged (falls back to prod). Android build points
  invite links at a Play Store URL without touching copy sets.
- **`SHARDS_PER_ARTIFACT` served, not hardcoded** — `/api/me` returns `shardsPerArtifact`; web UI
  (Hud/Vault/Profile) reads it. Android won't inherit a `/20` hardcode.
- **API contract pinned** — [`src/lib/api-types.ts`](../src/lib/api-types.ts) is the single source of
  truth for every request/response shape. Routes are typed against it (a shape drift is now a
  `tsc` error, not a prod surprise); web screens consume it via [`ui.ts`](../src/app/ui.ts) aliases.
  Android imports this file verbatim as its client contract. **It caught two latent web bugs**:
  `me.recoverableUntil` was emitted as a raw `Date`, and deck prices were typed nullable.

---

## ⬜ Left to do

### 1. CORS — only if a browser-context client appears  ·  ~10 lines, deferred
No CORS today: web client and API share an origin. A native RN bundle is **not** a browser, so its
`fetch` is not subject to CORS — pure-native Android needs nothing. CORS becomes necessary only for
a **browser-context** consumer: Expo web preview, an in-browser dev tool, or a future web embed
hitting the API cross-origin. If/when that happens, add `OPTIONS` + `Access-Control-Allow-*` once in
a `middleware.ts`. Until then it's YAGNI.

### 2. Privy React Native SDK  ·  Android session + Privy dashboard (client-owned)
[`providers.tsx`](../src/app/providers.tsx) transfers by meaning, not by code:
- `toSolanaWalletConnectors()` is browser-only → Privy RN SDK has its own native Solana config.
- `appId` (`NEXT_PUBLIC_PRIVY_APP_ID`) and server verification ([`privy.ts`](../src/lib/privy.ts)) —
  **carry over unchanged**.
- In the Privy dashboard, add the mobile platform + a deep-link redirect for X OAuth. This is
  client-owned config (the X portal and Privy app belong to the client), same as web.

### 3. Referral `?ref=` capture on first open  ·  needs a decision (see share-and-android.md §4)
Web reads `?ref=` from the URL and POSTs to `/api/login-mark`. On Android the friend usually
installs first, so the query is lost (deferred deep link). Options + recommendation (Play Install
Referrer) are in [`share-and-android.md` §4](./share-and-android.md). Server is already ready —
`captureReferral` is idempotent; the app just makes the same authenticated POST web does.

### 4. Android-aware `refLink`  ·  small, when the store listing exists
Once there's a Play Store URL, `refLink()` should return a store link with `&referrer=CODE` on
Android instead of the bare web URL. One function change; copy sets don't move. (Tracked in
share-and-android.md checklist.)

### 5. Win-share wiring  ·  deferred, product decision
`WIN_X`/`WIN_TG` copy is written and tested but not wired to any button. Awaiting the client's call
on when/where it fires. Reuses `composeXShare(WIN_X, …)` + the same opener — one import away.

---

## Out of scope (don't build ahead of need)

- ❌ No "universal API layer" / GraphQL / tRPC for mobile. REST + Bearer already works.
- ❌ No monorepo package to "share lib with RN" yet. Android shares exactly three files —
  [`api-types.ts`](../src/lib/api-types.ts), [`share.ts`](../src/lib/share.ts),
  [`time.ts`](../src/lib/time.ts) — that's a copy/import, not infrastructure. Monorepo when a real
  third consumer appears.

---

## Notes for the testing pass (separate work)

Coverage is **not** zero: every pure economy core has a DB-free self-check (`npm test`). The gap is
the **DB-backed seams + the HTTP layer** — exactly what Android leans on. Priority order:

1. `recordSwipe` cap-gate atomicity (concurrent swipes; throw rolls back the counter) — [`swipe.ts`](../src/lib/swipe.ts)
2. `captureReferral` idempotency (double first-open must not double-reward) — [`referral.ts`](../src/lib/referral.ts)
3. `computeReferralRewards` retroactivity (param change back-pays) — [`referral.ts`](../src/lib/referral.ts)
4. `authUser` / `verifyPrivyToken` — the single auth gate for both clients — [`privy.ts`](../src/lib/privy.ts)
5. Per-route contract smoke: 401 without token, 200 + expected keys with token — fixes the shapes in [`api-types.ts`](../src/lib/api-types.ts)
6. `effectivePoints` (x2 over ledger) — [`points.ts`](../src/lib/points.ts)
7. `evaluateStreak` / `recoverStreak` burn→recovery transitions — [`streak.ts`](../src/lib/streak.ts)

Style: `node:assert`, no frameworks; DB-free in `npm test`, DB-backed as standalone `tsx scripts/test-*.ts`
(like `test-swipe-cap`, `test-ensure-user-race`).
