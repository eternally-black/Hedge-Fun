import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { recordSwipe, isOverCap, SwipeCapReachedError, InsufficientFundsError } from "@/lib/swipe";
import { maybeQualifyReferralOnSwipe } from "@/lib/referral";
import { DECK_MIN_LEAD_MS, STAKE_CENTS } from "@/lib/config";
import { requoteSideForLock, quoteMovedAgainstUser, sourceHasClobBook } from "@/lib/depth";
import { isDevUser } from "@/lib/dev";
import type { SwipeRequest, SwipeResponse } from "@/lib/api-types";

// Swipe = paper bet Yes/No on a deck market. Locks the BOUGHT side's price for P&L.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Partial<SwipeRequest> | null;
  if (!body?.marketId || (body.side !== "YES" && body.side !== "NO")) {
    return NextResponse.json({ error: "marketId and side (YES|NO) required" }, { status: 400 });
  }

  const capBypass = isDevUser(user.email); // dev account earns a point on every swipe, unlimited
  // Cheap pre-write cap gate: reject an over-cap swipe with 403 BEFORE opening the recordSwipe
  // transaction, so a client hammering past the daily cap can't even create a Bet row to inflate
  // the DB. recordSwipe still does the AUTHORITATIVE atomic check (counter increment in-tx) — this
  // is just an early bail so the common over-cap case never touches the write path. Dev bypasses.
  if (!capBypass && (await isOverCap(user.id))) {
    return NextResponse.json({ error: "daily swipe limit reached" }, { status: 403 });
  }

  // Validate the market is still tradable; need both side prices to lock the right one.
  const market = await prisma.market.findUnique({ where: { id: body.marketId } });
  if (!market || market.status !== "OPEN" || market.yesPriceBp == null || market.noPriceBp == null) {
    return NextResponse.json({ error: "market not open" }, { status: 409 });
  }
  // Freshness guard: reject a bet within DECK_MIN_LEAD_MS of resolution. A market can still be
  // cached OPEN while already past (or seconds from) its deadline before the poller settles it —
  // betting then is a stale, near-decided call. The client (deck prune) should keep these off the
  // top; this is the server safety net. 409 -> the client advances the card silently.
  if (market.resolutionDeadline.getTime() <= Date.now() + DECK_MIN_LEAD_MS) {
    return NextResponse.json({ error: "market_expired" }, { status: 409 });
  }

  // Lock the price of the side the user actually bought (D10).
  let lockedPriceBp: number;
  if (!sourceHasClobBook(market.source)) {
    // Bookless source: no CLOB book exists, so its stored odds ARE the price (see src/lib/depth.ts).
    lockedPriceBp = body.side === "YES" ? market.yesPriceBp : market.noPriceBp;
  } else {
    // POLYMARKET: re-quote the bought side LIVE against the CLOB book and lock the VWAP the book
    // can actually deliver — never the Gamma mid (that is the 2x lie D10 exists to kill). A market
    // without token ids is not quotable. No client quote echo in this slice: a request without a
    // displayed quote locks the fresh effective price silently — strictly better than today's mid,
    // and it keeps old RN builds working.
    const tokenId = body.side === "YES" ? market.yesTokenId : market.noTokenId;
    if (!tokenId) {
      return NextResponse.json({ error: "market_untradable" }, { status: 409 });
    }
    const q = await requoteSideForLock(tokenId, STAKE_CENTS);
    if (q.kind === "unavailable") {
      return NextResponse.json({ error: "book_unavailable" }, { status: 502 });
    }
    if (q.kind !== "ok") {
      return NextResponse.json({ error: "market_untradable" }, { status: 409 });
    }
    // Seen-vs-executed guard (D10 Slice B). The client polls the top card every few seconds, so the
    // usual case is that this re-quote hits the very book the user was looking at and nothing fires.
    // When the book HAS moved against them beyond tolerance, refuse rather than book a worse price
    // silently — and hand back the fresh price so the card re-renders honestly and waits for a
    // deliberate re-swipe. A move in the user's favour executes without comment.
    if (typeof body.quotedPriceBp === "number" && quoteMovedAgainstUser(body.quotedPriceBp, q.effPriceBp)) {
      return NextResponse.json({ error: "price_moved", freshPriceBp: q.effPriceBp }, { status: 409 });
    }
    lockedPriceBp = q.effPriceBp;
  }

  try {
    const result = await recordSwipe({
      userId: user.id,
      marketId: market.id,
      side: body.side,
      lockedPriceBp,
      capBypass, // dev account earns a point on every swipe, ignoring the daily cap
    });
    // Q7: once this user hits 10 LIFETIME swipes, qualify their referral and back-pay the
    // inviter's 20%. Counts lifetime bets itself — result.swipeCountToday is per-DAY, not the
    // gate. Called here (not in swipe.ts) to avoid a swipe<->referral circular import. Best-
    // effort: a failure here must not fail the swipe the user already made, so swallow + log.
    await maybeQualifyReferralOnSwipe(user.id).catch((e) =>
      console.error("referral qualify/accrue failed", e),
    );
    const res: SwipeResponse = result;
    return NextResponse.json(res);
  } catch (e) {
    // Hard daily cap: the (cap+1)th swipe is rejected, nothing stored.
    if (e instanceof SwipeCapReachedError) {
      return NextResponse.json({ error: "daily swipe limit reached" }, { status: 403 });
    }
    // No free Cash to cover the stake — nothing stored (tx rolled back).
    if (e instanceof InsufficientFundsError) {
      return NextResponse.json({ error: "insufficient_funds" }, { status: 402 });
    }
    // P2002 on [userId, marketId] = already bet this market (one bet per card).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "already swiped this market" }, { status: 409 });
    }
    throw e;
  }
}
