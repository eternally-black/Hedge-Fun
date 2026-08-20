// Boot-time env validation. Next runs register() ONCE at server startup (runtime) — NOT during
// `next build` — so this fails a misconfigured deploy fast & loud instead of silently 401ing every
// request (missing PRIVY secret) or silently disabling fraud signals (missing referral secret).
import { captureToGlitchTip } from "@/lib/glitchtip";

export async function register() {
  // Node runtime only (skip the edge/middleware runtime, which lacks these server secrets).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return; // dev/test: don't block on missing secrets

  // Hard requirements — without these the app can't authenticate users or reach the DB at all.
  const required = ["NEXT_PUBLIC_PRIVY_APP_ID", "PRIVY_APP_SECRET", "DATABASE_URL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    // A missing-secret boot failure must reach error tracking when a DSN is configured.
    await captureToGlitchTip(new Error(`[boot] missing required env in production: ${missing.join(", ")}`), {
      boot: "env-check",
    });
    throw new Error(`[boot] missing required env in production: ${missing.join(", ")}`);
  }

  // Real-money contract. Every one of these fails OPEN or SILENT at runtime: sameOrigin() returns
  // true with APP_ORIGIN unset; a locus that is not exactly "browser" posts orders from the
  // geoblocked VPS and every swipe 409s; missing REAL_CREDS_KEY 503s every money route; a browser
  // locus without the reconcile pair permanently loses any order whose browser dies before
  // reporting. A misconfigured deploy must go red HERE, not be discovered one 409 at a time by the
  // first paying tester. (The deploy script's drift check compares key NAMES only — an empty value
  // passes it clean.)
  const realRequired = [
    "APP_ORIGIN",
    "REAL_CREDS_KEY",
    "POLYMARKET_BUILDER_API_KEY",
    "POLYMARKET_BUILDER_SECRET",
    "POLYMARKET_BUILDER_PASSPHRASE",
  ];
  const realMissing = realRequired.filter((k) => !process.env[k]);
  if (process.env.REAL_ORDER_LOCUS !== "browser") {
    realMissing.push('REAL_ORDER_LOCUS (must be exactly "browser" — the VPS is geoblocked)');
  } else {
    if (!process.env.REAL_RECONCILE_URL) realMissing.push("REAL_RECONCILE_URL (required with browser locus)");
    if (!process.env.REAL_RECONCILE_SECRET) realMissing.push("REAL_RECONCILE_SECRET (required with browser locus)");
  }
  if (realMissing.length) {
    await captureToGlitchTip(new Error(`[boot] real-money env incomplete: ${realMissing.join(", ")}`), {
      boot: "real-env-check",
    });
    throw new Error(`[boot] real-money env incomplete: ${realMissing.join(", ")}`);
  }

  // Soft: without the secret the referral device anti-fraud guard + cross-browser attribution
  // fall back to no-ops (fail-safe, not a crash) — but that's a silent security/attribution loss,
  // so make it visible in the logs.
  if (!process.env.REFERRAL_HASH_SECRET) {
    console.warn(
      "[boot] REFERRAL_HASH_SECRET unset — referral device anti-fraud and cross-browser attribution are DISABLED",
    );
  }

  // Soft: without the builder code the bridge deposit proxy silently drops X-Builder-Code and
  // deposit attribution vanishes with zero signal (K3, S3 review). Only matters once real-money
  // routes are in use, hence a warn, not a throw.
  if (!process.env.POLYMARKET_BUILDER_CODE) {
    console.warn("[boot] POLYMARKET_BUILDER_CODE unset — bridge deposits will not be builder-attributed");
  }
}

// Next 16 request-error hook: ships unhandled route errors to GlitchTip. Whitelisted fields ONLY —
// never spread request (headers/URL can carry auth/PII).
export async function onRequestError(
  err: unknown,
  request: { method: string },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await captureToGlitchTip(err, {
    method: request.method,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
}
