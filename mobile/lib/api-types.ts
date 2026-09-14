// COPIED from src/lib/api-types.ts — sync manually, do not diverge
// ─── API CONTRACT ──────────────────────────────────────────────────────────────────────────
// The shapes the HTTP API (src/app/api/*) returns. This is the SINGLE SOURCE OF TRUTH for the
// request/response contract shared by the web client AND the upcoming Android (Expo/RN) app.
//
// Why this file exists: web deploys atomically, mobile does NOT — once Android ships to the Play
// Store, an old phone and the current backend run side by side. A drifting response shape breaks
// the stale client silently. Pinning the contract here means a server change that alters a shape
// is a type error in the client (web today, RN tomorrow), not a runtime surprise in prod.
//
// RULES:
//  • Routes must satisfy these types (the route's NextResponse.json(...) shape == the type here).
//  • Changing a shape = a breaking API change. Add fields (optional); don't remove/rename in place.
//    When a real break is unavoidable, version it (/api/v2) so old clients keep hitting v1.
//  • Env-free, Prisma-free, browser-free — RN imports it verbatim. NO runtime code, types only.
//
// Kept in sync by hand (no codegen for MVP — ponytail: the API is 9 small routes; a generator is
// more machinery than the contract is big. Revisit if the surface grows past ~20 routes).

// String enums mirrored from Prisma so this file stays @prisma/client-free (RN has no Prisma).
export type BetSide = "YES" | "NO";
export type BetSource = "DECK" | "FEED"; // DECK = swipe deck (points + capped shards); FEED = post-cap feed (no points, uncapped shards)
export type StreakState = "ACTIVE" | "BURNED_RECOVERABLE" | "LOST";
export type PointsType = "SWIPE" | "LOGIN" | "REFERRAL" | "STREAK_X2";
export type BetStatus = "PENDING" | "WIN" | "LOSS" | "PUSH";
export type AuthProvider = "EMAIL" | "TWITTER"; // how the user signed up

// Every route returns this on a missing/invalid Bearer token (HTTP 401). Other 4xx use the same
// `{ error }` shape (see per-route notes below).
export interface ErrorResponse {
  error: string;
}

// ─── GET /api/deck ───────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The blitz deck — OPEN markets within each category's horizon (crypto/OU <=24h,
// sports/esports <=72h), category-mixed, minus cards the user already swiped. ISO-8601 string for
// resolutionDeadline (JSON has no Date).
export interface DeckCard {
  id: string;
  question: string;
  // SERVER-DERIVED (deck-mix categoryOf), not Gamma's own field. Gamma leaves `category` null on
  // every live market — measured 0 of 1600 on 2026-08-03 — so passing it through meant the RN
  // client, which has no classifier and keys its badge off this string, rendered a grey "Market"
  // chip on literally every card. One of: crypto|esports|sports|overunder|politics|weather|other.
  category: string | null;
  // The specific league or game when one is recognised ("NBA", "Soccer", "CS2"), else null. Same
  // source as `category`. Additive and optional: web derives it locally, RN cannot (it deliberately
  // does not port the classifier) and shows the generic category label when this is absent.
  league?: string | null;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
  // Basis points (5150 = 51.5¢). The price this side COSTS: for a Polymarket market the book-walked
  // VWAP for a $10 stake (D10) — NEVER the Gamma mid; a Polymarket row with no fresh-enough book
  // read is simply not served. A bookless-source row serves its stored odds instead (authoritative
  // there, not a fallback). Sides need NOT sum to 10000 (real spread). The bet-lock path re-quotes live — treat
  // these as display prices.
  yesPriceBp: number;
  noPriceBp: number;
  // ISO-8601. For a MATCH this is Gamma's endDate, which equals KICK-OFF — the card's clock counts
  // down to the whistle, not to a payout, and the market then trades in-play and resolves after.
  resolutionDeadline: string;
  startsAt?: string | null; // ISO-8601 kick-off; equal to the deadline on a match, null off the pitch
}
export interface DeckResponse {
  cards: DeckCard[];
}

// ─── GET /api/quotes?ids=<marketId,...>&stake=<cents> ─────────────────────────────────────────────
// Auth: Bearer. Live executable prices for the card(s) the user is LOOKING AT (D10 Slice B). Books
// churn every ~5s, so a card sitting under a deliberating thumb goes stale within seconds of being
// dealt; the client re-polls the TOP card and re-renders its payout from this.
// `ids` is capped server-side and `stake` is clamped — quoting is CPU-trivial off a shared book
// cache, so the caps are about abuse, not cost. Rate-limited per user.
// Errors: 400 (no ids), 401, 429 (rate_limited).
export interface QuoteRow {
  marketId: string;
  // Same units and meaning as DeckCard.yesPriceBp: what this side COSTS at the requested stake.
  // null = not buyable right now at that stake (dead/thin book, or CLOB unreachable with nothing
  // cached). The client should disable that side rather than show a stale number.
  yesPriceBp: number | null;
  noPriceBp: number | null;
  asOfMs: number | null; // when the book behind the pair was read (older of the two sides)
  // false = the row has no CLOB book at all and answered from its stored odds — NOT a degraded or
  // stale read. Kept in the contract (both clients bind to it) even though every live market is now
  // book-backed; deprecate it on its own, not folded into an unrelated change.
  live: boolean;
}
export interface QuotesResponse {
  quotes: QuoteRow[];
}

