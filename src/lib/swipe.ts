import type { BetSide } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay } from "./time";
import { writePoints } from "./points";
import { STAKE_CENTS, SWIPE_CAP } from "./config";

// Thrown when a non-dev user tries to swipe past the daily cap. The route turns it
// into a 403 so the client can show the "daily limit reached" screen.
export class SwipeCapReachedError extends Error {
  constructor() {
    super("daily swipe cap reached");
    this.name = "SwipeCapReachedError";
  }
}

// Record a swipe = a paper bet on a market outcome at a locked price.
// Cap (P-3): SWIPE_CAP swipes/day, each earns 1 raw point. HARD STOP — the
// (SWIPE_CAP+1)th swipe is rejected (throws SwipeCapReachedError), nothing is stored.
// Dev accounts (capBypass) are exempt: they swipe unlimited and earn every time.
// Atomicity: the daily swipeCount increment is the cap gate — it's the source of truth.
export async function recordSwipe(input: {
  userId: string;
  marketId: string;
  side: BetSide;
  lockedPriceBp: number;
  at?: Date;
  capBypass?: boolean; // dev test account: earn a point on every swipe, ignoring the daily cap
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
    // HARD STOP at the cap for normal users: reject the over-cap swipe so no bet is
    // stored. Throwing here rolls back the counter increment too (same transaction).
    // Dev accounts bypass the stop entirely.
    if (overCap && !input.capBypass) throw new SwipeCapReachedError();
    // Dev bypass: earn a point on every swipe regardless of the cap (for testing accrual).
    const earnedPoint = input.capBypass ? true : !overCap;

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
