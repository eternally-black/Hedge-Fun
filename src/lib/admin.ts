// Admin allowlist, gated by the ADMIN_EMAILS env var (comma-separated). Mirrors the dev-user
// pattern (dev.ts): when unset (the prod default), nobody is admin. Only an exact, case- and
// whitespace-insensitive email match grants access. Used by the admin-only routes (/api/admin/*)
// for the private growth/CRM leaderboard, which shows PII and must never be public.

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function isAdmin(email: string | null | undefined): boolean {
  if (ADMIN_EMAILS.size === 0) return false; // unset = nobody (prod-safe), like isDevUser
  return ADMIN_EMAILS.has((email ?? "").trim().toLowerCase());
}
