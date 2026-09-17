import { REAL_TERMS_VERSION } from "./real-terms";

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

// The persisted realMode flag outlives the consent behind it: a terms bump leaves realMode=true on
// rows whose acceptance is now stale. /api/me already reports this predicate, and every
// mode-dependent read (deck/history/results) must agree with it — otherwise the client renders the
// paper shell while the data routes still serve REAL rows.
export function effectiveRealMode(user: {
  realMode: boolean;
  realConsentAt: Date | null;
  realConsentVersion: string | null;
}): "REAL" | "PAPER" {
  return user.realMode && user.realConsentAt !== null && user.realConsentVersion === REAL_TERMS_VERSION
    ? "REAL"
    : "PAPER";
}

// Same-origin check for money routes (S8): browser-posted state-changing requests must carry our
// own Origin. APP_ORIGIN env (e.g. https://hedgefun.app); unset = check disabled (dev).
export function sameOrigin(req: Request): boolean {
  const appOrigin = process.env.APP_ORIGIN;
  if (!appOrigin) return true;
  const origin = req.headers.get("origin");
  if (origin === appOrigin) return true;
  // Native clients (the Expo app, mobile/src/api.ts) have no Origin. A browser cannot omit Origin
  // on a cross-site POST, and the custom header would force a CORS preflight this server never
  // answers — so "no Origin + x-hf-client" can only come from a non-browser holding a Bearer token.
  return origin === null && NATIVE_CLIENTS.has(req.headers.get("x-hf-client") ?? "");
}
const NATIVE_CLIENTS = new Set(["seeker", "play"]);
export const ORIGIN_ENFORCED = !!process.env.APP_ORIGIN;