// ─── GET /api/real/exit-quote?ids=<betId,...> ──────────────────────────────────────────────────
// Auth: Bearer + real consent (NOT eligibility — a restricted user may always value and leave a
// position). What the named REAL positions are worth if sold at market right now. Quoted off the
// same book walk, fee and pro-rata basis the sale itself books, so the number shown before a close
// is the number realized after it. A position with no live number (book unreachable, no bids,
// market no longer OPEN, remainder below one share tick) is simply ABSENT from `quotes` — the
// client shows nothing rather than a stale figure. Poll at most 1/s.
export interface ExitQuoteRow {
  betId: string;
  sharesMicro: string; // micro-shares this quote is for (the remainder, floored to a share tick)
  proceedsCents: number; // what the user RECEIVES after the platform fee, truncated to the cent
  pnlCents: number; // proceeds − the fee-inclusive cost basis of those shares; negative = a loss
  priceBp: number; // sell VWAP for the whole remainder, in bp (rounded down — payout side)
  partial: boolean; // the bids ran out: the numbers value only what the book can absorb today
}
export interface ExitQuotesResponse {
  quotes: ExitQuoteRow[];
}

// ─── GET /api/feed ─────────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The post-cap "лента": an endless, crypto-first stream of near-50% binary markets
// (all tiers), minus any the user already bet. Cursor-paginated for infinite scroll — pass the prior
// response's `nextCursor` as ?cursor= to get the next page; nextCursor is null when the pool is dry.
// Cards reuse the DeckCard shape verbatim (same fields). Betting here is points-FREE (shards uncapped).
export interface FeedResponse {
  cards: DeckCard[];
  nextCursor: string | null; // opaque cursor for the next page, or null at the end of the pool
}

// ─── POST /api/feed/bet ────────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: FeedBetRequest. Paper bet on a feed market — same $10 stake/cash-hold as a
// swipe, but NO points and NO daily cap (shards still accrue on a win, uncapped). NOT gated by the
// swipe cap (the feed is what you get AFTER the cap). Locks the side's EXECUTABLE price (live CLOB
// re-quote; a bookless source keeps its stored odds). Errors: 400 (bad body), 402 (insufficient
// Cash — { error: "insufficient_funds" }), 409 (market not open / already bet / market_expired /
// market_untradable — the book cannot fill the stake), 502 (book_unavailable — CLOB book missing
// or older than the freshness policy; retry, never a mid fallback).
export interface FeedBetRequest {
  marketId: string;
  side: BetSide;
  quotedPriceBp?: number; // seen-vs-executed guard — see SwipeRequest.quotedPriceBp
}
export interface FeedBetResponse {
  betId: string;
}

// ─── POST /api/swipe ───────────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: SwipeRequest. Paper bet Yes/No on a deck market; locks the bought side's
// EXECUTABLE price (live CLOB re-quote; a bookless source keeps its stored odds).
// Errors: 400 (bad body), 409 (market not open / already swiped this market / market_expired /
//         market_untradable — the book cannot fill the stake / price_moved — the live book moved
//         against the quote the client displayed; body carries { freshPriceBp } so the card can
//         re-render at the true price and wait for a deliberate re-swipe), 403 (daily cap reached),
//         402 (insufficient Cash for stake — body { error: "insufficient_funds" }),
//         502 (book_unavailable — CLOB book missing or older than the freshness policy).
export interface SwipeRequest {
  marketId: string;
  side: BetSide;
  // The price the user was actually LOOKING AT for `side` when they swiped (D10 Slice B). Optional:
  // a client that doesn't send it (an older build) locks the fresh executable price silently, which
  // is still strictly better than the mid it used to lock. When present, the server rejects with 409
  // { error: "price_moved", freshPriceBp } if the live book moved AGAINST the user beyond tolerance —
  // a move in their favour always executes.
  quotedPriceBp?: number;
}
export interface SwipeResponse {
  betId: string;
  pointsAwarded: 0 | 1; // 0 once over the daily cap for non-dev users
  overCap: boolean;
  swipeCountToday: number; // per-DAY count, not lifetime
}

// ─── POST /api/skip ────────────────────────────────────────────────────────────────────────────
// Auth: Bearer. No body. Always free + unlimited (product pivot — no shard cost). Advances the
// deck, makes no bet, bumps the daily skip counter. Always 200.
export type SkipResponse = { ok: true; skipsToday: number };

