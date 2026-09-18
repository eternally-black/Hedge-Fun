// Mobile Wallet Adapter wallet link (Seeker flavor) — see src/lib/mwa-link.ts for the proof.
//
// GET  /api/link/mwa — Bearer. The Sign-In-With-Solana input the app hands to the wallet's
//                      `authorize` call: our domain + uri, the statement, a nonce bound to the caller.
// POST /api/link/mwa — Bearer + native same-origin clause. Body = the wallet's sign_in_result
//                      verbatim. A valid proof makes the address a VERIFIED hedge wallet — the flag
//                      Privy-linked wallets get — so the existing money routes accept it as `payer`.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUserStrict } from "@/lib/privy";
import { sameOrigin } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import { mwaNonce, SIWS_STATEMENT, verifySiwsLink } from "@/lib/mwa-link";
import type { MwaLinkNonceResponse, MwaLinkRequest, MwaLinkResponse } from "@/lib/api-types";

// SIWS binds the signature to a domain. Prod: APP_ORIGIN's host (the same value the same-origin
// check uses). Dev (APP_ORIGIN unset): whatever host the app called — and POST does not enforce it.
function siteOf(req: Request): { origin: string; domain: string; enforced: boolean } {
  const appOrigin = process.env.APP_ORIGIN;
  const origin = appOrigin ?? new URL(req.url).origin;
  return { origin, domain: new URL(origin).host, enforced: !!appOrigin };
}

export async function GET(req: Request) {
  const auth = await authUserStrict(req);
  if ("error" in auth) {
    return auth.error === "unauthorized"
      ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
      : NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }
  const site = siteOf(req);
  const res: MwaLinkNonceResponse = {
    domain: site.domain,
    uri: site.origin,
    statement: SIWS_STATEMENT,
    nonce: mwaNonce(auth.user.id),
  };
  return NextResponse.json(res, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await authUserStrict(req);
  if ("error" in auth) {
    return auth.error === "unauthorized"
      ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
      : NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }
  const user = auth.user;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  if (!rateLimit(`link-mwa:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<MwaLinkRequest> | null;
  if (
    !body ||
    typeof body.address !== "string" ||
    typeof body.signed_message !== "string" ||
    typeof body.signature !== "string"
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const site = siteOf(req);
  const verdict = await verifySiwsLink({
    addressB64: body.address,
    signedMessageB64: body.signed_message,
    signatureB64: body.signature,
    userId: user.id,
    expectedDomain: site.enforced ? site.domain : null,
    expectedUri: site.enforced ? site.origin : null,
    expectedStatement: SIWS_STATEMENT,
  });
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });

  // Same row the Privy path writes (hedge/wallet route); verification only ever ratchets up.
  const now = new Date();
  await prisma.hedgeWallet.upsert({
    where: { userId_address: { userId: user.id, address: verdict.address } },
    create: { userId: user.id, address: verdict.address, verifiedAt: now },
    update: { verifiedAt: now },
    select: { id: true },
  });
  const res: MwaLinkResponse = { address: verdict.address, verified: true };
  return NextResponse.json(res);
}
