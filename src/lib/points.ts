import type { Prisma, PointsType } from "@prisma/client";
import { ACTIVE_MULTIPLIER, type MultiplierContext } from "./multiplier";

// Any Prisma client or transaction handle.
type Db = Prisma.TransactionClient | import("@prisma/client").PrismaClient;

// --- Write a RAW points row. Idempotent via DB unique constraints:
//   SWIPE: unique betId (1 point per bet, ever).
//   LOGIN/STREAK_X2: unique [userId, type, utcDay] (one per day).
// A duplicate write throws P2002 — callers that may retry should swallow it. ---
export async function writePoints(
  db: Db,
  w: {
    userId: string;
    type: PointsType;
    amount: number;
    utcDay: string;
    betId?: string;
    referralId?: string;
    metadata?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await db.pointsLedger.create({
    data: {
      userId: w.userId,
      type: w.type,
      amount: w.amount,
      utcDay: w.utcDay,
      betId: w.betId,
      referralId: w.referralId,
      metadata: w.metadata,
    },
  });
}

export interface ScoreResult {
  total: number;
  breakdown: Record<PointsType, number>;
  rawSwipe: number;
  bonusFromX2: number;
}

// Pure scoring core — applies ACTIVE_MULTIPLIER to swipe points per-day, sums the rest
// raw. DB-free so it's unit-testable. The ONLY multiplier consumer besides leaderboard SQL.
export function scorePoints(
  rows: { type: PointsType; amount: number; utcDay: string }[],
  streak: { currentLevel: number; state: MultiplierContext["streakState"] },
  userId: string,
): ScoreResult {
  const breakdown = { SWIPE: 0, LOGIN: 0, REFERRAL: 0, STREAK_X2: 0 } as Record<
    PointsType,
    number
  >;
  const swipeByDay = new Map<string, number>();
  for (const r of rows) {
    breakdown[r.type] += r.amount;
    if (r.type === "SWIPE") {
      swipeByDay.set(r.utcDay, (swipeByDay.get(r.utcDay) ?? 0) + r.amount);
    }
  }

  const base: Omit<MultiplierContext, "utcDay" | "swipePointsOnDay"> = {
    userId,
    streakLevel: streak.currentLevel,
    streakState: streak.state,
    cumulativeSwipePoints: breakdown.SWIPE, // lifetime raw swipe, drives the 70-pt trigger
  };

  let multipliedSwipe = 0;
  for (const [day, raw] of swipeByDay) {
    const m = ACTIVE_MULTIPLIER.multiplierForDay({
      ...base,
      utcDay: day,
      swipePointsOnDay: raw,
    });
    multipliedSwipe += raw * m;
  }

  const nonSwipe = breakdown.LOGIN + breakdown.REFERRAL + breakdown.STREAK_X2;
  return {
    total: nonSwipe + multipliedSwipe,
    breakdown,
    rawSwipe: breakdown.SWIPE,
    bonusFromX2: multipliedSwipe - breakdown.SWIPE,
  };
}

// Effective (multiplier-applied) total + raw breakdown for one user.
export async function effectivePoints(
  db: Db,
  userId: string,
): Promise<ScoreResult> {
  const [rows, streak] = await Promise.all([
    db.pointsLedger.findMany({
      where: { userId },
      select: { type: true, amount: true, utcDay: true },
    }),
    db.streak.findUnique({ where: { userId } }),
  ]);
  return scorePoints(
    rows,
    { currentLevel: streak?.currentLevel ?? 0, state: streak?.state ?? "ACTIVE" },
    userId,
  );
}