// ─── POST /api/recover ─────────────────────────────────────────────────────────────────────────
// Auth: Bearer. No body. Spend 1 artifact to revive a burned (recoverable) streak, resume at n+1.
// On HTTP 409 the body is the recovered:false variant (not recoverable / window expired / no artifact).
export interface RecoverResponse {
  recovered: boolean;
  reason?: "no_streak" | "not_recoverable" | "window_expired" | "no_artifact";
  currentLevel: number;
}

// ─── POST /api/topup ───────────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: { kind: "free" | "artifact" }. Credits +$200 Cash.
//   free     — once ever, low-cash gate.          409 (free_used / free_not_eligible).
//   artifact — spend 1 artifact, Cash < $50 gate. 402 (no_artifact) / 409 (cash_too_high).
export type TopupResponse =
  | { ok: true; kind: "free" | "artifact"; grantedCents: number; balanceCents: number }
  | {
      ok: false;
      reason: "free_used" | "free_not_eligible" | "no_artifact" | "cash_too_high";
    };

// ─── POST /api/login-mark ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. Optional query ?ref=<referralCode> (captured once, on first ever call). The daily
// GM tap: login bonus + streak day qualification.
export interface LoginMarkResponse {
  login: { awarded: boolean; amount: number };
  streak: { qualifiedToday: boolean; level: number; state: StreakState };
}

// ─── GET /api/history ──────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The user's bets + market info. PENDING first, then settled by recency.
export interface HistoryRow {
  id: string;
  marketId: string; // an EXIT is placed against the market — the sheet's Close button needs it
  question: string;
  category: string | null; // server-derived, see DeckCard.category
  league?: string | null; // server-derived, see DeckCard.league — the sport a row names in its subtitle
  sideLabel: string; // the label of the side the user bet (team / Over / Up / Yes)
  side: BetSide; // drives badge color
  stakeCents: number;
  lockedPriceBp: number;
  status: BetStatus;
  pnlCents: number | null; // null while PENDING
  // ISO-8601. For a MATCH this is Gamma's endDate, which equals KICK-OFF (measured 2026-08-19 over
  // 172 live sport markets: endDate === gameStartTime on every one) — the market then trades in-play
  // and resolves hours later. Compare with startsAt before calling it a resolution time.
  resolutionDeadline: string;
  startsAt?: string | null; // ISO-8601 kick-off; null for crypto/Yes-No, which have no game
  createdAt: string; // ISO-8601
  settledAt?: string | null; // ISO-8601; null while the bet is still PENDING
  // REAL positions only: there is a remainder the signer can actually sell (it works in 4-decimal
  // shares, so a sub-tick remnant is unsellable and must not be offered as closable).
  closable?: boolean;
}
export interface HistoryResponse {
  rows: HistoryRow[];
  pendingCount: number;
  nextCursor: string | null; // opaque; pass back as ?cursor= for the next page; null = no more
}

// ─── GET /api/results ──────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The user's SETTLED/VOID bets, newest first. Feeds BOTH the inbox list and the
// results reveal (reveal = the subset with seen=false). One settled bet = one row.
export interface ResultRow {
  id: string;
  question: string;
  category: string | null; // server-derived, see DeckCard.category
  league?: string | null; // server-derived, see DeckCard.league
  side: BetSide;
  sideLabel: string; // label of the side the user bet (team / Over / Up / Yes)
  status: "WIN" | "LOSS" | "PUSH";
  outcome: string; // human-readable resolved outcome, e.g. "Resolved YES" — built from data, no LLM
  pnlCents: number; // settled P&L (negative on a loss, 0 on push)
  deltaCents: number; // alias of pnlCents — the balance delta this result applied
  shards: number; // shards granted for this bet (0 or 1)
  // What the call COST, so a settled row can be opened and read like an open one: the two lists
  // share a component, and the expanded detail is the same detail in both.
  stakeCents: number;
  lockedPriceBp: number;
  createdAt: string; // ISO-8601 — when the call was made
  settledAt: string; // ISO-8601
  seen: boolean; // seenAt != null
  // DEPRECATED (2026-08-03). Marked a settlement made on Solana-anchored data — only ever true for
  // the TxOdds World Cup integration, which is gone. The server now always sends false/null and no
  // client renders anything for them, so the badge has already disappeared everywhere, including
  // Android builds already in the wild. Kept in the shape because removing a field in place is a
  // breaking change (see RULES at the top) and mobile does not deploy with the server. Retire them
  // in a v2, or reuse them if a verifiable source ever returns.
  verified?: boolean;
  onchainRef?: string | null;
}
export interface ResultsResponse {
  rows: ResultRow[];
  unreadCount: number;
  nextCursor: string | null; // opaque; pass back as ?cursor= for the next page; null = no more
  stockAlerts?: StockAlertRow[]; // stock profit alerts (optional: older servers omit, older clients ignore)
}

