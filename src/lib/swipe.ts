import type { BetSide } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay } from "./time";
import { writePoints } from "./points";
import { STAKE_CENTS, SWIPE_CAP } from "./config";

// Record a swipe = a paper bet on a market outcome at a locked price.
// Cap (P-3): first SWIPE_CAP/day earn 1 raw point each; over-cap swipes are still
// stored as bets but earn nothing (decided: allow over-cap, no points).
// Atomicity: the daily swipeCount increment is the cap gate — it's the source of truth.
export async function recordSwipe(input: {
  userId: string;
  marketId: string;
  side: BetSide;
  lockedPriceBp: number;
  at?: Date;
}): Promise<{
  betId: string;
  pointsAwarded: 0 | 1;
  overCap: boolean;
  swipeCountToday: number;
}> {
  const day = utcDay(input.at);

  return prisma.$transaction(async (tx) => {
    // Atomic per-day counter: upsert then read the post-increment value.
    const counter = await tx.dailyCounter.upsert({
      where: { userId_utcDay: { userId: input.userId, utcDay: day } },
      create: { userId: input.userId, utcDay: day, swipeCount: 1 },
      update: { swipeCount: { increment: 1 } },
      select: { swipeCount: true },
    });

    const overCap = counter.swipeCount > SWIPE_CAP;
    const earnedPoint = !overCap;

    const bet = await tx.bet.create({
      data: {
        userId: input.userId,
        marketId: input.marketId,
        side: input.side,
        stakeCents: STAKE_CENTS,
        lockedPriceBp: input.lockedPriceBp,
        utcDay: day,
        earnedPoint,
      },
      select: { id: true },
    });

    if (earnedPoint) {
      await writePoints(tx, {
        userId: input.userId,
        type: "SWIPE",
        amount: 1,
        utcDay: day,
        betId: bet.id, // unique -> 1 point per bet, ever
      });
    }

    return {
      betId: bet.id,
      pointsAwarded: (earnedPoint ? 1 : 0) as 0 | 1,
      overCap,
      swipeCountToday: counter.swipeCount,
    };
  });
}
