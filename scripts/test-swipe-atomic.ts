// recordSwipe is the cap GATE: the per-day swipeCount increment is the source of truth, and
// it lives in the same $transaction as the bet + points write. Two things must hold or it's
// money/points: (1) concurrent swipes never double-count a day past the cap, and (2) when the
// over-cap swipe THROWS, the counter increment rolls back with it (no phantom count, no bet,
// no point). test-swipe-cap covers the sequential happy path; this covers the race + rollback.
// DB-backed. Run: npx tsx scripts/test-swipe-atomic.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { recordSwipe, SwipeCapReachedError } from "../src/lib/swipe";
import { SWIPE_CAP } from "../src/lib/config";
import { randomCode } from "../src/lib/refcode";

async function main() {
  const tag = `atomictest-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(), virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} }, streak: { create: {} } },
  });

  // Enough distinct markets for the concurrent burst + a few extras.
  const markets = [];
  for (let i = 0; i < SWIPE_CAP + 5; i++) {
    markets.push(await prisma.market.create({
      data: { polymarketId: `${tag}-mkt-${i}`, question: `q${i}`, status: "OPEN",
        yesPriceBp: 5000, noPriceBp: 5000, resolutionDeadline: new Date(Date.now() + 3_600_000) },
    }));
  }

  // (1) RACE: fire SWIPE_CAP+3 swipes concurrently on distinct markets. The atomic upsert
  // increment must serialize so EXACTLY SWIPE_CAP earn a point and the rest hard-stop — never
  // more than the cap, even under contention on the same daily counter row.
  const burst = SWIPE_CAP + 3;
  const results = await Promise.allSettled(
    markets.slice(0, burst).map((m) =>
      recordSwipe({ userId: user.id, marketId: m.id, side: "YES", lockedPriceBp: 5000 }),
    ),
  );
  const earned = results.filter((r) => r.status === "fulfilled" && r.value.pointsAwarded === 1).length;
  const stopped = results.filter(
    (r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof SwipeCapReachedError,
  ).length;

  assert.strictEqual(earned, SWIPE_CAP, `exactly SWIPE_CAP earn under race (got ${earned})`);
  assert.strictEqual(stopped, burst - SWIPE_CAP, `the rest hard-stop (got ${stopped})`);

  // The ledger and counter must agree with the cap — no over-count from the race.
  const points = await prisma.pointsLedger.count({ where: { userId: user.id, type: "SWIPE" } });
  assert.strictEqual(points, SWIPE_CAP, "ledger has exactly SWIPE_CAP swipe points");
  const counter = await prisma.dailyCounter.findUniqueOrThrow({
    where: { userId_utcDay: { userId: user.id, utcDay: new Date().toISOString().slice(0, 10) } },
  });
  // The counter counts ALL attempts that committed their increment. Over-cap throws roll their
  // own increment back, so the counter must equal exactly SWIPE_CAP (the committed swipes).
  assert.strictEqual(counter.swipeCount, SWIPE_CAP, `counter == SWIPE_CAP, throws rolled back (got ${counter.swipeCount})`);

  // (2) ROLLBACK: the next over-cap swipe throws. Assert it stored NOTHING — no bet, no point,
  // and the counter did NOT advance (the increment rolled back with the throw).
  const before = (await prisma.dailyCounter.findUniqueOrThrow({
    where: { userId_utcDay: { userId: user.id, utcDay: new Date().toISOString().slice(0, 10) } },
  })).swipeCount;
  const overMkt = markets[burst]; // a fresh, never-swiped market
  let threw = false;
  try {
    await recordSwipe({ userId: user.id, marketId: overMkt.id, side: "YES", lockedPriceBp: 5000 });
  } catch (e) {
    threw = e instanceof SwipeCapReachedError;
  }
  assert.ok(threw, "over-cap swipe throws SwipeCapReachedError");
  const after = (await prisma.dailyCounter.findUniqueOrThrow({
    where: { userId_utcDay: { userId: user.id, utcDay: new Date().toISOString().slice(0, 10) } },
  })).swipeCount;
  assert.strictEqual(after, before, "throw rolled back the counter increment (no phantom count)");
  const overBet = await prisma.bet.findUnique({ where: { userId_marketId_mode: { userId: user.id, marketId: overMkt.id, mode: "PAPER" } } });
  assert.strictEqual(overBet, null, "throw stored no bet");
  const pointsAfter = await prisma.pointsLedger.count({ where: { userId: user.id, type: "SWIPE" } });
  assert.strictEqual(pointsAfter, SWIPE_CAP, "throw wrote no point");

  // cleanup (children before parents)
  await prisma.bet.deleteMany({ where: { userId: user.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
  await prisma.market.deleteMany({ where: { polymarketId: { startsWith: `${tag}-mkt-` } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: user.id } });
  await prisma.streak.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log("OK: cap holds under concurrent swipes; over-cap throw rolls back counter+bet+point");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