// ─── Stock profit alerts — ride the results inbox (Stocklana) ─────────────────────────────────────
// One row per OPEN tokenized-stock lot that crossed a profit tier (+2/+5/+10% of cost). Not a settled
// result: nothing is booked and the reveal never plays it — it is a nudge. pnl* are LIVE at read time
// (stored asset price); tierBp is what fired. Both modes are returned (stock alerts do not follow the
// Polymarket real-mode switch); `mode` labels each row.
export interface StockAlertRow { positionId: string; symbol: string; name: string; logoUrl: string | null; mode: "PAPER" | "REAL"; tierBp: number; pnlCents: number; pnlBp: number; costCents: number; alertedAt: string; seen: boolean }
// POST /api/results/seen body (optional). NO body = bets only (what the shipped mobile client sends).
// `stockAlerts` acknowledges exactly the (positionId, tierBp) pairs the client displayed — a tier that
// fired after the client loaded is left unread.
export interface SeenRequest { scope?: "bets" | "stocks" | "both"; stockAlerts?: { positionId: string; tierBp: number }[] }

// ─── POST /api/results/seen ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. No body. Marks ALL of the user's unseen settled results as seen (idempotent —
// only seenAt IS NULL rows are touched). Called when the reveal is dismissed or the inbox is opened.
export interface SeenResponse {
  markedSeen: number; // bets marked seen (unchanged meaning)
  markedStockAlertsSeen: number; // stock alert pairs acknowledged (0 unless the body listed them)
}

// ─── GET /api/me ───────────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The account snapshot — the client's primary state source. Numbers are server-
// computed (points multiplier applied, caps/costs included) so the client renders, never derives,
// the economy. weekday fields are 0=Mon..6=Sun.
export interface MeResponse {
  // authProvider = how the user signed up. The client gates "Unlink X" on it (a TWITTER-signup user
  // can't unlink X — it's their login). twitter = the linked @handle: set at signup (TWITTER) or
  // later via /api/link/sync (an EMAIL user who linked X).
  user: { id: string; email: string | null; twitter: string | null; authProvider: AuthProvider; referralCode: string };
  balanceCents: number; // total = cashCents + lockedCents
  cashCents: number; // spendable now (balance − Σ pending stakes)
  lockedCents: number; // Σ stakes of still-PENDING bets ("in play")
  stakeCents: number; // cost of one swipe (so the client gates cash >= stake without hardcoding)
  topup: {
    freeTopupUsed: boolean; // lifetime free top-up consumed
    freeTopupAvailable: boolean; // free path enabled (low-cash gate met)
    artifactTopupAvailable: boolean; // holds >=1 artifact AND Cash below the gate
    grantCents: number; // +Cash per top-up
    artifactCost: number; // artifacts per paid top-up
    artifactCashGateCents: number; // artifact top-up disabled once Cash >= this (client renders the $ hint)
  };
  points: { total: number; breakdown: Record<PointsType, number>; bonusFromX2: number };
  swipes: { used: number; cap: number };
  skips: { usedToday: number; nextIsFree: boolean; shardCost: number };
  dev: boolean; // dev test account: unlimited skips + deck reset
  shards: number;
  artifacts: number;
  shardsPerArtifact: number; // shards needed to forge 1 artifact (so clients don't hardcode it)
  // Card-skins cosmetics. `owned` = skin ids the user has (always includes "classic"); `equipped` =
  // the id applied to every deck card. Catalog (cost/name/look) is client-side (src/lib/skins.ts).
  skins: { owned: string[]; equipped: string };
  streak: {
    level: number;
    state: StreakState;
    recoverableUntil: string | null; // ISO-8601, null unless BURNED_RECOVERABLE
    todayWeekday: number; // 0=Mon..6=Sun — which GM-grid column is today
    windowStartWeekday: number; // 0=Mon..6=Sun — where this user's 7-day window starts
  };
  // Everything the Paper/Real switch in the profile needs, and nothing that costs an RPC call:
  // /api/me is read on every screen, so the on-chain pUSD balance deliberately lives on the real
  // screen's own endpoints instead. `termsVersion` is the CURRENT text; when it differs from
  // `consentVersion` the user has agreed to something older and must accept again before real mode
  // will turn on, which is the whole reason the version is stored at all.
  real: {
    consentAt: string | null; // ISO-8601 — when they accepted, null if never
    consentVersion: string | null; // which text they accepted
    termsVersion: string; // which text they would be shown now
    mode: "PAPER" | "REAL"; // which economy the app is currently rendering
    depositWallet: string | null; // provisioned Polymarket deposit wallet, null until setup runs
    stakeCents: number; // what ONE real swipe spends — the user's own setting, not the paper stake
    minStakeCents: number; // the floor the UI must not let them go under
    maxStakeCents: number; // fat-finger ceiling
  };
  loginMarkedToday: boolean;
  unreadResults: number; // settled bets the user hasn't seen yet (seenAt IS NULL) — drives the HUD bell
  referrals: { joined: number; pointsEarned: number }; // invitees bound + REFERRAL points earned from them (invite screen)
  // True for a brand-new account that has never started a streak and hasn't checked in today. The
  // client skips the GM/reveal open ritual for new users — straight to the deck so they feel the
  // core loop first. Derived (streak.level===0 && !loginMarkedToday), no extra query.
  isNewUser: boolean;
  // Open tokenized-stock lots with an unseen profit tier, BOTH modes — the bell adds it to
  // unreadResults. Optional so a stale client never sees a phantom badge.
  unreadStockAlerts?: number;
}

