// (4) effectivePoints is the DB wrapper /api/me hands Android as `points.total`. scorePoints (pure)
// is unit-tested already; this asserts the DB-reading wrapper actually loads the ledger + the streak
// and feeds them to the pure core so the x2 multiplier lands. Without this, a wrong streak read or a
// missing join would silently zero the bonus and Android would show wrong points.
// The x2 (ACTIVE = SevenDayWindowOneTime): a completed 7-day streak doubles the swipe points of one
// 7-day window, one time. We build a level-7 ACTIVE streak with 7 consecutive swipe-days (1 pt each)
// and assert effectivePoints doubles exactly those 7 (bonusFromX2 == 7), on top of raw LOGIN.
// Run: npx tsx scripts/test-effective-points.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { writePoints, effectivePoints } from "../src/lib/points";

async function main() {
  const tag = `efptest-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} },
      streak: { create: { currentLevel: 7, state: "ACTIVE", lastQualifiedDay: "2026-06-07" } } },
  });

  // 7 consecutive swipe-days, 1 pt each (the streak's window), anchored on lastQualifiedDay.
  const swipeDays = ["2026-06-01","2026-06-02","2026-06-03","2026-06-04","2026-06-05","2026-06-06","2026-06-07"];
  for (const d of swipeDays) {
    await writePoints(prisma, { userId: user.id, type: "SWIPE", amount: 1, utcDay: d });
  }
  // Plus a raw LOGIN point that must NOT be multiplied (only swipe points double).
  await writePoints(prisma, { userId: user.id, type: "LOGIN", amount: 1, utcDay: "2026-06-07" });

  const ep = await effectivePoints(prisma, user.id);

  // Raw breakdown reflects the ledger exactly.
  assert.strictEqual(ep.breakdown.SWIPE, 7, "raw swipe points = 7");
  assert.strictEqual(ep.breakdown.LOGIN, 1, "raw login points = 1");
  assert.strictEqual(ep.rawSwipe, 7, "rawSwipe surfaced = 7");

  // The x2 doubles the 7 in-window swipe-days exactly once: bonus = +7.
  assert.strictEqual(ep.bonusFromX2, 7, `x2 bonus doubles the 7 window swipe-days (got ${ep.bonusFromX2})`);
  // total = doubled swipe (7+7) + raw login (1) = 15. This is the number /api/me ships.
  assert.strictEqual(ep.total, 15, `effective total = 14 swipe + 1 login = 15 (got ${ep.total})`);

  // CONTROL: a user whose streak is level 0 (no completed window) gets NO bonus — proves the
  // wrapper actually reads streak state, not a hardcoded multiplier.
  const tag2 = `${tag}-flat`;
  const flat = await prisma.user.create({
    data: { privyId: `did:privy:${tag2}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} },
      streak: { create: { currentLevel: 0, state: "ACTIVE" } } },
  });
  for (const d of swipeDays) await writePoints(prisma, { userId: flat.id, type: "SWIPE", amount: 1, utcDay: d });
  const epFlat = await effectivePoints(prisma, flat.id);
  assert.strictEqual(epFlat.bonusFromX2, 0, "level-0 streak yields no x2 bonus");
  assert.strictEqual(epFlat.total, 7, "level-0 total = raw swipe, no doubling");

  // cleanup
  for (const id of [user.id, flat.id]) {
    await prisma.pointsLedger.deleteMany({ where: { userId: id } });
    await prisma.virtualBalance.deleteMany({ where: { userId: id } });
    await prisma.collectibleBalance.deleteMany({ where: { userId: id } });
    await prisma.streak.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [user.id, flat.id] } } });

  console.log("OK: effectivePoints reads ledger+streak, x2 doubles the window (bonus 7, total 15); level-0 flat");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
