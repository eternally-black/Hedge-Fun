import type { Prisma, PointsType } from "@prisma/client";

// Any Prisma client or transaction handle.
type Db = Prisma.TransactionClient | import("@prisma/client").PrismaClient;

// --- Write a RAW points row. Idempotent via DB unique constraints:
//   SWIPE: unique betId (1 point per bet, ever).
//   LOGIN: gated by LoginMark's [userId, utcDay] unique inside recordLogin's transaction
//     (there is NO ledger-level unique on [userId, type, utcDay]).
//   STREAK_X2: reserved.
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

// ── THE x2 MULTIPLIER (DECIDED, spec §8 Q1-2) ────────────────────────────────────────────────
// The bonus is written to the ledger by streak.ts when a 7-day window completes (STREAK_X2 rows),
// never derived at read time, never rewound. A lost streak can't take back what was already earned.
// scorePoints just sums every row: SWIPE raw + STREAK_X2 + LOGIN + REFERRAL + TOPUP_SPEND.
//
// Pure scoring core. DB-free so it's unit-testable. The ONLY x2 consumer besides leaderboard SQL.
export function scorePoints(
  rows: { type: PointsType; amount: number; utcDay: string }[],
): ScoreResult {
  // Typed initialiser: a compile error the moment PointsType grows — a new enum member must be
  // handled here, not silently yield NaN via a cast.
  const breakdown: Record<PointsType, number> = { SWIPE: 0, LOGIN: 0, REFERRAL: 0, STREAK_X2: 0, TOPUP_SPEND: 0 };
  for (const r of rows) {
    breakdown[r.type] += r.amount;
  }

  // TOPUP_SPEND rows carry NEGATIVE amounts (points spent on a cash top-up), so they subtract here
  // — never multiplied. No writer ships today (the points top-up was retired), but any historical
  // rows still net out correctly. Flows through this one core, so /me and admin ranking agree.
  const total = breakdown.SWIPE + breakdown.LOGIN + breakdown.REFERRAL + breakdown.STREAK_X2 + breakdown.TOPUP_SPEND;
  return {
    total,
    breakdown,
    rawSwipe: breakdown.SWIPE,
    bonusFromX2: breakdown.STREAK_X2,
  };
}

// Effective (multiplier-applied) total + raw breakdown for one user.
export async function effectivePoints(
  db: Db,
  userId: string,
): Promise<ScoreResult> {
  // Same input to the scorer in a fraction of the bytes; the scorer only ever needs per-day sums.
  const rows = await db.pointsLedger.groupBy({
    by: ["type", "utcDay"],
    where: { userId },
    _sum: { amount: true },
  });
  return scorePoints(rows.map((g) => ({ type: g.type, utcDay: g.utcDay, amount: g._sum.amount ?? 0 })));
}
