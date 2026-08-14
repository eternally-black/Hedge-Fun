// POST /api/real/submit — phase 2 of the two-phase order protocol (plan §2.1): validate the
// SIGNED order against the durable intent (the envelope is never trusted), claim the attempt via
// CAS, post (or accept the browser's post receipt — the locus is a Gate-0 outcome; both arms
// funnel through the same validation and booking), persist the authoritative response verbatim,
// book fills. Zero fill → KILLED → the market slot frees for a retry.
// Branches on attempt.dir: ENTRY → BUY validation + bookEntryFills; EXIT → SELL validation +
// bookExitFills. Everything else (CAS claim, posting arms, POSTED persist, ambiguity rule) is
// identical for both directions.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import {
  validateSignedOrder,
  validateSignedSellOrder,
  hashSignedOrder,
  classifyPostResponse,
  bookEntryFills,
  bookExitFills,
  type SignedOrderWire,
} from "@/lib/orders";
import { postOrder } from "@polymarket/client/actions";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
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
  // Client-supplied receipts are REFUSED (S6 review critical: a fabricated receipt would book
  // fills, points and counters the exchange never saw). The server posts; the browser-posting
  // locus returns only with a verified-receipt design at Gate-0.
  if (postResponse !== undefined && postResponse !== null) {
    return NextResponse.json({ error: "receipts_not_accepted" }, { status: 400 });
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

  // Validate the signed order against the durable intent — the validator depends on the direction.
  const ctx = {
    depositWallet,
    embeddedWallet,
    builderCode: process.env.POLYMARKET_BUILDER_CODE ?? null,
  };
  let err: string | null;
  if (attempt.dir === "EXIT") {
    const params = attempt.approvedParams as { tokenId?: string; sharesMicro?: string; minPriceBp?: number } | null;
    err = validateSignedSellOrder(
      signed,
      {
        tokenId: attempt.tokenId,
        sharesMicro: BigInt(params?.sharesMicro ?? "0"),
        minPriceBp: params?.minPriceBp ?? attempt.maxPriceBp, // maxPriceBp column holds minPriceBp for EXIT
      },
      ctx,
    );
  } else {
    err = validateSignedOrder(
      signed,
      {
        tokenId: attempt.tokenId,
        side: "BUY",
        allInCapMicro: attempt.allInCapMicro,
        maxPriceBp: attempt.maxPriceBp,
      },
      ctx,
    );
  }
  if (err) return NextResponse.json({ error: err }, { status: 422 });

  // CAS claim: ISSUED → SUBMITTING with the signed-order hash (unique = replay guard). A losing
  // concurrent submit sees count 0 and reports the in-flight state instead of double-posting.
  const orderHash = hashSignedOrder(signed);
  let claimed;
  try {
    claimed = await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "ISSUED" },
      data: { state: "SUBMITTING", signedOrderHash: orderHash },
    });
  } catch (e) {
    // signedOrderHash unique: the SAME signed order replayed against a NEW intent — a clean
    // duplicate response, not a raw 500 (K3 S6/S7 M2 edge).
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "duplicate_order" }, { status: 409 });
    }
    throw e;
  }
  if (claimed.count === 0) return NextResponse.json({ status: "submitting" });

  // Server posts — the response is the authoritative receipt. Forward the signed payload VERBATIM.
  const client = await serverSecureClient(prisma, user);
  if (!client) {
    await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "SUBMITTING" },
      data: { state: "ISSUED", signedOrderHash: null, error: "real_not_configured" },
    });
    return NextResponse.json({ error: "real_not_configured" }, { status: 503 });
  }
  let response: unknown;
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

  const rr = response as Record<string, unknown> | null;
  const externalOrderId = rr && typeof rr.orderId === "string" ? rr.orderId : null;
  await prisma.orderAttempt.updateMany({
    where: { id: attempt.id, state: "SUBMITTING" },
    data: { state: "POSTED", postResponse: (response ?? undefined) as never, externalOrderId },
  });

  // Classify BEFORE booking (S6 review critical: the real matched response carries scalar
  // making/taking amounts, not a fills array — a shape-guess parser read it as zero-fill and
  // KILLED attempts whose money was spent). Only a POSITIVE terminal signal books; everything
  // ambiguous stays POSTED for reconciliation (the stuck-attempt watcher alerts on it).
  const params = attempt.approvedParams as
    | { betSide?: "YES" | "NO"; sharesMicro?: string; feeRateBp?: number; feeExpMilli?: number }
    | null;
  const fee =
    typeof params?.feeRateBp === "number" && typeof params?.feeExpMilli === "number"
      ? { rateBp: params.feeRateBp, expMilli: params.feeExpMilli }
      : null;
  const outcome = classifyPostResponse(response, attempt.dir === "EXIT" ? "EXIT" : "ENTRY", attempt.id, fee);

  if (outcome.kind === "pending" || outcome.kind === "unknown") {
    return NextResponse.json({ status: "posted", outcome: outcome.kind });
  }
  const fills = outcome.kind === "matched" ? outcome.fills : []; // rejected → zero-fill KILLED path
  // The receipt carries the ORDER's cumulative matched totals — the booker subtracts what this
  // attempt already holds, so a re-delivered or grown receipt neither double-books nor drops fills.
  const bookOpts = { cumulative: outcome.kind === "matched" };
  const finalState =
    attempt.dir === "EXIT"
      ? await bookExitFills(prisma, attempt, BigInt(params?.sharesMicro ?? "0"), fills, bookOpts)
      : await bookEntryFills(
          prisma,
          attempt,
          params?.betSide === "NO" ? "NO" : "YES",
          BigInt(params?.sharesMicro ?? "0"),
          fills,
          bookOpts,
        );
  return NextResponse.json({
    status: finalState.toLowerCase(),
    filledSharesMicro: fills.reduce((s, f) => s + f.sharesMicro, 0n).toString(),
  });
}
