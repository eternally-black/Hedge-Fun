import assert from "node:assert/strict";

async function main() {
  // This process never loads .env and must never send error telemetry.
  Object.assign(process.env, {
    NODE_ENV: "production",
    NEXT_RUNTIME: "nodejs",
    SENTRY_DSN: "",
    TELEGRAM_BOT_TOKEN: "",
    NEXT_PUBLIC_PRIVY_APP_ID: "audit-app-id",
    PRIVY_APP_SECRET: "audit-not-a-real-secret",
    DATABASE_URL: "postgresql://audit:disabled@127.0.0.1:1/audit?connect_timeout=1",
    APP_ORIGIN: "http://127.0.0.1:3219",
    REAL_ORDER_LOCUS: "browser",
    REAL_CREDS_KEY: "0".repeat(64),
    POLYMARKET_BUILDER_API_KEY: "audit-key",
    POLYMARKET_BUILDER_SECRET: "audit-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "audit-passphrase",
    POLYMARKET_BUILDER_CODE: "audit-code",
    REAL_RECONCILE_URL: "http://127.0.0.1:1/reconcile",
    REAL_RECONCILE_SECRET: "audit-reconcile-secret",
    REFERRAL_HASH_SECRET: "audit-referral-secret",
  });
  const { register } = await import("../src/instrumentation");
  await register();
  for (const key of ["APP_ORIGIN", "REAL_ORDER_LOCUS", "REAL_RECONCILE_URL", "REAL_RECONCILE_SECRET", "REFERRAL_HASH_SECRET"]) {
    const value = process.env[key];
    delete process.env[key];
    await assert.rejects(register, new RegExp(key), `${key} must remain mandatory`);
    process.env[key] = value;
  }
  await register();
  console.log("production boot guards: valid dummy configuration passes; required fields fail closed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
