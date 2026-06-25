import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { recordSwipe } from "@/lib/swipe";
import { maybeQualifyReferralOnSwipe } from "@/lib/referral";
import { isDevUser } from "@/lib/dev";

// Swipe = paper bet Yes/No on a deck market. Locks the BOUGHT side's price for P&L.
// ponytail: no request rate-limit (L2). The point cap (10/day) + one-bet-per-market (C1)
// bound farming, but a client can still spam over-cap bets creating DB rows. Add a real
// limiter (middleware / Redis) when the VPS is up — not worth in-process state for MVP.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { marketId?: string; side?: "YES" | "NO" }
    | null;
  if (!body?.marketId || (body.side !== "YES" && body.side !== "NO")) {
    return NextResponse.json({ error: "marketId and side (YES|NO) required" }, { status: 400 });
  }

  // Validate the market is still tradable; need both side prices to lock the right one.
  const market = await prisma.market.findUnique({ where: { id: body.marketId } });
  if (!market || market.status !== "OPEN" || market.yesPriceBp == null || market.noPriceBp == null) {
    return NextResponse.json({ error: "market not open" }, { status: 409 });
  }

  // Lock the price of the side the user actually bought (Polymarket yes+no don't sum to
  // exactly 1, so the NO price is its own number, not 10000-yes).
  const lockedPriceBp = body.side === "YES" ? market.yesPriceBp : market.noPriceBp;

  try {
    const result = await recordSwipe({
      userId: user.id,
      marketId: market.id,
      side: body.side,
      lockedPriceBp,
      capBypass: isDevUser(user.email), // dev account earns a point on every swipe
    });
    // Q7: once this user hits 10 LIFETIME swipes, qualify their referral and back-pay the
    // inviter's 20%. Counts lifetime bets itself — result.swipeCountToday is per-DAY, not the
    // gate. Called here (not in swipe.ts) to avoid a swipe<->referral circular import. Best-
    // effort: a failure here must not fail the swipe the user already made, so swallow + log.
    await maybeQualifyReferralOnSwipe(user.id).catch((e) =>
      console.error("referral qualify/accrue failed", e),
    );
    return NextResponse.json(result);
  } catch (e) {
    // P2002 on [userId, marketId] = already bet this market (one bet per card).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "already swiped this market" }, { status: 409 });
    }
    throw e;
  }
}