// ─── POST /api/skins ─────────────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: { action: "unlock" | "equip", skinId }. unlock spends `skinById(id).cost`
// artifacts (then auto-equips); equip just switches (no cost, must already own). Returns the fresh
// owned/equipped/artifacts so the client repaints without a second /api/me round-trip.
// Errors: 400 bad action/id · 402 not enough artifacts · 409 already owned (unlock) / not owned (equip).
export interface SkinActionResponse {
  owned: string[];
  equipped: string;
  artifacts: number;
}

// ─── POST /api/capture-ref ───────────────────────────────────────────────────────────────────────
// Auth: Bearer. Optional query ?ref=<referralCode>. Captures the referral (cookie code or IP/UA
// device match) and accrues the inviter's share — WITHOUT marking the GM day. Sent on app open so
// attribution survives even when the user doesn't tap GM. Idempotent (capture binds once).
export interface CaptureRefResponse {
  captured: boolean; // true if a referral was bound on this call (false if already bound / no code)
}

// ─── GET /api/admin/leaderboard ──────────────────────────────────────────────────────────────────
// Auth: Bearer + ADMIN_EMAILS allowlist. 401 (no/invalid token), 403 (authed but not admin).
// PRIVATE admin growth tool — returns PII (twitter handle, activity). Never cached/indexed; email
// is intentionally NOT in the payload. One payload carries all 3 windows so the client does
// windowing/sort/filter with zero refetch.
export interface AdminLeaderboardRow {
  userId: string;
  handle: string; // twitterHandle ?? `user_<id6>`
  twitterHandle: string | null;
  hasTwitter: boolean;
  pointsAll: number;
  pointsWeek: number; // last 7 days incl. today (windowed multiplier is approximate — see route)
  pointsToday: number;
  streakLevel: number;
  lastActive: string | null; // ISO-8601, derived (max of lastSeenAt / latest ledger / createdAt)
  rank: number; // canonical rank by all-time points
}
export interface AdminLeaderboardResponse {
  rows: AdminLeaderboardRow[];
  generatedAt: string; // ISO-8601
}

// ─── HEDGE ENGINE (phase 2, workstream A) ────────────────────────────────────────────────────────
// The S1 wallet-hedge surface. Suggestions are DETERMINISTIC and re-derivable server-side (D1 — no
// LLM in the loop), settle as standard paper Bet rows through the existing poller (D6), and carry a
// VARIABLE stake (D8). Every shape here is the contract the web + Android clients render.

// Which hedge a suggestion is. "S1-major" = a direct hedge on a major holding (SOL / wrapped BTC or
// ETH). "S1-proxy" = the long-tail SPL aggregate hedged via a SOL short (BASIS RISK — the client MUST
// label it a proxy, never a hedge). "S2" = a life-event hedge (bet AGAINST a team you support).
// "fallback" = a discovery card (NOT a hedge — client MUST label it discovery; see isDiscovery).
// "S1-stock" = a tokenized-stock leg sized off wallet exposure; "S3-stock" = a life-situation
// (flights/fuel/rent…) → tokenized stock; "spotted" = a live 24h move fired a rule's trigger (no
// user input needed).
export type HedgeSuggestionKind = "S1-major" | "S1-proxy" | "S2" | "fallback" | "S1-stock" | "S3-stock" | "spotted";

// ─── POST /api/hedge/wallet ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: HedgeWalletRequest. Validates the base58 Solana address, links it (read-only —
// keys are NEVER requested), builds/refreshes the cached WalletSnapshot, and returns the exposure
// summary. Errors: 400 (missing/invalid base58 address), 502 (balances/prices upstream unavailable —
// { error: "exposure_unavailable" }).
export interface HedgeWalletRequest {
  address: string; // base58 Solana address
}
export interface HedgeExposureAsset {
  asset: string; // "SOL" | "BTC" | "ETH" for majors; token symbol / short mint for SPL
  mint: string | null; // null = native SOL
  amount: string; // UI token amount as a decimal STRING (avoids float drift on the wire)
  notionalCents: number; // current USD value (D3 = market value), integer cents
  isMajor: boolean; // directly hedgeable (SOL / wrapped BTC / wrapped ETH)
  avgBuyCostCents: number | null; // Birdeye avg buy cost per token; null when unavailable (graceful)
}
export interface HedgeWalletResponse {
  address: string;
  totalNotionalCents: number;
  majors: HedgeExposureAsset[]; // SOL / BTC / ETH exposure, biggest first
  splAggregateCents: number; // Σ long-tail SPL notional (the proxy-hedge basis)
  snapshotFetchedAt: string; // ISO-8601 (cache freshness)
  pnlAvailable: boolean; // false => Birdeye degraded => no avg-cost narrative lines
  // true => the address is one of the caller's Privy-LINKED Solana wallets (it signed Privy's
  // challenge). A pasted address is false. Only a verified wallet is offered as a withdraw
  // destination (GET /api/real/withdraw `connected.solana`).
  verified: boolean;
}

