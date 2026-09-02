// (4) effectivePoints is the DB wrapper /api/me hands Android as `points.total`. scorePoints (pure)
// is unit-tested already; this asserts the DB-reading wrapper actually loads the ledger and sums it
// so the materialised STREAK_X2 bonus lands. Without this, a wrong ledger read would silently zero
// the bonus and Android would show wrong points.
// The x2 (ACTIVE = SevenDayWindowOneTime): a completed 7-day streak writes a STREAK_X2 row for the
// swipe points of one 7-day window. We seed a STREAK_X2 row of 7 (as streak.ts would) and assert
// effectivePoints sums it (bonusFromX2 == 7), on top of raw SWIPE + LOGIN.
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
  // The materialised x2 bonus for that window (what streak.ts writes at level 7).
  await writePoints(prisma, { userId: user.id, type: "STREAK_X2", amount: 7, utcDay: "2026-06-07", metadata: { level: 7 } });
  // Plus a raw LOGIN point that must NOT be multiplied (only swipe points double).
  await writePoints(prisma, { userId: user.id, type: "LOGIN", amount: 1, utcDay: "2026-06-07" });

  const ep = await effectivePoints(prisma, user.id);

  // Raw breakdown reflects the ledger exactly.
  assert.strictEqual(ep.breakdown.SWIPE, 7, "raw swipe points = 7");
  assert.strictEqual(ep.breakdown.LOGIN, 1, "raw login points = 1");
  assert.strictEqual(ep.rawSwipe, 7, "rawSwipe surfaced = 7");

  // The x2 bonus is a ledger row: bonus = +7.
  assert.strictEqual(ep.bonusFromX2, 7, `x2 bonus from STREAK_X2 row (got ${ep.bonusFromX2})`);
  // total = raw swipe (7) + STREAK_X2 (7) + raw login (1) = 15. This is the number /api/me ships.
  assert.strictEqual(ep.total, 15, `effective total = 7 swipe + 7 bonus + 1 login = 15 (got ${ep.total})`);

  // CONTROL: a user with no STREAK_X2 row gets NO bonus — proves the wrapper sums the ledger.
  const tag2 = `${tag}-flat`;
  const flat = await prisma.user.create({
    data: { privyId: `did:privy:${tag2}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} },
      streak: { create: { currentLevel: 0, state: "ACTIVE" } } },
  });
  for (const d of swipeDays) await writePoints(prisma, { userId: flat.id, type: "SWIPE", amount: 1, utcDay: d });
  const epFlat = await effectivePoints(prisma, flat.id);
  assert.strictEqual(epFlat.bonusFromX2, 0, "no STREAK_X2 row -> no x2 bonus");
  assert.strictEqual(epFlat.total, 7, "flat total = raw swipe, no bonus");

  // cleanup
  for (const id of [user.id, flat.id]) {
    await prisma.pointsLedger.deleteMany({ where: { userId: id } });
    await prisma.virtualBalance.deleteMany({ where: { userId: id } });
    await prisma.collectibleBalance.deleteMany({ where: { userId: id } });
    await prisma.streak.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [user.id, flat.id] } } });

  console.log("OK: effectivePoints reads ledger, sums STREAK_X2 (bonus 7, total 15); no-row flat");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
