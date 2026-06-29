import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { recordSwipe, InsufficientFundsError } from "@/lib/swipe";
import { DECK_MIN_LEAD_MS } from "@/lib/config";
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
  // EXEMPT TXODDS football: its resolutionDeadline is a synthetic kickoff+150min settle mark, not a
  // real close, so live in-play betting must stay open while the market is OPEN (status enforces that).
  if (market.source !== "TXODDS" && market.resolutionDeadline.getTime() <= Date.now() + DECK_MIN_LEAD_MS) {
    return NextResponse.json({ error: "market_expired" }, { status: 409 });
  }

  const lockedPriceBp = body.side === "YES" ? market.yesPriceBp : market.noPriceBp;

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
