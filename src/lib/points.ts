import type { Prisma, PointsType } from "@prisma/client";
import { ACTIVE_MULTIPLIER, type MultiplierContext } from "./multiplier";
import { diffDays } from "./time";

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

  // The current streak spans the last `currentLevel` consecutive UTC days (ending at the
  // most recent activity). Its swipe-days are the trailing swipe-days within that calendar
  // span — anchored to the latest swipe-day, include any swipe-day no more than
  // currentLevel-1 days older. Swiping is sparse vs qualifying (a streak day can have no
  // swipe), so we bound by calendar span, not strict day-adjacency. Reconstructing this
  // from the ledger means the one-time window bonus needs no extra streak fields / no
  // migration.
  const allDays = [...swipeByDay.keys()].sort(); // ascending 'YYYY-MM-DD'
  const anchor = allDays[allDays.length - 1]; // latest swipe-day = streak's end
  const streakSwipeDays: MultiplierContext["streakSwipeDays"] = [];
  if (anchor && streak.currentLevel > 0) {
    for (const day of allDays) {
      if (diffDays(anchor, day) <= streak.currentLevel - 1) {
        streakSwipeDays.push({ utcDay: day, raw: swipeByDay.get(day)! });
      }
    }
  }

  // The strategy scores only the current-streak days. Swipe points on days OUTSIDE the
  // current streak (older / non-consecutive) are never doubled — they count raw.
  const streakRaw = streakSwipeDays.reduce((sum, d) => sum + d.raw, 0);
  const outsideStreakSwipe = breakdown.SWIPE - streakRaw;
  const multipliedSwipe =
    outsideStreakSwipe +
    ACTIVE_MULTIPLIER.multipliedSwipePoints({
      userId,
      streakLevel: streak.currentLevel,
      streakState: streak.state,
      streakSwipeDays,
    });

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
