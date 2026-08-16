// POST /api/real/creds — the browser derived its L2 CLOB API creds (a wallet signature it alone
// can produce) and hands them to the server for encrypted-at-rest storage (owner decision Q4).
// These authenticate reads/cancels only — they are NOT signing keys (D5 intact). Closes the S4
// review gap: without this route no production path ever populated ClobCredential.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { saveClobCreds } from "@/lib/clob-creds";

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