// ─── GET /api/hedge/wallet ─────────────────────────────────────────────────────────────────────────
// Auth: Bearer. Returning-user state (F18a): the caller's linked-wallet status + the CACHED exposure
// summary of their primary (most-recently-linked) wallet, so a returning user sees their exposure panel
// without re-pasting the address. CACHE-ONLY — never triggers a Helius/Jupiter/Birdeye call: when no
// snapshot has been built yet `exposure` is null and `stale` is true. `stale` is also true when the
// cached snapshot is older than the freshness window (the client may offer a refresh). Never errors on
// upstream outage (it does no upstream work); the paste form stays reachable regardless.
export interface HedgeWalletStateResponse {
  walletLinked: boolean; // true => the caller has at least one linked wallet
  exposure: HedgeWalletResponse | null; // primary wallet's CACHED summary; null when unlinked or never snapshotted
  stale: boolean; // true => exposure is null OR its snapshot is past the freshness window (offer a refresh)
}

// ─── GET /api/hedge/suggestions ──────────────────────────────────────────────────────────────────
// Auth: Bearer. Deterministic S1 suggestions for the caller's linked wallet(s). Each card reuses the
// DeckCard field family + hedge metadata. `suggestionId` is a stable content hash (re-derivable) so
// POST /accept is idempotent. `walletLinked` is false when the user has linked no wallet yet.
// Price semantics (D10 follow-up): yesPriceBp/noPriceBp are the live CLOB VWAP at the card's OWN
// proposedStakeCents — the exact quote /accept honours — never the Gamma mid; a market that won't
// quote both sides at that stake is dropped rather than shown at an approximated price.
// A tokenized stock behind a hedge card (Stocklana). When `stock` is set on a HedgeSuggestion the
// DeckCard fields are SENTINELS (id "stock:<SYMBOL>", prices 0, deadline "") — render off `stock`,
// never off the market fields.
export interface HedgeStockRef { symbol: string; name: string; mint: string; logoUrl: string | null; priceCents: number; change24hBp: number | null; tradable: boolean }
// The parsed life situation a stock card answers (persisted per user+category, no raw text).
export interface HedgeSituation { category: string; amountCents: number | null; period: "month" | "week" | "year" | "once" | null; distanceKm: number | null }
export interface HedgeSuggestion extends DeckCard {
  suggestionId: string; // deterministic; pass to /accept and /event
  kind: HedgeSuggestionKind; // "S1-major" | "S1-proxy" | "S2" | "fallback"
  side: BetSide; // the side that hedges the holding (benefits if the price falls)
  sideLabel: string; // display label of that side (e.g. "No")
  proposedStakeCents: number; // sized 5–10% majors / ~3% SPL-proxy, clamped (D8); fixed for S2/fallback. For S1 the card's prices are quoted at THIS stake; S2/fallback prices are the persisted eff VWAP at the fixed $10 stake
  hedgedAsset: string; // "SOL" | "BTC" | "ETH" ("SOL" is the shorting instrument for a proxy); "" for S2/fallback
  hedgedNotionalCents: number; // the exposure being hedged; 0 for S2/fallback (no position notional)
  isProxy: boolean; // true => S1-proxy => UI must show the basis-risk / "proxy, not a hedge" label
  avgBuyCostNarrative: string | null; // "You bought SOL at ~$X" — null when Birdeye unavailable / non-S1
  // ── S2 / fallback extras (optional; absent/neutral on S1 so stale clients stay compatible) ──
  isDiscovery?: boolean; // true => a fallback discovery card, NOT a hedge (client MUST label it so)
  matchedEntity?: string | null; // the team/entity the user supports (we bet AGAINST it); null on fallback
  league?: string | null; // league/competition label for an S2 card (e.g. "NBA"); null if unknown/non-S2
  matchConfidence?: number; // 0..1 free-text match confidence (S2 search only; omitted on accept re-derivation)
  // ── Stock-card extras (present only when `stock` is set) ──
  stock?: HedgeStockRef; // the tokenized stock behind this card; when set, render off THIS, not the market fields
  rationale?: string; // server-rendered one-liner (also mirrored into `question` for legacy clients)
  hedgePctBp?: number; // the product rule applied, 0 ⇒ fixed life-hedge stake
  situation?: HedgeSituation; // the parsed life situation this card answers
  triggerChangeBp?: number; // spotted only — the 24h move that fired the rule
}
export interface HedgeSuggestionsResponse {
  suggestions: HedgeSuggestion[];
  walletLinked: boolean; // false => prompt the user to link a wallet first
  stockSuggestions?: HedgeSuggestion[]; // S1-stock legs (additive; old clients ignore)
}

