// POST /api/real/creds — the browser derived its L2 CLOB API creds (a wallet signature it alone
// can produce) and hands them to the server for encrypted-at-rest storage (owner decision Q4).
// These authenticate reads/cancels only — they are NOT signing keys (D5 intact). Closes the S4
// review gap: without this route no production path ever populated ClobCredential.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { saveClobCreds, loadClobCreds } from "@/lib/clob-creds";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  if (!user.depositWalletAddress) return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });

  let key: unknown, secret: unknown, passphrase: unknown;
  try {
    ({ key, secret, passphrase } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (
    typeof key !== "string" ||
    typeof secret !== "string" ||
    typeof passphrase !== "string" ||
    !key ||
    !secret ||
    !passphrase ||
    key.length > 200 ||
    secret.length > 500 ||
    passphrase.length > 500
  ) {
    return NextResponse.json({ error: "bad_creds" }, { status: 400 });
  }

  const saved = await saveClobCreds(prisma, user.id, { key, secret, passphrase });
  if (!saved) return NextResponse.json({ error: "real_not_configured" }, { status: 503 });
  return NextResponse.json({ ok: true });
}

// GET /api/real/creds — hand the caller back the creds THEY derived, so the browser client can be
// built with them instead of asking the exchange for a fresh set on every page load.
//
// Re-deriving is what broke the first real swipe: the CLOB answers POST /auth/api-key with 400 once
// a key for that address already exists, and the failure lands before any of our routes are called,
// so the swipe died with nothing to show for it. The server has always assembled its client from the
// stored creds (polymarket-server.ts); this lets the browser do the same.
//
// Not a new exposure: these are L2 read/cancel creds — never signing keys (D5) — the browser derived
// them itself in provisioning, and they go back only to the same authenticated, same-origin owner.
// no-store because a shared cache must never hold them.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  // NO same-origin check here, deliberately. Browsers omit the Origin header on same-origin GETs, so
  // the check does not merely add nothing — it refuses every legitimate call, which is exactly what
  // it did: a 403 here sent the client back to deriving and straight into the CLOB's 400. It is not
  // load-bearing either way, because these routes authenticate with a Bearer token rather than a
  // cookie, so a third-party page cannot make an authenticated request in the first place. The POST
  // above keeps its check: it is state-changing, and there the header is actually sent.
  const creds = await loadClobCreds(prisma, user.id).catch(() => null);
  // 404, not an error: "never provisioned" is a normal state, and the client answers it by deriving
  // a fresh set exactly as it does on first setup.
  if (!creds) return NextResponse.json({ error: "no_creds" }, { status: 404 });

  return NextResponse.json(creds, { headers: { "Cache-Control": "no-store" } });
}
