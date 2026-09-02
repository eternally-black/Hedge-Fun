// One-off backfill: materialise the x2 streak bonus as STREAK_X2 ledger rows for every user
// whose streak is at level >= 7 but who has no STREAK_X2 row yet. Run once right after deploying
// the materialised-bonus change; without it every user at level >= 7 would see their bonus vanish
// for one day until their next window completes. Run: npm run backfill-streak-x2
//
// Why needed: the x2 bonus used to be recomputed at read time from the live streak level. Now it's
// written to the ledger when a 7-day window completes (streak.ts awardX2Window). Users who already
// passed level 7/14/... before this change have no STREAK_X2 rows, so this script pays what the old
// read-time rule would have shown them. Idempotent — skips users who already have a STREAK_X2 row.
import { prisma } from "../src/lib/prisma";
import { diffDays } from "../src/lib/time";

// Reimplement the OLD read-time window rule locally: the earliest floor(level/7)*7 swipe-days of
// the current streak (anchored to the latest swipe-day, within a `currentLevel`-day calendar span)
// were doubled. This is what scorePoints used to pay before the materialisation change.
async function oldRuleBonus(userId: string, level: number): Promise<number> {
  if (level < 7) return 0;
  const swipeDays = await prisma.pointsLedger.groupBy({
    by: ["utcDay"],
    where: { userId, type: "SWIPE" },
    _sum: { amount: true },
    orderBy: { utcDay: "desc" },
  });
  const anchor = swipeDays[0]?.utcDay;
  if (!anchor) return 0;

  // The current streak's swipe-days = the trailing swipe-days within a `currentLevel`-day span,
  // EARLIEST first (the old rule doubled the earliest floor(level/7)*7 of them).
  const inStreak = swipeDays.filter((d) => diffDays(anchor, d.utcDay) <= level - 1).reverse();
  const doubledDays = Math.floor(level / 7) * 7;
  let bonus = 0;
  for (let i = 0; i < Math.min(doubledDays, inStreak.length); i++) {
    bonus += inStreak[i]!._sum.amount ?? 0;
  }
  return bonus;
}

async function main() {
  const streaks = await prisma.streak.findMany({
    where: { currentLevel: { gte: 7 } },
    select: { userId: true, currentLevel: true },
  });
  let written = 0;
  let skipped = 0;

  for (const s of streaks) {
    const existing = await prisma.pointsLedger.findFirst({
      where: { userId: s.userId, type: "STREAK_X2" },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }

    const amount = await oldRuleBonus(s.userId, s.currentLevel);
    if (amount <= 0) { skipped++; continue; }

    await prisma.pointsLedger.create({
      data: {
        userId: s.userId,
        type: "STREAK_X2",
        amount,
        utcDay: new Date().toISOString().slice(0, 10),
        metadata: { backfill: true, level: s.currentLevel },
      },
    });
    written++;
    console.log(`  ${s.userId.slice(0, 10)}… level ${s.currentLevel} -> +${amount}`);
  }

  console.log(`\nbackfill done: ${written} STREAK_X2 rows written, ${skipped} skipped (total ${streaks.length}).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
