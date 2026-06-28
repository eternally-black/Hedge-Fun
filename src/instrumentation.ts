// Boot-time env validation. Next runs register() ONCE at server startup (runtime) — NOT during
// `next build` — so this fails a misconfigured deploy fast & loud instead of silently 401ing every
// request (missing PRIVY secret) or silently disabling fraud signals (missing referral secret).
export async function register() {
  // Node runtime only (skip the edge/middleware runtime, which lacks these server secrets).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return; // dev/test: don't block on missing secrets

  // Hard requirements — without these the app can't authenticate users or reach the DB at all.
  const required = ["NEXT_PUBLIC_PRIVY_APP_ID", "PRIVY_APP_SECRET", "DATABASE_URL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`[boot] missing required env in production: ${missing.join(", ")}`);
  }

  // Soft: without the secret the referral device anti-fraud guard + cross-browser attribution
  // fall back to no-ops (fail-safe, not a crash) — but that's a silent security/attribution loss,
  // so make it visible in the logs.
  if (!process.env.REFERRAL_HASH_SECRET) {
    console.warn(
      "[boot] REFERRAL_HASH_SECRET unset — referral device anti-fraud and cross-browser attribution are DISABLED",
    );
  }
}
