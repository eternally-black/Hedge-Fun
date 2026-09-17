# Shipaton 2026 — Google Play now, Solana Seeker dApp Store next

Contest: [RevenueCat Shipaton 2026](https://www.shipaton.com/) ·
[official rules](https://revenuecat-shipaton-2026.devpost.com/rules) · [FAQ](https://www.shipaton.com/faq).
Deadline **Wed 30 Sep 2026 23:45 PT = Thu 1 Oct 09:45 Kyiv**. Judging 1–13 Oct, winners 21 Oct.

This doc is the single source of truth for the mobile build: contest brief (§0), what Google Play
lets us ship (§1), owner asks (§2), the product on Play (§3), the two-flavor architecture that
carries the Seeker build (§4), phases with gates (§5), requirement → evidence (§6), risks (§7).

---

## 0. Contest brief (rules, verbatim where it matters)

| Rule | Wording | Our status |
|---|---|---|
| SDK | "All Shipaton submissions must use the RevenueCat SDK for in-app purchases, subscriptions, or ads." Prep guide: "integrate the RevenueCat SDK to power at least one in-app purchase". | Pro subscription, §3 |
| New app | "The first public version of the Project must be released during the Submission Period [31 Jul–30 Sep] on Apple's App Store, the Google Play Store, or the Samsung Galaxy Store. A Project may have existed before … but it must not have been publicly released on any eligible store before." FAQ: web-only apps may be ported. | Hedge Fun was never on any store → eligible |
| Live | "Your app must be published on the app stores so judges can download and review it." TestFlight / open testing do not count; "in review" does not count. | Production release by 24 Sep (§5) |
| Judges' access | "Free trial or … promo code for judges to unlock the in-app purchase"; app available through the Judging Period (13 Oct). | 7-day trial + Play promo codes |
| Reach | App "accessible from the United States". | Play listing includes US |
| Submission | Text description; public store URL; icon 1024×1024; screenshots "1179px width and 2556px height WITHOUT device frames"; demo video "less than two (2) minutes", public on YouTube/Vimeo, recorded on a real device; category. Grand Prize also wants "what you have done since launch to grow your app". | §6 |
| Team / geo | No team-size limit. Excluded: Cuba, Iran, North Korea, Crimea, Russia. | OK (Ukraine) |

Categories we aim at and their one-line criteria: **HAMM** ("smartest use of RevenueCat to drive real
revenue"), **Design** ("innovative ideas and/or beautiful app design and animations"), **#BuildInPublic**
("how much do you share your app development journey publicly?"), **Grand Prize** ("early and
effective release", "growth by numbers"). No Web3/Solana/fintech category exists — the Solana story is
a differentiator for judges, not a scored criterion.

## 1. What Google Play lets a 13-day build contain → **Play flavor is paper-only**

- **Real-money predictions are out.** Play's [Real-Money Gambling policy](https://support.google.com/googleplay/android-developer/answer/9877032):
  "we don't allow content or services that enable or facilitate users' ability to wager, stake, or
  participate using real money … to obtain a prize of real world monetary value" without "a valid
  gambling license for each country or state/territory in which the app is distributed". Polymarket
  real mode is exactly that.
- **In-app crypto trading / custodial wallet is out.** Play's
  [Cryptocurrency Exchanges and Software Wallets policy](https://support.google.com/googleplay/android-developer/answer/16329703)
  (effective 29 Oct 2025) requires per-country licensing (US: FinCEN MSB + state MTLs; EU: MiCA CASP;
  UK: FCA …) for exchanges and custodial wallets; only non-custodial wallets are out of scope. A Privy
  embedded wallet that swaps USDC→xStocks in-app reads as a custodial exchange feature. Any financial
  feature also needs the Financial Features Declaration.
- **Paper mode is fine.** Virtual points, no cash-out, no purchase of points — outside the gambling
  policy (the "simulated gambling" prohibition sits in the gambling-*ads* requirements). Stock-market
  simulators are a whole Play category. Answer the IARC questionnaire honestly.
- The owner already decided on 2026-08-04 that real money ships on the Seeker dApp Store first
  ([phase-2 spec §6 row 5](./hedge-fun-phase2-spec.md)). Shipaton adds a Play build in front of it, so:

**D1 — The Play flavor renders the paper economy only.** No wallet, no Paper/Real switch, no
deposit / withdraw / real consent, no reachable Solana code path. The server keeps every money gate
it has today (allowlist + consent + same-origin), and additionally omits the `real` surfaces from
`/api/me` for a client that declares itself `play` (§4.3). Real money stays on web (unchanged) and
arrives on mobile with the Seeker flavor (§4).

## 2. Owner asks — Day 0, all **[HUMAN]**, all on the critical path

1. **Which Google Play Console account?** Personal accounts created after 13 Nov 2023 must run a
   closed test with **12 testers opted in for 14 continuous days** before production access
   ([Play Console Help](https://support.google.com/googleplay/android-developer/answer/14151465)).
   14 days > the 13 we have. An **organization account** or a **pre-Nov-2023 personal account** has no
   such rule. If only a new personal account exists, the Play route is dead and the Samsung Galaxy
   Store is the only other eligible store (RevenueCat has no Galaxy billing → also dead). Answer today.
2. **Privy dashboard** (the dev has no console rights — [hedgefun-account-ownership]):
   a mobile **app client id** (`EXPO_PUBLIC_PRIVY_CLIENT_ID`), the `hedgefun://` OAuth redirect for X
   login, and a **reviewer test account** (allow-listed email with a fixed OTP) for Play's
   "App access" form — Google reviewers cannot receive our OTP mails.
3. **RevenueCat**: project + Android app, Google Play service-account credentials (Play Console
   → API access), product `pro_monthly` with a 7-day free trial, entitlement `pro`, a webhook with an
   Authorization secret, public Android API key for the client.
4. **Play listing**: privacy policy URL (`app.hedgeyour.fun/terms` exists — needs a privacy page),
   Data safety form, IARC content rating, app-access instructions, feature graphic 1024×500,
   icon 512, ≥2 phone screenshots. Merchant account for paid products.
5. **Signing**: EAS-managed upload keystore (recommended) + Play App Signing. Keep the EAS key: the
   Seeker APK is signed with it too (§4.1).
6. **A physical Android phone** for the demo video and for the reviewer-equivalent smoke test.

## 3. Product on Play: Hedge Fun (paper) + Pro

**What the Expo app already has** (`mobile/`, July 2026, 4.1k lines, Expo 57 / RN 0.86, Privy Expo
SDK): Login, Home (GM), Deck (predictions), Hedge (S1+S2 cards), Results inbox, Profile, HUD,
top-up sheet, referral capture, share intents. **What web has that mobile lacks**: 4-tab nav
(Deck · Hedge · Stocks · You), Stocks deck, Portfolio, the one BalanceSheet (Calls / Stocks / Hedges),
stock consent sheet, profit-alert rows. All of it is paper-capable today; the server already serves it.

**Pro** — one RevenueCat entitlement `pro`, product `pro_monthly` (monthly, 7-day trial):

| Perk | Existing mechanic it reuses |
|---|---|
| All card skins unlocked | `src/lib/skins.ts` `cost` → 0 when pro; unlock route checks `user.proUntil` |
| Daily paper refill: +$100 Cash when Cash < $50, once a day | `src/lib/topup.ts` gets `kind: "pro"` next to `free` / `artifact` |

Server truth: `User.proUntil DateTime?`. `POST /api/rc/webhook` (Authorization = `REVENUECAT_WEBHOOK_SECRET`)
ignores the event type, re-reads the subscriber through the RevenueCat REST API and stores
`entitlements.pro.expires_date` — one code path for purchase, renewal, cancellation, expiry, refund.
`/api/me` gains `pro: { active: boolean; until: string | null }`. Client: `Purchases.configure({apiKey})`,
`Purchases.logIn(me.id)` after the first `/api/me` (app user id = our `User.id`), and
`RevenueCatUI.presentPaywallIfNeeded({ requiredEntitlementIdentifier: "pro" })` from the skin shop and
the top-up sheet. Paywall layout is remote-configured in the RevenueCat dashboard (Design award: a
paywall that matches the card skins).

## 4. Architecture — one Expo app, two flavors

### 4.1 What differs on Seeker

| Concern | Play flavor (now) | Seeker flavor (next) |
|---|---|---|
| Distribution | AAB → Play Console, Play App Signing | APK signed with our EAS key → [dApp Store publisher portal](https://docs.solanamobile.com/dapp-publishing/prepare) (Publisher / App / Release NFTs; icon 512, banner 1200×600, ≥4 screenshots). **Different `applicationId`** (`fun.hedgeyour.app` vs `fun.hedgeyour.seeker`): Play re-signs with its own key, so one package name on a device that has both stores = "signature mismatch, not installed". |
| Identity | Privy (email / X) → Privy access token → `authUser` | Same Privy identity **plus** the Seeker wallet linked through Mobile Wallet Adapter (MWA) as the trading wallet. Reuses last week's verified-wallet picker (`useTradingWallet`, Profile → Wallet, `/api/link/*`). A later SIWS-only login (no Privy) plugs into the same `authUser` choke point (`src/lib/privy.ts`) by token kind. |
| Wallet link proof | n/a | Today `/api/link/sync` trusts Privy's linked-accounts list. MWA is outside Privy → new `POST /api/link/mwa` verifies a signed nonce (`authorize` + `sign_in_payload`, [SIWS](https://docs.solanamobile.com/react-native/using_mobile_wallet_adapter)) and marks the wallet verified. |
| Signing | none | MWA `signTransactions` over the **server-built** bytes. The contract `/stocks/real/tx → /submit → /confirm` (fee-sponsored, sponsor co-signs only its own message) is unchanged — the client never builds a transaction on any platform. Seed Vault is reached through MWA; no extra SDK. |
| Real money scope | off | xStocks real (Solana-native). Polymarket real needs an EVM EIP-712 auto-signer (Privy embedded EVM wallet, `providers.tsx`) — MWA is Solana-only. Polymarket stays paper on Seeker until that is decided. |
| Monetization | RevenueCat + Play Billing | Play Billing is unavailable to an APK not installed from Play. `proUntil` is set from an **on-chain receipt** (USDC transfer to a treasury address, server verifies the landed tx — same shape as the stock buy confirm) or granted free to Seeker Genesis Token holders. Same server field, different source. |
| Money-route origin guard | n/a (no money routes reachable) | `sameOrigin()` (`src/lib/real.ts`, 13 routes) requires `Origin === APP_ORIGIN`; a native `fetch` sends no `Origin` → 403 today. Native clause: accept **no `Origin` + `x-hf-client: seeker`** (a browser cannot send a cross-site POST without `Origin`, and the custom header forces a preflight). |
| Push | FCM | FCM (Seeker ships Google Play Services) |
| Deep links / referrals | `hedgefun://`, app links, Play install-referrer | same scheme; `assetlinks.json` lists both packages + fingerprints |

### 4.2 Code layout (mobile)

```
mobile/
  app.config.ts               # replaces app.json; APP_FLAVOR=play|seeker → name, android.package,
                              # plugins (MWA plugin seeker-only), extra.flavor, EXPO_PUBLIC_FLAVOR
  eas.json                    # profiles: dev (apk, dev-client), play (aab), seeker (apk)
  metro.config.js             # + watchFolders: ../src/lib (contract), + flavor resolver:
                              #   import "x.flavor" → x.<flavor>.ts (like platform extensions)
  src/platform/
    flavor.ts                 # export const FLAVOR = process.env.EXPO_PUBLIC_FLAVOR ('play' default)
    purchases.flavor.ts       # type only: { configure(userId), presentPaywall(), isPro() }
    purchases.play.ts         # RevenueCat (react-native-purchases + -ui)
    purchases.seeker.ts       # on-chain receipt (phase 6)
    signer.flavor.ts          # type only: { signTransaction(bytes) → signed bytes }
    signer.play.ts            # throws "unavailable" — never reached: real UI is not rendered
    signer.seeker.ts          # MWA (phase 6)
    walletLink.*.ts           # play: none · seeker: MWA authorize + /api/link/mwa (phase 6)
```

Rules:
- **The contract is imported, not copied.** `mobile/lib/{api-types,share,time}.ts` are copies of
  `src/lib/*` and have drifted (5 + 60 lines today). Metro `watchFolders` + a tsconfig path make
  `mobile` import `../src/lib/api-types` directly; the RN share opener stays in
  `mobile/src/openShareNative.ts`. CI fails on any import from a deleted copy.
- **Server builds, client signs.** No transaction construction, no RPC, no private key on any client.
- **Flavor is a build-time constant**, never a runtime toggle: the Play bundle must not be able to
  reach real-money UI even by a flipped flag. The flavor resolver picks files; the other flavor's
  file is not in the bundle. Native modules of both flavors are still autolinked (Expo autolinking is
  static) — `ponytail:` acceptable ceiling; split into two Expo projects only if Play review objects.
- **One Expo project, both dev builds.** Privy Expo already requires a dev build (passkeys,
  secure-store); RevenueCat and MWA do too. Expo Go is not a target.

### 4.3 Server changes (both flavors share the API; one Next.js deploy)

| Change | Where | Flavor |
|---|---|---|
| `x-hf-client: web \| play \| seeker` read in `authUser` and threaded as `client` | `src/lib/privy.ts` | both |
| `/api/me` omits `real` and `stocks.sponsored` for `play`; every money route already 403s without consent — belt and braces | `src/app/api/me/route.ts` | play |
| `User.proUntil`, `POST /api/rc/webhook`, `me.pro`, `topup kind:"pro"`, skins cost 0 when pro | `prisma/`, `src/app/api/rc/webhook`, `topup.ts`, `skins.ts` | play (seeker reuses `proUntil`) |
| `sameOrigin` native clause | `src/lib/real.ts` | seeker |
| `POST /api/link/mwa` (nonce + signature verify) | `src/app/api/link/mwa` | seeker |
| Pro via on-chain receipt | `src/app/api/pro/onchain` | seeker |

## 5. Phases and gates (13 days; dates Kyiv)

| Phase | Dates | Work | Gate |
|---|---|---|---|
| 0 Day-0 asks | Wed 17 – Fri 18 Sep | §2 sent to the owner; Stocklana submission (Fri 18 Sep 23:00 Kyiv) has priority. No mobile code. | Play account type answered |
| 1 Build green | Sat 19 – Sun 20 | `mobile` deps install on Expo 57; `app.config.ts` + `eas.json`; contract via `watchFolders`; EAS dev build APK (this machine has no Android SDK / JDK 17 — cloud build first, Android Studio in parallel); CI job `mobile`: `tsc --noEmit` + `expo export` + no-copy check | **HARD STOP**: APK runs on a phone, Privy login works, deck deals |
| 2 Parity | Sun 20 – Tue 22 | 4-tab nav, Stocks deck (paper), Portfolio (paper), BalanceSheet, You screen; `x-hf-client`; `/api/me` play gating | soft: every web paper flow reachable on the phone |
| 3 Pro | Tue 22 – Wed 23 | `proUntil` migration, webhook, `me.pro`, topup `pro`, skins; paywall from shop + top-up; license-tester sandbox purchase | **HARD STOP**: sandbox purchase → webhook → `proUntil` visible in `/api/me`; cancel → expiry lands |
| 4 Store | Wed 23 – Thu 24 | Listing assets, Data safety, IARC, app access with the reviewer account; internal testing → **production submit Thu 24** | [HUMAN] submitted; review 1–7 days |
| 5 Submit | Fri 25 – Tue 29 | Review fixes; Devpost draft; video < 2 min on the phone (monetization moment on screen); build-in-public posts; **Devpost submit Tue 29** (1-day buffer) | **HARD STOP**: §6 every row has evidence |
| 6 Seeker | Oct | `signer.seeker`, `walletLink.seeker`, `/api/link/mwa`, `sameOrigin` native clause, on-chain Pro, dApp Store publisher NFT + release | APK on a Seeker, real xStocks buy signed by Seed Vault |

Executor topology: Flash writes the hunks, Fable specs / applies / verifies
([executor-topology-rule], [flash-hunk-workflow]); Opus second-opinion review at each HARD STOP.

## 6. Requirement → evidence (fill as we go)

| Requirement (rules wording) | Evidence | Status |
|---|---|---|
| "use the RevenueCat SDK for in-app purchases, subscriptions" | `mobile/src/platform/purchases.play.ts`, `src/app/api/rc/webhook/route.ts`, RC dashboard screenshot of a sandbox purchase | ⬜ |
| "first public version … released during the Submission Period" | Play Console release date | ⬜ |
| "published on the app stores so judges can download" | Play URL | ⬜ |
| "free trial or promo code for judges" | trial on `pro_monthly` + promo codes in the Devpost "testing instructions" | ⬜ |
| "accessible from the United States" | Play country list | ⬜ |
| Video "< 2 minutes", "recorded on a real device" | YouTube link | ⬜ |
| Screenshots 1179×2556 no frame; icon 1024 | `app design/` exports | ⬜ |
| Available through 13 Oct | no unpublish; Pro trial ≥ judging window or promo codes | ⬜ |
| #BuildInPublic | X thread links (one per gate) | ⬜ |

## 7. Risks, ranked

1. **Play account type** (§2.1). Binary. Ask first.
2. **Owner-gated config** (Privy client id, reviewer account, RC credentials) — the dev cannot
   create any of it. Every day of delay moves the Thu 24 submit.
3. **Dependency matrix**: Expo 57 / RN 0.86 / Privy Expo 0.70 / `react-native-purchases` / (later)
   `@wallet-ui/react-native-kit` + nitro modules. Unverified until the phase-1 build; budget one day.
4. **Play review** 1–7 days; a policy question about "predictions" is possible — the listing copy says
   forecasting game with virtual points, no cash prizes; answer the IARC gambling question honestly.
5. **Local toolchain**: no Android SDK / JDK 17 on this machine → EAS Build cloud first (queue times),
   Android Studio installed in parallel for the emulator and local dev builds.
