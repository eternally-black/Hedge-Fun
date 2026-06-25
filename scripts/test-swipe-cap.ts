// Verifies the HARD daily swipe cap: a non-dev user is stopped at SWIPE_CAP (the
// next swipe throws and stores nothing), while a dev (capBypass) swipes past it.
// DB-backed. Run: npx tsx scripts/test-swipe-cap.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { recordSwipe, SwipeCapReachedError } from "../src/lib/swipe";
import { SWIPE_CAP } from "../src/lib/config";

async function main() {
  const tag = `captest-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} }, streak: { create: {} } },
  });

  // Seed SWIPE_CAP + 1 distinct markets.
  const markets = [];
  for (let i = 0; i <= SWIPE_CAP; i++) {
    markets.push(await prisma.market.create({
      data: { polymarketId: `${tag}-mkt-${i}`, question: `q${i}`, status: "OPEN",
        yesPriceBp: 5000, noPriceBp: 5000, resolutionDeadline: new Date(Date.now() + 3_600_000) },
    }));
  }

  // First SWIPE_CAP swipes succeed and each earns a point.
  for (let i = 0; i < SWIPE_CAP; i++) {
    const r = await recordSwipe({ userId: user.id, marketId: markets[i].id, side: "YES", lockedPriceBp: 5000 });
    assert.strictEqual(r.pointsAwarded, 1, `swipe ${i} earns`);
  }

  // The (cap+1)th HARD-STOPS for a normal user — throws, no bet stored.
  const over = markets[SWIPE_CAP];
  let stopped = false;
  try {
    await recordSwipe({ userId: user.id, marketId: over.id, side: "YES", lockedPriceBp: 5000 });
  } catch (e) {
    stopped = e instanceof SwipeCapReachedError;
  }
  assert.ok(stopped, "over-cap swipe throws SwipeCapReachedError");
  const bet = await prisma.bet.findUnique({ where: { userId_marketId: { userId: user.id, marketId: over.id } } });
  assert.strictEqual(bet, null, "no bet stored when hard-stopped");

  // Dev (capBypass) swipes PAST the cap — admin reset / testing relies on this.
  const dev = await recordSwipe({ userId: user.id, marketId: over.id, side: "YES", lockedPriceBp: 5000, capBypass: true });
  assert.strictEqual(dev.pointsAwarded, 1, "dev capBypass earns past the cap");

  // cleanup (children before parents)
  await prisma.bet.deleteMany({ where: { userId: user.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
  await prisma.market.deleteMany({ where: { polymarketId: { startsWith: `${tag}-mkt-` } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: user.id } });
  await prisma.streak.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log("OK: hard cap stops non-dev at", SWIPE_CAP, "; dev bypass swipes past");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
