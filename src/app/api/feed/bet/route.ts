import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { recordSwipe, InsufficientFundsError } from "@/lib/swipe";
import { DECK_MIN_LEAD_MS, STAKE_CENTS } from "@/lib/config";
import { requoteSideForLock, quoteMovedAgainstUser, sourceHasClobBook } from "@/lib/depth";
import { captureToGlitchTip } from "@/lib/glitchtip";
import type { FeedBetRequest, FeedBetResponse } from "@/lib/api-types";

// Feed bet = a paper bet on a FEED market (the post-cap "лента"). Same $10 stake/cash-hold as a
// swipe, but source="FEED" so recordSwipe skips the daily cap + the points write entirely. Shards
// still accrue on a win (uncapped — settle.ts passes bypassCap for FEED). Deliberately NOT gated by
// isOverCap (the feed is what you get AFTER the cap) and does NOT run referral qualification (feed
// earns no points, so there's nothing to back-pay an inviter).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Partial<FeedBetRequest> | null;
  if (!body?.marketId || (body.side !== "YES" && body.side !== "NO")) {
    return NextResponse.json({ error: "marketId and side (YES|NO) required" }, { status: 400 });
  }

  // Validate the market is still tradable; need both side prices to lock the bought one. (Same
  // checks as /api/swipe — a feed market is a normal Market row.)
  const market = await prisma.market.findUnique({ where: { id: body.marketId } });
  if (!market || market.status !== "OPEN" || market.yesPriceBp == null || market.noPriceBp == null) {
    return NextResponse.json({ error: "market not open" }, { status: 409 });
  }
  // Freshness guard: reject a bet within DECK_MIN_LEAD_MS of resolution (stale, near-decided call).
  // EXEMPT a bookless source: its resolutionDeadline is a synthetic settle mark, not a
  // real close, so live in-play betting must stay open while the market is OPEN (status enforces that).
  if (sourceHasClobBook(market.source) && market.resolutionDeadline.getTime() <= Date.now() + DECK_MIN_LEAD_MS) {
    return NextResponse.json({ error: "market_expired" }, { status: 409 });
  }

  // Lock the bought side's price (D10). A bookless source keeps its stored odds; POLYMARKET re-quotes the
  // side LIVE against the CLOB book (never the Gamma mid). The feed is a second betting surface, so
  // it gets the same treatment as the deck swipe.
  let lockedPriceBp: number;
  if (!sourceHasClobBook(market.source)) {
    lockedPriceBp = body.side === "YES" ? market.yesPriceBp : market.noPriceBp;
  } else {
    const tokenId = body.side === "YES" ? market.yesTokenId : market.noTokenId;
    if (!tokenId) {
      return NextResponse.json({ error: "market_untradable" }, { status: 409 });
    }
    const q = await requoteSideForLock(tokenId, STAKE_CENTS);
    if (q.kind === "unavailable") {
      void captureToGlitchTip(new Error("clob book unavailable"), { route: "feed-bet" });
      return NextResponse.json({ error: "book_unavailable" }, { status: 502 });
    }
    if (q.kind !== "ok") {
      return NextResponse.json({ error: "market_untradable" }, { status: 409 });
    }
    // Seen-vs-executed guard — same rule as /api/swipe (see quoteMovedAgainstUser).
    if (typeof body.quotedPriceBp === "number" && quoteMovedAgainstUser(body.quotedPriceBp, q.effPriceBp)) {
      return NextResponse.json({ error: "price_moved", freshPriceBp: q.effPriceBp }, { status: 409 });
    }
    lockedPriceBp = q.effPriceBp;
  }

  try {
    const { betId } = await recordSwipe({
      userId: user.id,
      marketId: market.id,
      side: body.side,
      lockedPriceBp,
      source: "FEED", // no points, no cap; shards uncapped on settle
    });
    const res: FeedBetResponse = { betId };
    return NextResponse.json(res);
  } catch (e) {
    // No free Cash to cover the stake — nothing stored (tx rolled back).
    if (e instanceof InsufficientFundsError) {
      return NextResponse.json({ error: "insufficient_funds" }, { status: 402 });
    }
    // P2002 on [userId, marketId] = already bet this market (one bet per market, deck or feed).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "already bet this market" }, { status: 409 });
    }
    throw e;
  }
}
