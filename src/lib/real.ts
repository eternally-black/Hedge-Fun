// Real-money access. There USED to be an env allowlist here (REAL_MONEY_EMAILS /
// REAL_MONEY_TWITTER) gating the alpha to a couple of hand-picked accounts while the money path was
// being written against live Polymarket. That gate has served its purpose and is gone: real money is
// open to anyone who explicitly opts in.
//
// What still gates spending, and why this is not simply "no checks":
//   - CONSENT (below) is per-user, durable and explicit — nobody spends without having accepted.
//   - GEO is browser-reported and, as /api/real/intent says in its own words, "policy, not proof";
//     Polymarket's own IP rejection is the real barrier. That was tolerable when two accounts had
//     access and is the weakest link now that anyone does — worth revisiting before a marketing push
//     puts strangers on this path.
//   - Every money route still re-checks consent and same-origin on each call.
//
// Kept as a function rather than deleting the call sites: it is the seam where a restriction goes
// back if a closed test is ever wanted again, and it costs one inlined `true`.
export function isRealMoneyEligible(_user: { email: string | null; twitterHandle: string | null }): boolean {
  return true;
}

export function hasRealConsent(user: { realConsentAt: Date | null }): boolean {
  return user.realConsentAt !== null;
}

// Same-origin check for money routes (S8): browser-posted state-changing requests must carry our
// own Origin. APP_ORIGIN env (e.g. https://hedgefun.app); unset = check disabled (dev).
export function sameOrigin(req: Request): boolean {
  const appOrigin = process.env.APP_ORIGIN;
  if (!appOrigin) return true;
  return req.headers.get("origin") === appOrigin;
}
export const ORIGIN_ENFORCED = !!process.env.APP_ORIGIN;
