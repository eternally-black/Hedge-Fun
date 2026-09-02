"use client";

// The one place the real-money copy lives, shared by the deck and RealOrderCard. Nothing here may
// hide a failure or claim a fill that did not happen — an ambiguous exchange response says exactly
// that.

// The three the operator will actually hit; everything else shows its raw code, because inventing
// friendly prose for an unknown money error is how a real problem gets read as a typo.
export const KNOWN_REAL_ERRORS: Record<string, string> = {
  stake_too_small: "below the market's minimum order size",
  no_liquidity: "the book cannot fill this size",
  geo_blocked: "trading is blocked from this location",
  // ── intent route (src/app/api/real/intent/route.ts) ──
  bad_json: "the request was malformed",
  bad_request: "the request was malformed",
  bad_dir: "the order direction was invalid",
  geo_required: "location verification is required",
  market_unavailable: "this market is no longer available",
  market_closing: "this market is closing soon",
  position_exists: "you already hold a position on this market",
  no_position: "you have no position to close on this market",
  book_unavailable: "the order book is temporarily unavailable",
  bad_stake: "the stake is outside the allowed range",
  attempt_in_flight: "an order on this market is already in progress",
  intent_expired_retry: "the order expired — please try again",
  // ── submit route (src/app/api/real/submit/route.ts) ──
  receipts_not_accepted: "the order receipt was rejected",
  unknown_intent: "the order was not found",
  intent_expired: "the order expired — please try again",
  duplicate_order: "this order was already submitted",
  real_not_configured: "real-money trading is not configured",
  // ── shared by both routes ──
  real_disabled: "real-money trading is disabled for this account",
  consent_required: "you must accept the real-money terms first",
  rate_limited: "too many attempts — please slow down",
  no_deposit_wallet: "finish real-money setup in your profile first",
  bad_origin: "the request did not come from the app",
  // ── submit route, exchange refusal (terminal, no retry) ──
  post_rejected: "the exchange refused the order",
  // ── submit route, exchange answered without a verdict — the reconciler settles it ──
  post_ambiguous: "the exchange gave no verdict — the order is checked within minutes",
  post_no_order_id: "the exchange gave no order id — the order is checked within minutes",
};

export function realErrText(e: unknown): string {
  const code = (e as { body?: { error?: string } }).body?.error;
  if (!code) return e instanceof Error ? e.message : String(e);
  return KNOWN_REAL_ERRORS[code] ?? code;
}

const shares = (micro: string) => (Number(micro) / 1e6).toFixed(4);

export function realResultText(res: { status: string; filledSharesMicro?: string }): string {
  switch (res.status) {
    case "filled":
    case "partial":
      return `${res.status} — ${shares(res.filledSharesMicro ?? "0")} shares`;
    case "killed":
      return "no fill — the market slot is free again";
    case "posted":
      return "posted, awaiting the exchange — the reconciler books it when the trade record lands";
    // NOT the same promise. "posted" carries an exchange order id, so the reconciler resolves it
    // from the trade records. "submitting" means the outcome is unknown and the row has NO order
    // id, which every reconcile scan filters out (`externalOrderId: { not: null }`) — that used to
    // mean a human. It no longer does: the orphan sweep asks the exchange whether an order of ours
    // exists on that token and either adopts it or kills the attempt, and the stuck-attempt watcher
    // still pages ops for anything that survives it.
    case "submitting":
      return "sent, outcome not yet confirmed — the exchange itself is checked within minutes";
    default:
      return `status: ${res.status}`;
  }
}

// Nothing was signed or spent, so the card comes back and the user may swipe again; every other
// code is terminal for this card.
export const RETRYABLE_REAL_ERRORS = new Set(["rate_limited", "book_unavailable", "geo_required"]);