// ─── GET /api/hedge/pickers ────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The PRIMARY S2 UX (spec §2): structured team/league pickers built from Polymarket's
// own sports/esports metadata, restricted to entities that actually have an OPEN, upcoming market
// (so a pick always resolves to a live hedge). Churns with the poller cadence (never a static list);
// server-side in-process TTL cache keeps it cheap. `teams` are the side labels under that league.
export interface HedgePickerLeague {
  slug: string; // "nba" | "cs2" | "soccer" ... (stable grouping key)
  label: string; // display label ("NBA", "CS2")
  teams: string[]; // distinct team/entity labels with an open market, sorted
}
export interface HedgePickersResponse {
  leagues: HedgePickerLeague[];
}

// ─── POST /api/hedge/search ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: HedgeSearchRequest. The SECONDARY S2 UX: free text ("я болею за Реал", "иду на
// фильм X") -> deterministic alias/FTS match -> (below threshold + NLU_API_KEY set) ONE NLU
// call -> re-run -> still nothing => discovery fallback. A team you SUPPORT yields an AGAINST
// suggestion on its nearest upcoming market. `isDiscovery` is true ONLY on the fallback (3 random
// contested markets, honestly flagged as discovery, never a hedge). Errors: 400 (empty / too-long text).
export interface HedgeSearchRequest {
  text: string; // free text; trimmed, max 200 chars
  amountCents?: number; // optional stated amount (a chip's amount field); an amount inside the text wins
}
export interface HedgeSearchResponse {
  suggestions: HedgeSuggestion[]; // S2 against-hedges (isDiscovery=false) OR fallback cards (isDiscovery=true)
  isDiscovery: boolean; // true => the fallback discovery path; the client MUST label the cards discovery
  matchedEntity: string | null; // the entity we matched the text to (null on fallback)
  usedNlu: boolean; // true => the NLU edge was invoked (below-threshold + key present)
  stockSuggestions?: HedgeSuggestion[]; // S3-stock cards (additive; old clients ignore)
  situation?: HedgeSituation | null; // the parsed life situation, echoed back for the client
}

// ─── POST /api/hedge/accept ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: HedgeAcceptRequest. Re-derives the suggestion server-side from the id (never
// trusts client market/side/stake), then creates a STANDARD paper Bet with the variable stake,
// locking it against Cash exactly like a swipe (atomic guard). The locked price is the side's
// EXECUTABLE price (live CLOB re-quote for Polymarket). Idempotent: re-accepting the same
// suggestion returns the existing bet (alreadyAccepted:true). Errors: 400 (bad body), 402
// (insufficient Cash — { error: "insufficient_funds" }), 404 (suggestion not found / stale — client
// should refetch suggestions), 409 (market not open / already bet this market / market_untradable),
// 502 (book_unavailable — CLOB book missing or too stale to lock against).
export interface HedgeAcceptRequest {
  suggestionId: string;
}
export interface HedgeAcceptResponse {
  betId: string | null; // null on a stock accept (see positionId)
  stakeCents: number; // the ACTUAL locked stake (may be clamped down to available Cash)
  alreadyAccepted: boolean; // true => idempotent replay, returns the pre-existing bet
  positionId?: string; // the StockPosition created by a stock accept
}

// ─── POST /api/hedge/event ───────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: HedgeEventRequest. Suggestion telemetry (impression / dismiss; accept is
// recorded by /accept). Idempotent per (user, suggestion, event). Errors: 400 (bad body), 404
// (suggestion not derivable for the user's wallet — stale).
export interface HedgeEventRequest {
  suggestionId: string;
  event: "impression" | "dismiss";
}
export interface HedgeEventResponse {
  ok: true;
}

// ─── GET /api/hedge/spotted ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. Proactive cards from live 24h moves — no wallet needed. One card per firing rule,
// capped at HEDGE_SPOTTED_MAX, sized off the user's persisted LifeSituation row for that category
// when present (else the fixed life-hedge stake). `generatedAt` is ISO-8601.
export interface HedgeSpottedResponse { suggestions: HedgeSuggestion[]; generatedAt: string }

// ─── STOCKS (xStocks on Solana — Stocklana) ────────────────────────────────────────────────────
// A tokenized stock card is NOT a DeckCard: it has no YES/NO, never resolves, and its price is spot.
// Right swipe = BUY (paper from the virtual balance, or REAL via the user's own Phantom + Jupiter),
// left = PASS (never dealt again), up = skip (session only). qtyBase is a decimal STRING on the wire
// (raw base units, BigInt server-side). Prices are integer cents per RAW token; uiMultiplierMicro
// (Token-2022 ScaledUiAmount × 1e6) is for DISPLAY only so shown quantities match the wallet.

