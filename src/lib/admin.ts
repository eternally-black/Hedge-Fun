// Admin allowlist, gated by env vars (comma-separated). Mirrors the dev-user pattern (dev.ts):
// when both are unset (the prod default), nobody is admin. Two keys because not every admin has an
// email — X-signup accounts have only a handle — so an admin matches on EITHER an exact email
// (ADMIN_EMAILS) or an exact X handle (ADMIN_TWITTER, leading @ optional). Both case- and
// whitespace-insensitive. Used by the admin-only routes (/api/admin/*) for the private growth/CRM
// leaderboard, which shows PII and must never be public.

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const ADMIN_TWITTER = new Set(
  (process.env.ADMIN_TWITTER ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),
);

export function isAdmin(user: { email?: string | null; twitterHandle?: string | null }): boolean {
  const email = (user.email ?? "").trim().toLowerCase();
  if (email && ADMIN_EMAILS.has(email)) return true;
  const handle = (user.twitterHandle ?? "").trim().toLowerCase().replace(/^@/, "");
  if (handle && ADMIN_TWITTER.has(handle)) return true;
  return false; // unset env or no match = nobody (prod-safe), like isDevUser
}
