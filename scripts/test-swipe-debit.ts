// The Cash gate in recordSwipe: a swipe is rejected when Cash (= balance − Σ pending stakes) can't
// cover the stake. Must hold under a concurrent burst: two swipes can't BOTH pass the check and
// over-spend (Serializable tx). When the gate THROWS, the bet+counter+point roll back. DB-backed.
// Run: npx tsx scripts/test-swipe-debit.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { recordSwipe, InsufficientFundsError } from "../src/lib/swipe";
import { STAKE_CENTS } from "../src/lib/config";
import { randomCode } from "../src/lib/refcode";

async function main() {
  const tag = `debittest-${process.pid}-${Date.now() & 0xffffff}`;
  // Balance fits exactly K stakes, with a fractional remainder so the (K+1)th can't squeak in.
  const K = 3;
  const startBalance = K * STAKE_CENTS + Math.floor(STAKE_CENTS / 2); // e.g. 3.5 stakes
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(), virtualBalance: { create: { balanceCents: startBalance } }, collectibleBalance: { create: {} }, streak: { create: {} } },
  });

  const burst = K + 4; // more swipes than the balance can fund (and well under SWIPE_CAP)
  const markets = [];
  for (let i = 0; i < burst; i++) {
    markets.push(await prisma.market.create({
      data: { polymarketId: `${tag}-mkt-${i}`, question: `q${i}`, status: "OPEN",
        yesPriceBp: 5000, noPriceBp: 5000, resolutionDeadline: new Date(Date.now() + 3_600_000) },
    }));
  }

  // RACE: fire all concurrently. EXACTLY K must succeed; the rest throw InsufficientFundsError.
  // No combination of survivors may lock more than the balance (Cash never goes negative).
  const results = await Promise.allSettled(
    markets.map((m) => recordSwipe({ userId: user.id, marketId: m.id, side: "YES", lockedPriceBp: 5000 })),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const broke = results.filter(
    (r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof InsufficientFundsError,
  ).length;

  assert.strictEqual(ok, K, `exactly K=${K} swipes funded under race (got ${ok})`);
  assert.strictEqual(broke, burst - K, `the rest throw InsufficientFundsError (got ${broke})`);

  // The stored hold (lockedCents) must equal K stakes and never exceed the balance → Cash >= 0.
  const vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, K * STAKE_CENTS, `lockedCents == K stakes (got ${vb.lockedCents})`);
  assert.ok(startBalance - vb.lockedCents >= 0, "Cash never negative");
  // It must also match the PENDING-stake sum (the hold mirrors the open bets).
  const pendingSum = (await prisma.bet.aggregate({ _sum: { stakeCents: true }, where: { userId: user.id, settlementStatus: "PENDING" } }))._sum.stakeCents ?? 0;
  assert.strictEqual(vb.lockedCents, pendingSum, "hold mirrors Σ pending stakes");

  // Exactly K bets stored — the throws stored nothing.
  const bets = await prisma.bet.count({ where: { userId: user.id } });
  assert.strictEqual(bets, K, `exactly K bets persisted (got ${bets})`);

  // balanceCents is NEVER decremented on swipe — the stake is held in lockedCents, not debited.
  assert.strictEqual(vb.balanceCents, startBalance, "balance unchanged by swipes (held, not debited)");

  // cleanup
  await prisma.bet.deleteMany({ where: { userId: user.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
  await prisma.market.deleteMany({ where: { polymarketId: { startsWith: `${tag}-mkt-` } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: user.id } });
  await prisma.streak.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log("OK: cash gate funds exactly K swipes under race; throws roll back; balance never debited");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
