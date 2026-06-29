import type { BetSide, BetSource } from "@prisma/client";
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

// Thrown when the user's Cash can't cover the stake. Cash = balance − Σ(pending stakes).
// The route turns it into a 402 so the client can show "no free cash left".
export class InsufficientFundsError extends Error {
  constructor() {
    super("insufficient cash for stake");
    this.name = "InsufficientFundsError";
  }
}

// Cheap, NON-atomic read of whether this user's NEXT swipe today would be over the daily cap.
// True once they've already used SWIPE_CAP swipes (recordSwipe increments-then-compares, so the
// next one would push swipeCount to SWIPE_CAP+1 = over cap). The route uses this to 403 BEFORE
// opening the write transaction; recordSwipe still does the authoritative atomic gate for races.
export async function isOverCap(userId: string, at?: Date): Promise<boolean> {
  const counter = await prisma.dailyCounter.findUnique({
    where: { userId_utcDay: { userId, utcDay: utcDay(at) } },
    select: { swipeCount: true },
  });
  return (counter?.swipeCount ?? 0) >= SWIPE_CAP;
}

// Record a swipe = a paper bet on a market outcome at a locked price.
// Cap (P-3): SWIPE_CAP swipes/day, each earns 1 raw point. HARD STOP — the
// (SWIPE_CAP+1)th swipe is rejected (throws SwipeCapReachedError), nothing is stored.
// Dev accounts (capBypass) are exempt: they swipe unlimited and earn every time.
// Atomicity: the daily swipeCount increment is the cap gate — it's the source of truth.
//
// FEED bets (source="FEED") are the post-cap "лента": they DON'T touch the swipeCount counter, DON'T
// hit the cap stop, and earn NO points — but still lock the same $10 stake and (on a win) earn shards
// UNCAPPED (settle.ts passes bypassCap for FEED). So a feed bet skips steps 1–2 + the points write.
export async function recordSwipe(input: {
  userId: string;
  marketId: string;
  side: BetSide;
  lockedPriceBp: number;
  at?: Date;
  capBypass?: boolean; // dev test account: earn a point on every swipe, ignoring the daily cap
  source?: BetSource; // "DECK" (default, points+cap) | "FEED" (no points, no cap)
}): Promise<{
  betId: string;
  pointsAwarded: 0 | 1;
  overCap: boolean;
  swipeCountToday: number;
}> {
  const day = utcDay(input.at);
  const feed = input.source === "FEED";

  return prisma.$transaction(async (tx) => {
    // DECK only: atomic per-day cap counter (upsert + read post-increment). Feed bets are uncapped
    // and points-free, so they never increment the point-earning counter or hit the hard stop.
    let swipeCountToday = 0;
    let overCap = false;
    let earnedPoint = false;
    if (!feed) {
      const counter = await tx.dailyCounter.upsert({
        where: { userId_utcDay: { userId: input.userId, utcDay: day } },
        create: { userId: input.userId, utcDay: day, swipeCount: 1 },
        update: { swipeCount: { increment: 1 } },
        select: { swipeCount: true },
      });
      swipeCountToday = counter.swipeCount;
      overCap = counter.swipeCount > SWIPE_CAP;
      // HARD STOP at the cap for normal users: reject the over-cap swipe so no bet is
      // stored. Throwing here rolls back the counter increment too (same transaction).
      // Dev accounts bypass the stop entirely.
      if (overCap && !input.capBypass) throw new SwipeCapReachedError();
      // Dev bypass: earn a point on every swipe regardless of the cap (for testing accrual).
      earnedPoint = input.capBypass ? true : !overCap;
    }

    const bet = await tx.bet.create({
      data: {
        userId: input.userId,
        marketId: input.marketId,
        side: input.side,
        stakeCents: STAKE_CENTS,
        lockedPriceBp: input.lockedPriceBp,
        utcDay: day,
        earnedPoint,
        source: feed ? "FEED" : "DECK",
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

    // Cash gate as an atomic conditional HOLD (bank-style): place STAKE_CENTS onto "lockedCents"
    // only if free Cash ("balanceCents" − "lockedCents") still covers it. The WHERE makes the check
    // + the increment one indivisible DB write, so two concurrent swipes can't both pass — the
    // second's WHERE sees the first's incremented "lockedCents" and updates 0 rows. "balanceCents"
    // is never decremented; the hold is released by settle. Raw SQL because the guard compares two
    // columns (balance − locked), which Prisma's typed `where` can't express. Column names are
    // camelCase (no @map on the fields, only @@map on the table) so they must be double-quoted.
    // Returns the affected row count; 0 ⇒ not enough Cash ⇒ throw (rolls back bet + counter + points).
    const held = await tx.$executeRaw`
      UPDATE virtual_balances
         SET "lockedCents" = "lockedCents" + ${STAKE_CENTS}
       WHERE "userId" = ${input.userId}
         AND "balanceCents" - "lockedCents" >= ${STAKE_CENTS}`;
    if (held === 0) throw new InsufficientFundsError();

    return {
      betId: bet.id,
      pointsAwarded: (earnedPoint ? 1 : 0) as 0 | 1,
      overCap,
      swipeCountToday,
    };
  });
}