// ─── GET /api/stocks/deck ────  Auth: Bearer. Deck-eligible assets with a fresh price, minus the
// caller's open positions and passes, shuffled. `wallets` = the caller's VERIFIED Solana addresses
// (gates "Buy on Solana"); `stockConsent` = the caller accepted the current xStocks terms.
// `tradable` = the mint has a Solana pool deep enough for a small REAL buy; false = paper only (the
// price is the issuer's reference price) and the client must not offer "Buy on Solana".
export interface StockDeckCard { id: string; symbol: string; name: string; underlying: string; logoUrl: string | null; mint: string; priceCents: number; change24hBp: number | null; uiMultiplierMicro: number | null; tradingHours: string | null; openNow: boolean; tradable: boolean; pricedAt: string }
export interface StockDeckResponse { cards: StockDeckCard[]; wallets: string[]; stockConsent: boolean }
// ─── POST /api/stocks/buy ────  Auth: Bearer. Body: StockBuyRequest. PAPER buy: locks the live price
// server-side, holds stakeCents against Cash (atomic, like a swipe). requestId (client uuid) makes a
// retry return the same lot (alreadyBought:true). Errors: 400 (bounds/uuid), 404 asset_not_found,
// 409 asset_halted | stake_too_small, 402 insufficient_funds, 502 price_unavailable.
export interface StockBuyRequest { assetId: string; stakeCents: number; requestId: string }
export interface StockBuyResponse { positionId: string; qtyBase: string; priceCents: number; costCents: number; alreadyBought: boolean }
// ─── POST /api/stocks/sell ────  Auth: Bearer. PAPER only: closes the lot at the live price, credits
// P&L, releases the hold. Errors: 404 position_not_found, 409 already_closed, 502 price_unavailable.
export interface StockSellRequest { positionId: string }
export interface StockSellResponse { positionId: string; proceedsCents: number; pnlCents: number; priceCents: number }
// ─── POST /api/stocks/pass ────  Auth: Bearer. Idempotent. Errors: 404 asset_not_found.
export interface StockPassRequest { assetId: string }
export type StockPassResponse = { ok: true };
// ─── GET /api/stocks/portfolio ────  Auth: Bearer. Open + recent closed lots, both modes, priced from
// the STORED asset price (refreshed every poller tick; `fresh` false when older than the staleness
// bound). REAL lots are reconciled against the payer's live wallet balance at most every few hours.
export interface StockPositionRow { id: string; assetId: string; symbol: string; name: string; logoUrl: string | null; mode: "PAPER" | "REAL"; source: "DECK" | "HEDGE"; qtyBase: string; decimals: number; uiMultiplierMicro: number | null; costCents: number; entryPriceCents: number; priceCents: number | null; valueCents: number | null; pnlCents: number | null; fresh: boolean; txSig: string | null; payer: string | null; createdAt: string; closedAt: string | null; closeReason: string | null; proceedsCents: number | null }
export interface StockTotals { costCents: number; valueCents: number; pnlCents: number }
export interface StockPendingAttempt { id: string; symbol: string; stakeCents: number; status: "PENDING" | "CONFIRMED" | "EXPIRED" | "FAILED"; sig: string | null; createdAt: string }
export interface StockPortfolioResponse { open: StockPositionRow[]; closed: StockPositionRow[]; totals: { paper: StockTotals; real: StockTotals }; wallets: string[]; stockConsent: boolean; pendingAttempts: StockPendingAttempt[] }
// ─── POST /api/stocks/consent ────  Auth: Bearer. Records acceptance of the xStocks terms +
// self-declaration (not a US person / not in a restricted jurisdiction) at `version`.
export interface StockConsentRequest { version: number }
export type StockConsentResponse = { ok: true; version: number };
// ─── POST /api/stocks/real/tx ────  Auth: Bearer. Builds a Jupiter USDC→xStock swap for the caller's
// VERIFIED wallet `payer` and records a StockBuyAttempt. Nothing is spent here. Errors: 400, 403
// stock_consent_required | wallet_not_verified, 404 asset_not_found, 409 asset_halted | price_impact,
// 502 swap_unavailable.
// `assetId` OR `symbol` names the asset (a hedge card knows only the symbol).
export interface StockRealTxRequest { assetId?: string; symbol?: string; stakeCents: number; payer: string; hedgeSuggestionId?: string }
export interface StockRealTxResponse { attemptId: string; swapTransaction: string; lastValidBlockHeight: number; payer: string; quote: { inAmountMicro: string; outAmountBase: string; minOutBase: string; priceImpactBp: number } }
// ─── POST /api/stocks/real/sent ────  Auth: Bearer. Stamps the signature on the attempt as soon as
// the wallet has sent it, so the poller can recover a buy whose tab died before /confirm.
export interface StockRealSentRequest { attemptId: string; sig: string }
export type StockRealSentResponse = { ok: true };
// ─── POST /api/stocks/real/confirm ────  Auth: Bearer. Reads the landed tx from the chain and books
// the lot ONLY if it matches the attempt (payer, mint, ExactIn amount, minimum output). Idempotent by
// signature. Errors: 400, 403 (not the caller's attempt/tx), 404 tx_not_found (retry), 409 tx_failed |
// not_this_buy | attempt_expired, 502 rpc_unavailable.
export interface StockRealConfirmRequest { attemptId: string; sig: string }
export interface StockRealConfirmResponse { positionId: string; qtyBase: string; costCents: number; alreadyConfirmed: boolean }
