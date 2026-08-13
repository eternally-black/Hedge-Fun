// scripts/test-real-isolation.ts — REAL bets are invisible to paper settlement (plan §2.2 isolation sweep).
// Run: npx tsx scripts/test-real-isolation.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { settleMarket, type Resolution } from "./settle";
import { randomCode } from "../src/lib/refcode";

async function main() {
  const tag = `realiso-${process.pid}-${Date.now() & 0xffffff}`;
  const utcDay = new Date().toISOString().slice(0, 10);
  const user = await prisma.user.create({
    data: {
      privyId: `did:privy:${tag}`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 20000 } },
      collectibleBalance: { create: {} },
      streak: { create: {} },
    },
  });
  const market = await prisma.market.create({
    data: {
      polymarketId: `${tag}-m1`,
      question: "real isolation test",
      status: "OPEN",
      yesPriceBp: 5000,
      noPriceBp: 5000,
      resolutionDeadline: new Date(Date.now() - 3_600_000), // near past
    },
  });

  // PAPER bet: YES @ 5000bp, stake 1000c, hold 1000c on VirtualBalance.
  const paperBet = await prisma.bet.create({
    data: {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      stakeCents: 1000,
      lockedPriceBp: 5000,
      utcDay,
      settlementStatus: "PENDING",
      mode: "PAPER",
    },
  });

  // REAL bet: same user, same market, same side/price — allowed by (userId, marketId, mode) unique.
  const realBet = await prisma.bet.create({
    data: {
      userId: user.id,
      marketId: market.id,
      side: "YES",
      stakeCents: 1000,
      lockedPriceBp: 5000,
      utcDay,
      settlementStatus: "PENDING",
      mode: "REAL",
      filledSharesMicro: 2_000_000n,
      spendMicro: 1_000_000n,
      feeMicro: 35_000n,
      vwapBp: 5000,
    },
  });

  // Hold the paper stake on the virtual balance (as a swipe would).
  await prisma.virtualBalance.update({
    where: { userId: user.id },
    data: { lockedCents: { increment: 1000 } },
  });

  const resolution: Resolution = { kind: "resolved", resolvedYes: true };

  // First settle: only the PAPER bet should settle.
  const r1 = await settleMarket(prisma, market.id, resolution);
  assert.strictEqual(r1.settled, 1, "exactly one bet settled (the paper one)");
  assert.strictEqual(r1.voided, 0, "no voids");
  assert.strictEqual(r1.shardsAwarded, 1, "paper win awarded a shard");

  // Paper bet: settled, WIN, payout = 1000 * 10000 / 5000 = 2000c, pnl = +1000c.
  const paperAfter = await prisma.bet.findUniqueOrThrow({ where: { id: paperBet.id } });
  assert.strictEqual(paperAfter.settlementStatus, "SETTLED");
  assert.strictEqual(paperAfter.result, "WIN");
  assert.strictEqual(paperAfter.payoutCents, 2000);
  assert.strictEqual(paperAfter.pnlCents, 1000);

  // REAL bet: untouched — still PENDING, all real fields unchanged.
  const realAfter = await prisma.bet.findUniqueOrThrow({ where: { id: realBet.id } });
  assert.strictEqual(realAfter.settlementStatus, "PENDING");
  assert.strictEqual(realAfter.result, "PENDING");
  assert.strictEqual(realAfter.payoutCents, null);
  assert.strictEqual(realAfter.pnlCents, null);
  assert.strictEqual(realAfter.filledSharesMicro, 2_000_000n);
  assert.strictEqual(realAfter.spendMicro, 1_000_000n);
  assert.strictEqual(realAfter.feeMicro, 35_000n);
  assert.strictEqual(realAfter.vwapBp, 5000);

  // VirtualBalance: hold released, balance credited ONLY the paper pnl (+1000).
  const vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, 0, "paper hold released");
  assert.strictEqual(vb.balanceCents, 21000, "balance = 20000 + 1000 paper pnl only");

  // Second settle: idempotent — nothing new settles, REAL bet still pending.
  const r2 = await settleMarket(prisma, market.id, resolution);
  assert.strictEqual(r2.settled, 0, "second settle is a no-op");
  const realAfter2 = await prisma.bet.findUniqueOrThrow({ where: { id: realBet.id } });
  assert.strictEqual(realAfter2.settlementStatus, "PENDING", "REAL bet still pending after second settle");

  console.log("OK: paper settlement never touches REAL bets — isolation verified");

  // Cleanup: children before parents (ShardGrant/PointsLedger FK → Bet, so those first;
  // the shard award also touched DailyCounter).
  await prisma.shardGrant.deleteMany({ where: { userId: user.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
  await prisma.streakEvent.deleteMany({ where: { userId: user.id } });
  await prisma.loginMark.deleteMany({ where: { userId: user.id } });
  await prisma.bet.deleteMany({ where: { userId: user.id } });
  await prisma.market.deleteMany({ where: { id: market.id } });
  await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: user.id } });
  await prisma.streak.deleteMany({ where: { userId: user.id } });
  await prisma.user.deleteMany({ where: { id: user.id } });

  console.log("PASS: real-isolation");
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
