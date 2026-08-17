// POST /api/real/posted — the verified-receipt half of the browser-posting locus. Polymarket's
// CLOB refuses orders posted from our host's IP ("Trading restricted in your region": the VPS sits
// in France), and that check is about the TRADER, not our datacentre — so /api/real/submit stops
// after validating and claiming the attempt, and the BROWSER posts. What comes back here is the
// exchange order id and nothing else: a client-supplied RECEIPT stays refused (it would book
// fills, points and counters the exchange never saw), so the server reads the order back itself —
// reads are not geoblocked — proves it is the very order this attempt signed, and only then books
// from the exchange's own trade records. The gate order and error vocabulary follow the submit
// route exactly.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import { matchesExchangeOrder, type ExchangeOrderView, type SignedOrderWire } from "@/lib/orders";
import { reconcileAttempt } from "@/lib/reconcile";
import { realProbes } from "@/lib/order-probe";
import { fetchOrder } from "@polymarket/client/actions";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const depositWallet = user.depositWalletAddress;
  const embeddedWallet = user.embeddedWalletAddress;
  if (!depositWallet || !embeddedWallet) return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });

  let intentId: unknown, orderId: unknown;
  try {
    ({ intentId, orderId } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof intentId !== "string" || typeof orderId !== "string" || !orderId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const attempt = await prisma.orderAttempt.findUnique({ where: { id: intentId } });
  if (!attempt || attempt.userId !== user.id) return NextResponse.json({ error: "unknown_intent" }, { status: 404 });

  // Already booked: the browser is retrying after a dropped response. Answer with the durable
  // state, exactly as submit does.
  if (attempt.state === "FILLED" || attempt.state === "PARTIAL" || attempt.state === "KILLED") {
    return NextResponse.json({ status: attempt.state.toLowerCase() });
  }
  if (attempt.state === "POSTED") {
    // A re-report of the SAME id is legitimate — the first booking may have come back unresolved,
    // and re-running reconciliation is the retry. A DIFFERENT id is not: one attempt must never
    // adopt two exchange orders, and the second one would book fills the user never approved here.
    if (attempt.externalOrderId !== orderId) {
      return NextResponse.json({ error: "order_already_bound" }, { status: 409 });
    }
  } else if (attempt.state !== "SUBMITTING") {
    // ISSUED / SIGNED / FAILED: nothing was ever claimed for posting, so there is no order of ours
    // to adopt. Whatever the caller posted is outside this protocol and cannot be booked against
    // an intent whose slot was never reserved.
    return NextResponse.json({ error: "not_submitted" }, { status: 409 });
  }

  // The signed order is what the reported id gets proven against. /api/real/submit persists it in
  // the same statement as the CAS claim, so its absence means this row never reached the posting
  // step and there is nothing to compare.
  const signed = attempt.signedOrder as unknown as SignedOrderWire | null;
  if (!signed || typeof signed !== "object") {
    return NextResponse.json({ error: "no_signed_order" }, { status: 409 });
  }

  const client = await serverSecureClient(prisma, user);
  if (!client) return NextResponse.json({ error: "real_not_configured" }, { status: 503 });

  // Read the order back from the exchange. fetchOrder is NOT curried (unlike postOrder). A throw
  // or a non-object answer is an inability to PROVE the adoption, not a disproof of it: the
  // attempt stays SUBMITTING and the discovery sweep resolves it against the exchange later.
  let raw: unknown;
  try {
    raw = await fetchOrder(client as never, { orderId });
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/posted", stage: "fetch_order" });
    return NextResponse.json({ error: "order_unreadable" }, { status: 502 });
  }
  if (!raw || typeof raw !== "object") {
    await captureToGlitchTip(new Error("order_unreadable: non-object"), { route: "real/posted", orderId });
    return NextResponse.json({ error: "order_unreadable" }, { status: 502 });
  }

  const o = raw as Record<string, unknown>;
  const view: ExchangeOrderView = {
    id: String(o.id ?? ""),
    tokenId: String(o.tokenId ?? ""),
    makerAddress: String(o.makerAddress ?? ""),
    side: String(o.side ?? ""),
    originalSize: String(o.originalSize ?? ""),
    price: String(o.price ?? ""),
    status: String(o.status ?? ""),
    sizeMatched: String(o.sizeMatched ?? ""),
    createdAt: String(o.createdAt ?? ""),
  };
  const mismatch = matchesExchangeOrder(view, {
    signed,
    dir: attempt.dir === "EXIT" ? "EXIT" : "ENTRY",
    depositWallet,
    notBefore: attempt.createdAt,
  });
  if (mismatch) {
    // A wrong id proves nothing about our real order — it may still be live under an id nobody
    // reported. So this records the evidence and refuses; killing the attempt here would strand a
    // position, and the discovery sweep is the thing allowed to decide that an order does not exist.
    await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "SUBMITTING" },
      data: { error: `order_mismatch: ${mismatch}` },
    });
    return NextResponse.json({ error: "order_mismatch", detail: mismatch }, { status: 422 });
  }

  // CAS-adopt: SUBMITTING and unbound → POSTED with the id. The unique index on externalOrderId is
  // the backstop — binding one exchange order to two attempts would book its fills twice.
  let adopted = false;
  try {
    const cas = await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "SUBMITTING", externalOrderId: null },
      data: { state: "POSTED", externalOrderId: orderId, postResponse: raw as never, error: null },
    });
    adopted = cas.count > 0;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "order_already_bound" }, { status: 409 });
    }
    throw e;
  }
  if (!adopted) {
    // The row moved under us. The benign case is the re-report handled above (already POSTED with
    // this very id) — anything else means someone else owns this attempt's outcome now.
    const fresh = await prisma.orderAttempt.findUnique({ where: { id: attempt.id } });
    if (!(fresh?.state === "POSTED" && fresh.externalOrderId === orderId)) {
      return NextResponse.json({ error: "state_moved" }, { status: 409 });
    }
  }

  // Booking reuses the reconciliation machinery, so the only numbers that reach the ledger are the
  // exchange's own trade records — never a figure this request carried.
  const { probe } = realProbes(prisma);
  const market = await prisma.market.findUnique({
    where: { id: attempt.marketId },
    select: { feeExpMilli: true },
  });
  let outcome: Awaited<ReturnType<typeof reconcileAttempt>>;
  try {
    outcome = await reconcileAttempt(
      prisma,
      { ...attempt, state: "POSTED", externalOrderId: orderId },
      probe,
      market?.feeExpMilli ?? 1000,
    );
  } catch (e) {
    // The adoption is already durable, and that is the part that must not be lost: with the id on
    // the row, the ordinary POSTED sweep can finish the booking.
    await captureToGlitchTip(e, { route: "real/posted", stage: "book", attemptId: attempt.id });
    return NextResponse.json({ status: "posted", outcome: "unknown" });
  }

  if (outcome === "booked" || outcome === "killed") {
    const final = await prisma.orderAttempt.findUnique({ where: { id: attempt.id }, select: { state: true } });
    return NextResponse.json({ status: (final?.state ?? "POSTED").toLowerCase() });
  }
  // pending / unknown: a fresh match's trade records are often not queryable for a few seconds.
  // Nothing is lost — the poller's reconcile pass books it within minutes.
  return NextResponse.json({ status: "posted", outcome });
}
