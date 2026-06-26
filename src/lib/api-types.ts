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
export type StreakState = "ACTIVE" | "BURNED_RECOVERABLE" | "LOST";
export type PointsType = "SWIPE" | "LOGIN" | "REFERRAL" | "STREAK_X2";
export type BetStatus = "PENDING" | "WIN" | "LOSS" | "PUSH";

// Every route returns this on a missing/invalid Bearer token (HTTP 401). Other 4xx use the same
// `{ error }` shape (see per-route notes below).
export interface ErrorResponse {
  error: string;
}

// ─── GET /api/deck ───────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The blitz deck — OPEN markets resolving within 48h, category-mixed, minus cards
// the user already swiped. ISO-8601 string for resolutionDeadline (JSON has no Date).
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

// ─── POST /api/swipe ───────────────────────────────────────────────────────────────────────────
// Auth: Bearer. Body: SwipeRequest. Paper bet Yes/No on a deck market; locks the bought side's price.
// Errors: 400 (bad body), 409 (market not open / already swiped this market), 403 (daily cap reached).
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
// Auth: Bearer. No body. First skip/day free, each next costs 1 shard. Advances the deck, no bet.
// On HTTP 402 the body is the ok:false variant (paid skip needed, no shards).
export type SkipResponse =
  | { ok: true; free: boolean; shardsSpent: number; skipsToday: number; shards: number }
  | { ok: false; reason: "no_shards"; shards: number };

// ─── POST /api/recover ─────────────────────────────────────────────────────────────────────────
// Auth: Bearer. No body. Spend 1 artifact to revive a burned (recoverable) streak, resume at n+1.
// On HTTP 409 the body is the recovered:false variant (not recoverable / window expired / no artifact).
export interface RecoverResponse {
  recovered: boolean;
  reason?: "no_streak" | "not_recoverable" | "window_expired" | "no_artifact";
  currentLevel: number;
}

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

// ─── GET /api/leaderboard ──────────────────────────────────────────────────────────────────────
// Auth: Bearer. Top-100 by effective (multiplier-applied) points + the caller's own rank.
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  handle: string; // twitter handle, else `user_<id6>`
  points: number;
}
export interface LeaderboardResponse {
  top: LeaderboardEntry[];
  me: { rank: number | null; points: number }; // rank null if the caller has no points yet
}

// ─── GET /api/me ───────────────────────────────────────────────────────────────────────────────
// Auth: Bearer. The account snapshot — the client's primary state source. Numbers are server-
// computed (points multiplier applied, caps/costs included) so the client renders, never derives,
// the economy. weekday fields are 0=Mon..6=Sun.
export interface MeResponse {
  user: { id: string; email: string | null; twitter: string | null; referralCode: string };
  balanceCents: number;
  points: { total: number; breakdown: Record<PointsType, number>; bonusFromX2: number };
  swipes: { used: number; cap: number };
  skips: { usedToday: number; nextIsFree: boolean; shardCost: number };
  dev: boolean; // dev test account: unlimited skips + deck reset
  shards: number;
  artifacts: number;
  shardsPerArtifact: number; // shards needed to forge 1 artifact (so clients don't hardcode it)
  streak: {
    level: number;
    state: StreakState;
    recoverableUntil: string | null; // ISO-8601, null unless BURNED_RECOVERABLE
    todayWeekday: number; // 0=Mon..6=Sun — which GM-grid column is today
    windowStartWeekday: number; // 0=Mon..6=Sun — where this user's 7-day window starts
  };
  loginMarkedToday: boolean;
  unreadResults: number; // settled bets the user hasn't seen yet (seenAt IS NULL) — drives the HUD bell
  // True for a brand-new account that has never started a streak and hasn't checked in today. The
  // client skips the GM/reveal open ritual for new users — straight to the deck so they feel the
  // core loop first. Derived (streak.level===0 && !loginMarkedToday), no extra query.
  isNewUser: boolean;
}

// ─── POST /api/capture-ref ───────────────────────────────────────────────────────────────────────
// Auth: Bearer. Optional query ?ref=<referralCode>. Captures the referral (cookie code or IP/UA
// device match) and accrues the inviter's share — WITHOUT marking the GM day. Sent on app open so
// attribution survives even when the user doesn't tap GM. Idempotent (capture binds once).
export interface CaptureRefResponse {
  captured: boolean; // true if a referral was bound on this call (false if already bound / no code)
}
