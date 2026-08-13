// Real-money outer gate (plan §2.7). Env allowlist is the OUTER gate; persisted consent is the
// inner one; both re-checked on every money route. Mirrors the admin.ts pattern: comma-separated
// env lists, parsed at module scope, unset ⇒ nobody (fail-closed). Two keys because not every
// real-money user has an email — X-signup accounts have only a handle — so a user matches on
// EITHER an exact email (REAL_MONEY_EMAILS) or an exact X handle (REAL_MONEY_TWITTER, leading @
// optional). Both case- and whitespace-insensitive.

const REAL_MONEY_EMAILS = new Set(
  (process.env.REAL_MONEY_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const REAL_MONEY_TWITTER = new Set(
  (process.env.REAL_MONEY_TWITTER ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),
);

export function isRealMoneyEligible(user: { email: string | null; twitterHandle: string | null }): boolean {
  const email = (user.email ?? "").trim().toLowerCase();
  if (email && REAL_MONEY_EMAILS.has(email)) return true;
  const handle = (user.twitterHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  if (handle && REAL_MONEY_TWITTER.has(handle)) return true;
  return false; // unset env or no match = nobody (prod-safe), like isAdmin
}

export function hasRealConsent(user: { realConsentAt: Date | null }): boolean {
  return user.realConsentAt !== null;
}
