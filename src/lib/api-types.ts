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
  category: string | null;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
  yesPriceBp: number; // basis points (5150 = 51.5¢). Sides need NOT sum to 10000 (real spread).
  noPriceBp: number;
  resolutionDeadline: string; // ISO-8601
}
export interface DeckResponse {
  cards: DeckCard[];
}

// ─── GET /api/football/ticker ──────────────────────────────────────────────────────────────────
// Auth: Bearer. Live World Cup ticker rows from TxLine (server-cached, read-only display). Ordered
// live first, then upcoming (nearest kickoff), then recently ended. homeGoals/awayGoals null pre-match;
// over25Pct = demarginalized Over-2.5-goals probability % (null if not offered / quarter line);
// homeWinPct/awayWinPct = demarginalized 1X2 win probability % (null if not offered); phase:
// "1H" | "HT" | "2H" | "FT" | "" (upcoming).
export interface TickerRow {
  fixtureId: string;
  competition: string;
  home: string;
  away: string;
  homeGoals: number | null;
  awayGoals: number | null;
  live: boolean;
  ended: boolean;
  phase: string;
  kickoff: string; // ISO-8601
  over25Pct: number | null;
  homeWinPct: number | null;
  awayWinPct: number | null;
}
export interface TickerResponse {
  rows: TickerRow[];
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
// swipe cap (the feed is what you get AFTER the cap). Errors: 400 (bad body), 402 (insufficient Cash —
// { error: "insufficient_funds" }), 409 (market not open / already bet / market_expired).
export interface FeedBetRequest {
  marketId: string;
  side: BetSide;
}
export interface FeedBetResponse {
  betId: string;
}

// ─── GET /api/football/match ─────────────────────────────────────────────────────────────────────
// Auth: Bearer. Query ?fixtureId=<id>. The relevant binary markets for ONE World Cup fixture —
// "{team} to win?" (from 1X2) + Over/Under total goals (1.5/2.5/3.5) — read from the cached TXODDS
// Market rows (the same store the deck/feed read; NOT band-filtered, so favorites show too). Cards
// reuse DeckCard; placedSide = the side the user already bet on that market (null if none), so the
// detail view shows it locked. Bet via POST /api/feed/bet (these are ordinary Market rows). Empty
// cards = no odds offered for this fixture yet (O/U coverage is bursty). 400 if fixtureId is missing.
export interface FootballMarketCard extends DeckCard {
  placedSide?: BetSide | null;
}
export interface FootballMatchResponse {
  cards: FootballMarketCard[];
}

// ─── POST /api/swipe ───────────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: SwipeRequest. Paper bet Yes/No on a deck market; locks the bought side's price.
// Errors: 400 (bad body), 409 (market not open / already swiped this market), 403 (daily cap reached),
//         402 (insufficient Cash for stake — body { error: "insufficient_funds" }).
export interface SwipeRequest {
  marketId: string;
  side: BetSide;
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
  question: string;
  sideLabel: string; // the label of the side the user bet (team / Over / Up / Yes)
  side: BetSide; // drives badge color
  stakeCents: number;
  lockedPriceBp: number;
  status: BetStatus;
  pnlCents: number | null; // null while PENDING
  resolutionDeadline: string; // ISO-8601
  createdAt: string; // ISO-8601
}
export interface HistoryResponse {
  rows: HistoryRow[];
  pendingCount: number;
}

// ─── GET /api/results ──────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The user's SETTLED/VOID bets, newest first. Feeds BOTH the inbox list and the
// results reveal (reveal = the subset with seen=false). One settled bet = one row.
export interface ResultRow {
  id: string;
  question: string;
  category: string | null;
  side: BetSide;
  sideLabel: string; // label of the side the user bet (team / Over / Up / Yes)
  status: "WIN" | "LOSS" | "PUSH";
  outcome: string; // human-readable resolved outcome, e.g. "Resolved YES" — built from data, no LLM
  pnlCents: number; // settled P&L (negative on a loss, 0 on push)
  deltaCents: number; // alias of pnlCents — the balance delta this result applied
  shards: number; // shards granted for this bet (0 or 1)
  settledAt: string; // ISO-8601
  seen: boolean; // seenAt != null
  // Verifiable settlement: true when the bet settled on Solana-anchored data (TxLINE World Cup —
  // scores are committed to a Solana Merkle root). Absent/false for Polymarket. onchainRef = Solscan
  // link. Optional (additive field) so stale clients / older RN builds stay forward-compatible.
  verified?: boolean;
  onchainRef?: string | null;
}
export interface ResultsResponse {
  rows: ResultRow[];
  unreadCount: number;
}

// ─── POST /api/results/seen ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. No body. Marks ALL of the user's unseen settled results as seen (idempotent —
// only seenAt IS NULL rows are touched). Called when the reveal is dismissed or the inbox is opened.
export interface SeenResponse {
  markedSeen: number;
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
  loginMarkedToday: boolean;
  unreadResults: number; // settled bets the user hasn't seen yet (seenAt IS NULL) — drives the HUD bell
  referrals: { joined: number; pointsEarned: number }; // invitees bound + REFERRAL points earned from them (invite screen)
  // True for a brand-new account that has never started a streak and hasn't checked in today. The
  // client skips the GM/reveal open ritual for new users — straight to the deck so they feel the
  // core loop first. Derived (streak.level===0 && !loginMarkedToday), no extra query.
  isNewUser: boolean;
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
// label it a proxy, never a hedge). (S2 / life-event kinds arrive in a later packet.)
export type HedgeSuggestionKind = "S1-major" | "S1-proxy";

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
}

// ─── GET /api/hedge/suggestions ──────────────────────────────────────────────────────────────────
// Auth: Bearer. Deterministic S1 suggestions for the caller's linked wallet(s). Each card reuses the
// DeckCard field family + hedge metadata. `suggestionId` is a stable content hash (re-derivable) so
// POST /accept is idempotent. `walletLinked` is false when the user has linked no wallet yet.
export interface HedgeSuggestion extends DeckCard {
  suggestionId: string; // deterministic; pass to /accept and /event
  kind: HedgeSuggestionKind; // "S1-major" | "S1-proxy"
  side: BetSide; // the side that hedges the holding (benefits if the price falls)
  sideLabel: string; // display label of that side (e.g. "No")
  proposedStakeCents: number; // sized 5–10% majors / ~3% SPL-proxy, clamped (D8)
  hedgedAsset: string; // "SOL" | "BTC" | "ETH" ("SOL" is the shorting instrument for a proxy)
  hedgedNotionalCents: number; // the exposure being hedged
  isProxy: boolean; // true => S1-proxy => UI must show the basis-risk / "proxy, not a hedge" label
  avgBuyCostNarrative: string | null; // "You bought SOL at ~$X" — null when Birdeye unavailable
}
export interface HedgeSuggestionsResponse {
  suggestions: HedgeSuggestion[];
  walletLinked: boolean; // false => prompt the user to link a wallet first
}

// ─── POST /api/hedge/accept ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: HedgeAcceptRequest. Re-derives the suggestion server-side from the id (never
// trusts client market/side/stake), then creates a STANDARD paper Bet with the variable stake,
// locking it against Cash exactly like a swipe (atomic guard). Idempotent: re-accepting the same
// suggestion returns the existing bet (alreadyAccepted:true). Errors: 400 (bad body), 402
// (insufficient Cash — { error: "insufficient_funds" }), 404 (suggestion not found / stale — client
// should refetch suggestions), 409 (market not open / already bet this market).
export interface HedgeAcceptRequest {
  suggestionId: string;
}
export interface HedgeAcceptResponse {
  betId: string;
  stakeCents: number; // the ACTUAL locked stake (may be clamped down to available Cash)
  alreadyAccepted: boolean; // true => idempotent replay, returns the pre-existing bet
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
