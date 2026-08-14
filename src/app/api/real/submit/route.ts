// POST /api/real/submit — phase 2 of the two-phase order protocol (plan §2.1): validate the
// SIGNED order against the durable intent (the envelope is never trusted), claim the attempt via
// CAS, post (or accept the browser's post receipt — the locus is a Gate-0 outcome; both arms
// funnel through the same validation and booking), persist the authoritative response verbatim,
// book fills. Zero fill → KILLED → the market slot frees for a retry.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import {
  validateSignedOrder,
  hashSignedOrder,
  parseFills,
  bookEntryFills,
  type SignedOrderWire,
} from "@/lib/orders";
import { postOrder } from "@polymarket/client/actions";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  const depositWallet = user.depositWalletAddress;
  const embeddedWallet = user.embeddedWalletAddress;
  if (!depositWallet || !embeddedWallet) return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });

  let intentId: unknown, signedOrder: unknown, postResponse: unknown;
  try {
    ({ intentId, signedOrder, postResponse } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof intentId !== "string" || !signedOrder || typeof signedOrder !== "object") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const signed = signedOrder as SignedOrderWire;

  const attempt = await prisma.orderAttempt.findUnique({ where: { id: intentId } });
  if (!attempt || attempt.userId !== user.id) return NextResponse.json({ error: "unknown_intent" }, { status: 404 });
  if (attempt.state === "FILLED" || attempt.state === "PARTIAL" || attempt.state === "KILLED") {
    return NextResponse.json({ status: attempt.state.toLowerCase() }); // idempotent re-report
  }
  if (attempt.state === "SUBMITTING" || attempt.state === "POSTED") {
    return NextResponse.json({ status: "submitting" });
  }

  const err = validateSignedOrder(
    signed,
    {
      tokenId: attempt.tokenId,
      side: "BUY",
      allInCapMicro: attempt.allInCapMicro,
      maxPriceBp: attempt.maxPriceBp,
    },
    {
      depositWallet,
      embeddedWallet,
      builderCode: process.env.POLYMARKET_BUILDER_CODE ?? null,
    },
  );
  if (err) return NextResponse.json({ error: err }, { status: 422 });

  // CAS claim: ISSUED → SUBMITTING with the signed-order hash (unique = replay guard). A losing
  // concurrent submit sees count 0 and reports the in-flight state instead of double-posting.
  const orderHash = hashSignedOrder(signed);
  const claimed = await prisma.orderAttempt.updateMany({
    where: { id: attempt.id, state: "ISSUED" },
    data: { state: "SUBMITTING", signedOrderHash: orderHash },
  });
  if (claimed.count === 0) return NextResponse.json({ status: "submitting" });

  // Obtain the authoritative post response: the browser's receipt (browser-posting locus), or
  // our own postOrder (server-posting locus). The signed payload is forwarded VERBATIM.
  let response: unknown = postResponse ?? null;
  if (!response) {
    const client = await serverSecureClient(prisma, user);
    if (!client) {
      await prisma.orderAttempt.updateMany({
        where: { id: attempt.id, state: "SUBMITTING" },
        data: { state: "ISSUED", signedOrderHash: null, error: "real_not_configured" },
      });
      return NextResponse.json({ error: "real_not_configured" }, { status: 503 });
    }
    try {
      response = await postOrder(client)(signed as never); // 0.6.0: curried (client)(order)
    } catch (e) {
      // Whether the CLOB accepted it is unknown — keep SUBMITTING for reconciliation, never
      // silently retry with a fresh signature (plan §2.1 biggest-risk rule).
      await captureToGlitchTip(e, { route: "real/submit", stage: "post" });
      await prisma.orderAttempt.updateMany({
        where: { id: attempt.id, state: "SUBMITTING" },
        data: { error: `post failed: ${(e as Error).message}` },
      });
      return NextResponse.json({ status: "submitting", error: "post_ambiguous" });
    }
  }

  const rr = response as Record<string, unknown> | null;
  const externalOrderId = rr && typeof rr.orderId === "string" ? rr.orderId : rr && typeof rr.id === "string" ? rr.id : null;
  await prisma.orderAttempt.updateMany({
    where: { id: attempt.id, state: "SUBMITTING" },
    data: { state: "POSTED", postResponse: (response ?? undefined) as never, externalOrderId },
  });

  const params = attempt.approvedParams as { betSide?: "YES" | "NO"; sharesMicro?: string } | null;
  const fills = parseFills(response, attempt.id);
  const finalState = await bookEntryFills(
    prisma,
    attempt,
    params?.betSide === "NO" ? "NO" : "YES",
    BigInt(params?.sharesMicro ?? "0"),
    fills,
  );
  return NextResponse.json({
    status: finalState.toLowerCase(),
    filledSharesMicro: fills.reduce((s, f) => s + f.sharesMicro, 0n).toString(),
  });
}
