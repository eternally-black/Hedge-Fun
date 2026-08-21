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
import { rateLimit } from "@/lib/ratelimit";
import { SWIPE_CAP } from "@/lib/config";
import { utcDay } from "@/lib/time";
import { releaseSwipeSlot } from "@/lib/orders";

// Thrown INSIDE the claim transaction so the rollback undoes the CAS as well — the cap must never
// be able to reject a submit that has already moved the attempt out of ISSUED.
class CapReachedError extends Error {}

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  // The one money route without a bound, while /intent (30/min) upstream of it has one. Every call
  // reaches an exchange post under this user's credentials, so leaving it open lets a scripted
  // client outrun its own intents. Matched to the intent limit: legitimate traffic is one submit
  // per intent.
  if (!rateLimit(`real-submit:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
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
  // The intent's OWN ten-minute lifetime, enforced on this side too. validateCommon checks the
  // freshness of the SIGNATURE, never of the intent, so an ISSUED attempt could be signed days
  // later and still fill against a price bound frozen from a book that was 30s old at intent time —
  // exactly the invariant D9 states. The bound caps the worst case either way, but the slot could
  // otherwise sit ISSUED indefinitely: the intent route's expiry only runs when another intent
  // happens to arrive on the same market. FAILED here frees it deterministically, and nothing was
  // posted, so there is no ambiguity to preserve.
  if (Date.now() - attempt.createdAt.getTime() > 10 * 60_000) {
    await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "ISSUED" },
      data: { state: "FAILED", error: "intent_expired" },
    });
    return NextResponse.json({ error: "intent_expired" }, { status: 409 });
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
    // The ceiling on makerAmount is the ORDER's own amount, not the debit cap. Since the fee moved
    // on top of the stake (owner, 2026-08-17) the two differ: allInCapMicro is stake + fee, so
    // validating against it would admit a signed order whose notional had eaten the fee headroom —
    // and the exchange would then charge its fee on top of THAT, past the cap the user approved.
    // Older attempts have no amountMicro and fall back to the cap, which is what they were quoted
    // against.
    const params = attempt.approvedParams as { amountMicro?: string } | null;
    err = validateSignedOrder(
      signed,
      {
        tokenId: attempt.tokenId,
        side: "BUY",
        allInCapMicro: params?.amountMicro ? BigInt(params.amountMicro) : attempt.allInCapMicro,
        maxPriceBp: attempt.maxPriceBp,
      },
      ctx,
    );
  }
  if (err) return NextResponse.json({ error: err }, { status: 422 });

  // CAS claim: ISSUED → SUBMITTING with the signed-order hash (unique = replay guard). A losing
  // concurrent submit sees count 0 and reports the in-flight state instead of double-posting.
  //
  // The daily cap is RESERVED in the same transaction, and the increment itself is the gate — the
  // paper path's proven shape (swipe.ts): bump, then throw if the post-increment value went over,
  // so the rollback undoes the claim too. It used to be a bare read at intent time with the
  // increment minutes later at fill, which failed twice over: N parallel intents all read the same
  // value and all passed (9/10 used + five parallel entries = 14 on a 10-cap day, $2k past the
  // throttle at max stake), and a re-entry after a full EXIT hit the `!priorBet` guard at fill and
  // never incremented at all, so one market could be churned forever on a single slot.
  // Reserved HERE and not at intent because an abandoned intent must stay free: the user who opens
  // a card and walks away should not burn a swipe, and between CAS and fill the window is
  // milliseconds instead of the intent's ten minutes. EXIT is not a swipe, so it reserves nothing.
  const orderHash = hashSignedOrder(signed);
  // Keyed to the ATTEMPT's creation day, not to now. Reserve and release must name the same row, and
  // the release happens deep in the booker, which only has the attempt — deriving the day from an
  // immutable field of the attempt is what makes the two agree by construction. `utcDay()` here
  // instead would drift whenever an intent is created before midnight and submitted after it (the
  // intent lifetime is ten minutes, so that window is real): the reservation would land on D2 while
  // every release path computed D1, leaking a real slot and handing back a paper one.
  const capDay = utcDay(attempt.createdAt);
  let claimed: { count: number };
  try {
    claimed = await prisma.$transaction(async (tx) => {
      const cas = await tx.orderAttempt.updateMany({
        where: { id: attempt.id, state: "ISSUED" },
        // The payload is persisted HERE, before the post that may or may not reach the exchange. An
        // attempt that dies in that window has no externalOrderId, and every reconcile scan filters
        // on that being non-null — so the row is invisible to reconciliation and wedges the market
        // slot forever. Recovery is still manual (the SDK exports no helper to derive the exchange
        // order id from a signed order), but with this an operator can at least see what was signed.
        data: { state: "SUBMITTING", signedOrderHash: orderHash, signedOrder: signed as never },
      });
      if (cas.count === 0 || attempt.dir === "EXIT") return cas;
      const counter = await tx.dailyCounter.upsert({
        where: { userId_utcDay: { userId: user.id, utcDay: capDay } },
        create: { userId: user.id, utcDay: capDay, swipeCount: 1 },
        update: { swipeCount: { increment: 1 } },
      });
      if (counter.swipeCount > SWIPE_CAP) throw new CapReachedError();
      return cas;
    });
  } catch (e) {
    if (e instanceof CapReachedError) {
      return NextResponse.json({ error: "daily swipe limit reached" }, { status: 403 });
    }
    // signedOrderHash unique: the SAME signed order replayed against a NEW intent — a clean
    // duplicate response, not a raw 500 (K3 S6/S7 M2 edge).
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "duplicate_order" }, { status: 409 });
    }
    throw e;
  }
  if (claimed.count === 0) return NextResponse.json({ status: "submitting" });

  // POSTING LOCUS. With REAL_ORDER_LOCUS=browser the post itself goes back to the client: the CLOB
  // answers our host with "Trading restricted in your region" (the VPS is in France) and that check
  // is about the TRADER — posting server-side inserted our datacentre into a decision that is about
  // the end user. Nothing protective is skipped by returning here: the signed order was validated
  // against the durable intent above, the replay guard and the daily-slot reserve landed with the
  // CAS, and the attempt is now SUBMITTING with its signed payload persisted. The browser posts and
  // reports only the order ID to /api/real/posted, which reads that order back from the exchange
  // (reads are not geoblocked) before a cent is booked — a client-supplied RECEIPT is still refused
  // at the top of this route. A browser that posts and then dies is recovered by the discovery
  // sweep (src/lib/reconcile.ts): without it the row would be invisible to every reconcile scan,
  // which all filter on a non-null externalOrderId, and its market slot would stay wedged forever.
  if (process.env.REAL_ORDER_LOCUS === "browser") {
    // The browser can post without the server, but the server must be able to READ THE ORDER BACK —
    // the posted-route receipt, reconcile and orphan discovery all build this same client. Approving
    // a post the server can never book turns a missing/undecryptable creds row into spent money with
    // no position, a consumed slot and a permanently wedged market. Nothing is posted yet, so the
    // rollback is the same one the server-post arm uses for real_not_configured.
    const readback = await serverSecureClient(prisma, user);
    if (!readback) {
      await prisma.$transaction(async (tx) => {
        const rolledBack = await tx.orderAttempt.updateMany({
          where: { id: attempt.id, state: "SUBMITTING" },
          data: { state: "ISSUED", signedOrderHash: null, error: "real_not_configured" },
        });
        if (rolledBack.count > 0 && attempt.dir !== "EXIT") await releaseSwipeSlot(tx, user.id, capDay);
      });
      return NextResponse.json({ error: "real_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ status: "approved", intentId: attempt.id });
  }

  // Server posts — the response is the authoritative receipt. Forward the signed payload VERBATIM.
  const client = await serverSecureClient(prisma, user);
  if (!client) {
    // Nothing was posted and the attempt goes back to ISSUED, so the slot this claim reserved is
    // returned — in the SAME transaction as the rollback, because two statements meant a crash in
    // between left the attempt retryable with the slot still spent, and no later pass could tell.
    // Gated on the update actually landing so a concurrent path cannot release it twice.
    await prisma.$transaction(async (tx) => {
      const rolledBack = await tx.orderAttempt.updateMany({
        where: { id: attempt.id, state: "SUBMITTING" },
        data: { state: "ISSUED", signedOrderHash: null, error: "real_not_configured" },
      });
      if (rolledBack.count > 0 && attempt.dir !== "EXIT") await releaseSwipeSlot(tx, user.id, capDay);
    });
    return NextResponse.json({ error: "real_not_configured" }, { status: 503 });
  }
  let response: unknown;
  try {
    response = await postOrder(client)(signed as never); // 0.6.0: curried (client)(order)
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/submit", stage: "post" });
    const message = (e as Error).message;

    // A REJECTION is not an ambiguity. When the exchange answers and refuses — geoblock, bad
    // parameters, a rate limit — no order was created, so there is nothing to reconcile against and
    // the attempt is terminal. Leaving it SUBMITTING instead was a real trap: reconcile scans filter
    // on a non-null externalOrderId, so an attempt that never got one is invisible to them, and the
    // partial unique index (one in-flight per user+market) then blocks that market for that user
    // FOREVER. Three attempts were wedged exactly this way by Polymarket's regional block.
    //
    // Matched on the SDK's error NAME rather than instanceof: the class travels through a lazily
    // imported barrel, and an identity check across module instances is the kind of thing that
    // silently stops matching. Anything NOT on this list keeps the old behaviour — a timeout or a
    // dropped connection genuinely does leave "did it arrive?" unanswered, and there the only safe
    // answer is to stay SUBMITTING and never re-sign (plan §2.1 biggest-risk rule).
    const REFUSED_BY_EXCHANGE = new Set(["RequestRejectedError", "UserInputError", "RateLimitError"]);
    const terminal = REFUSED_BY_EXCHANGE.has((e as Error).name);

    if (terminal) {
      // The refusal is terminal AND no order was created, so the daily slot this submit reserved
      // has to go back. Every other terminal path returns it — the zero-fill booker does it inside
      // its KILL, the real_not_configured rollback above does it inside its rollback — but this one
      // never reaches a booker, so it silently ate a swipe of the user's cap for an order the
      // exchange never accepted (four of them on 2026-08-17, all refused for region). Same shape as
      // the rollback: one transaction, gated on the transition actually landing so a concurrent
      // path cannot release the slot twice.
      await prisma.$transaction(async (tx) => {
        const failed = await tx.orderAttempt.updateMany({
          where: { id: attempt.id, state: "SUBMITTING" },
          data: { state: "FAILED", error: `post rejected: ${message}` },
        });
        if (failed.count > 0 && attempt.dir !== "EXIT") await releaseSwipeSlot(tx, user.id, capDay);
      });
      return NextResponse.json({ status: "failed", error: "post_rejected", detail: message }, { status: 409 });
    }
    // Ambiguous: the attempt stays SUBMITTING and keeps its slot, because the order may exist. The
    // orphan sweep resolves it against the exchange and releases the slot if it kills the attempt.
    await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "SUBMITTING" },
      data: { error: `post failed: ${message}` },
    });
    return NextResponse.json({ status: "submitting", error: "post_ambiguous" });
  }

  const rr = response as Record<string, unknown> | null;
  const externalOrderId = rr && typeof rr.orderId === "string" ? rr.orderId : null;

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

  // A POSTED row with no externalOrderId is invisible to BOTH sweeps: discoverOrphanAttempts scans
  // {state: SUBMITTING, externalOrderId: null} and reconcileStuckAttempts scans {externalOrderId:
  // {not: null}}. Nothing selects the intersection, so such a row sits forever with the money
  // possibly spent while the partial unique index keeps holding that market's slot. Advance to
  // POSTED only when the row can still be resolved from there — either there is an id to ask the
  // exchange about, or the verdict is terminal and the booking below moves the row off POSTED in
  // the same request. Otherwise leave it SUBMITTING, which is precisely the shape the orphan sweep
  // was built to adopt or kill.
  if (externalOrderId === null && (outcome.kind === "pending" || outcome.kind === "unknown")) {
    await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "SUBMITTING" },
      data: {
        postResponse: (response ?? undefined) as never,
        error: "posted without an order id — orphan discovery owns it",
      },
    });
    return NextResponse.json({ status: "submitting", error: "post_no_order_id" });
  }

  await prisma.orderAttempt.updateMany({
    where: { id: attempt.id, state: "SUBMITTING" },
    data: { state: "POSTED", postResponse: (response ?? undefined) as never, externalOrderId },
  });

  if (outcome.kind === "pending" || outcome.kind === "unknown") {
    return NextResponse.json({ status: "posted", outcome: outcome.kind });
  }
  const fills = outcome.kind === "matched" ? outcome.fills : []; // rejected → zero-fill KILLED path
  // The receipt carries the ORDER's cumulative matched totals — the booker subtracts what this
  // attempt already holds, so a re-delivered or grown receipt neither double-books nor drops fills.
  const bookOpts = { cumulative: outcome.kind === "matched" };
  // FILLED/PARTIAL is judged against the size actually SIGNED, not the intent's PREDICTED
  // sharesMicro. The SDK re-sizes and decimal-caps the order before signing (maker collateral is
  // floored to the tick's amount decimals), so the signed size sits systematically below the
  // prediction and a FAK that matched every share of itself still booked cumulative < predicted and
  // reported PARTIAL — real trace: predicted 18_605_546, signed 18_596_200, fully matched, labelled
  // partial. This value feeds fillLabel and nothing else (orders.ts:314/321/481/487), so it moves
  // the label without touching a booked amount. BUY: takerAmount is shares. SELL: makerAmount is.
  const signedSharesMicro = attempt.dir === "EXIT" ? BigInt(signed.makerAmount) : BigInt(signed.takerAmount);
  const finalState =
    attempt.dir === "EXIT"
      ? await bookExitFills(prisma, attempt, signedSharesMicro, fills, bookOpts)
      : await bookEntryFills(
          prisma,
          attempt,
          params?.betSide === "NO" ? "NO" : "YES",
          signedSharesMicro,
          fills,
          bookOpts,
        );
  return NextResponse.json({
    status: finalState.toLowerCase(),
    filledSharesMicro: fills.reduce((s, f) => s + f.sharesMicro, 0n).toString(),
  });
}
