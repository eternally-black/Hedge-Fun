// A REAL stock buy parked in localStorage between "the wallet sent it" and "the server booked it".
// The tab can die in that window and the money is already gone, so the signature is written down
// before /confirm and replayed on the next visit (useBuyReal).
//
// The rules live here, pure and DB-free, because they are the ones that decide whether a spent
// dollar is still recoverable: what a stored entry looks like, when it is too old to be worth
// replaying, and which server answer means "this attempt is settled, stop asking". Testable without
// a browser — scripts/test-stocks.ts asserts every branch.

export type PendingEntry = { attemptId: string; sig: string; createdAt: number };

// 48 h. Long enough that a phone left shut over a weekend still replays its buy; short enough that
// an attempt the server never resolves stops being re-confirmed on every load forever (v1 entries
// carried no timestamp at all, so they were kept for good).
export const STOCK_PENDING_TTL_MS = 48 * 60 * 60 * 1000;

// Versioned key (client-localstorage-schema): v1 entries have a different shape, and a v1 reader
// must never see v2 data. Migration is one-way and lossless — see parsePending.
export const STOCK_PENDING_PREFIX = "hf_stock_pending:v2:";
export const STOCK_PENDING_PREFIX_V1 = "hf_stock_pending:";

/** One key per (user, payer): a lot is sold from the wallet that bought it, so the payer is part of the identity. */
export function pendingKey(userId: string, payer: string): string {
  return `${STOCK_PENDING_PREFIX}${userId}:${payer}`;
}

/** The v1 key for the same pair, kept only so the migration can find and delete it. */
export function pendingKeyV1(userId: string, payer: string): string {
  return `${STOCK_PENDING_PREFIX_V1}${userId}:${payer}`;
}

// Tolerant by design: this reads a value another build wrote, on a device we do not control. Anything
// unparseable is nothing rather than a thrown error — a corrupt entry must not take down the screen
// that reads it. Entries past the TTL are dropped here, so every caller gets the same answer.
export function parsePending(raw: string | null, now: number): PendingEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: PendingEntry[] = [];
  for (const e of parsed) {
    if (!e || typeof e !== "object") continue;
    const { attemptId, sig, createdAt } = e as Partial<PendingEntry>;
    if (typeof attemptId !== "string" || !attemptId) continue;
    if (typeof sig !== "string" || !sig) continue;
    // v1 MIGRATION: those entries have no createdAt, and their real age is unknown. Stamped as first
    // seen NOW rather than dropped — the money behind them is already spent — which also starts the
    // TTL clock, so an unresolvable one finally expires instead of living forever.
    const stamped = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : now;
    if (now - stamped > STOCK_PENDING_TTL_MS) continue;
    out.push({ attemptId, sig, createdAt: stamped });
  }
  return out;
}

// Whether a /real/confirm answer means the attempt is SETTLED and the entry can be forgotten.
//
// Only two answers are terminal: 200 (booked) and 409 (the server's verdict on this attempt —
// tx_failed, not_this_buy, attempt_expired, attempt_failed, lot_closed). Everything else is a
// transport problem, not a verdict: 401 is a token that has not refreshed yet, 429 is our own rate
// limit, 404 is a chain still a beat behind, 5xx/undefined is the network. Dropping on those loses
// the only client-side record that this dollar was spent.
export function shouldDropPending(status: number | undefined): boolean {
  return status === 200 || status === 409;
}
