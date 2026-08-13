// scripts/test-funding-watch.ts — DB test for the deposit watcher (plan §2.5).
// Run: npx tsx scripts/test-funding-watch.ts
import assert from "node:assert";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { watchFunding } from "../src/lib/funding";
import type { BalanceReader } from "../src/lib/polygon";

async function main() {
  const tag = `fundwatch-${process.pid}-${Date.now() & 0xffffff}`;
  const userA = await prisma.user.create({
    data: {
      privyId: `did:privy:${tag}-a`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      depositWalletAddress: `0x${"11".repeat(20)}`,
    },
  });
  const userB = await prisma.user.create({
    data: {
      privyId: `did:privy:${tag}-b`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      depositWalletAddress: `0x${"22".repeat(20)}`,
    },
  });
  const userC = await prisma.user.create({
    data: {
      privyId: `did:privy:${tag}-c`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      depositWalletAddress: `0x${"33".repeat(20)}`,
    },
  });

  const now0 = new Date();
  const attemptA = await prisma.fundingAttempt.create({
    data: {
      userId: userA.id,
      state: "AWAITING",
      baselineUsdceMicro: 0n,
      baselinePusdMicro: 0n,
      latestUsdceMicro: 0n,
      latestPusdMicro: 0n,
      declaredAt: new Date(now0.getTime() - 2 * 60 * 1000), // 2 min ago
      lastCheckedAt: null,
    },
  });

  // Fake reader over a mutable balance state, keyed by token address.
  const balances = { usdce: 0n, pusd: 0n };
  const fakeReader: BalanceReader = async (token) =>
    token.toLowerCase().includes("2791") ? balances.usdce : balances.pusd;

  // 1. Initial watch: checked, state stays AWAITING, no alert (age < 60m).
  let r = await watchFunding(prisma, fakeReader, new Date(now0.getTime() + 1000));
  assert.strictEqual(r.checked, 1, "one attempt checked");
  assert.strictEqual(r.detected, 0);
  assert.strictEqual(r.funded, 0);
  let row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attemptA.id } });
  assert.strictEqual(row.state, "AWAITING");
  assert.strictEqual(row.alertedAt, null, "no alert before 60m");

  // 2. USDC.e delta → DETECTED (wrap-needed).
  balances.usdce = 2_000_000n;
  r = await watchFunding(prisma, fakeReader, new Date(now0.getTime() + 2 * 60 * 1000));
  assert.strictEqual(r.checked, 1);
  assert.strictEqual(r.detected, 1);
  row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attemptA.id } });
  assert.strictEqual(row.state, "DETECTED");

  // 3. pUSD delta → FUNDED, fundedAt set.
  balances.pusd = 2_000_000n;
  r = await watchFunding(prisma, fakeReader, new Date(now0.getTime() + 3 * 60 * 1000));
  assert.strictEqual(r.checked, 1);
  assert.strictEqual(r.funded, 1);
  row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attemptA.id } });
  assert.strictEqual(row.state, "FUNDED");
  assert.ok(row.fundedAt, "fundedAt set");

  // 4. FUNDED excluded from future watches.
  r = await watchFunding(prisma, fakeReader, new Date(now0.getTime() + 4 * 60 * 1000));
  assert.strictEqual(r.checked, 0, "FUNDED excluded");

  // 5. Cadence: fresh attempt for userB; immediate re-run 10s later → not due (60s interval).
  const attemptB = await prisma.fundingAttempt.create({
    data: {
      userId: userB.id,
      state: "AWAITING",
      baselineUsdceMicro: 0n,
      baselinePusdMicro: 0n,
      latestUsdceMicro: 0n,
      latestPusdMicro: 0n,
      declaredAt: new Date(),
      lastCheckedAt: null,
    },
  });
  const zeroReader: BalanceReader = async () => 0n;
  r = await watchFunding(prisma, zeroReader, new Date());
  assert.strictEqual(r.checked, 1, "userB first check");
  r = await watchFunding(prisma, zeroReader, new Date(Date.now() + 10_000));
  assert.strictEqual(r.checked, 0, "60s interval not elapsed");

  // 6. Error path: reader throws → error counted, state and lastCheckedAt unchanged.
  const throwingReader: BalanceReader = async () => {
    throw new Error("rpc down");
  };
  const beforeError = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attemptB.id } });
  r = await watchFunding(prisma, throwingReader, new Date(Date.now() + 70_000));
  assert.strictEqual(r.errors, 1, "error counted");
  assert.strictEqual(r.checked, 0, "errored check not counted as checked");
  const afterError = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attemptB.id } });
  assert.strictEqual(afterError.state, beforeError.state, "state unchanged on error");
  assert.strictEqual(
    afterError.lastCheckedAt?.getTime(),
    beforeError.lastCheckedAt?.getTime(),
    "lastCheckedAt unchanged on error",
  );

  // 7. One-active guard: second active row for userB → P2002 off the partial unique.
  await assert.rejects(
    prisma.fundingAttempt.create({
      data: {
        userId: userB.id,
        state: "AWAITING",
        baselineUsdceMicro: 0n,
        baselinePusdMicro: 0n,
        latestUsdceMicro: 0n,
        latestPusdMicro: 0n,
        declaredAt: new Date(),
        lastCheckedAt: null,
      },
    }),
    (e: unknown) => {
      assert.ok(e instanceof Prisma.PrismaClientKnownRequestError, "known prisma error");
      assert.strictEqual(e.code, "P2002");
      return true;
    },
  );

  // 8. Alert-once: attempt aged 2h with nothing on chain → alertedAt set exactly once.
  //    (sendOpsTelegram no-ops without TELEGRAM_* env — verified in glitchtip.ts.)
  const attemptC = await prisma.fundingAttempt.create({
    data: {
      userId: userC.id,
      state: "AWAITING",
      baselineUsdceMicro: 0n,
      baselinePusdMicro: 0n,
      latestUsdceMicro: 0n,
      latestPusdMicro: 0n,
      declaredAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
      lastCheckedAt: null,
    },
  });
  r = await watchFunding(prisma, zeroReader, new Date());
  row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attemptC.id } });
  assert.ok(row.alertedAt, "alertedAt set after 60m+");
  const firstAlert = row.alertedAt;

  r = await watchFunding(prisma, zeroReader, new Date(Date.now() + 5 * 60 * 1000 + 1000));
  row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attemptC.id } });
  assert.strictEqual(row.alertedAt?.getTime(), firstAlert?.getTime(), "alert sent once");

  console.log("OK: funding watcher — deltas, cadence, error isolation, one-active guard, alert-once");

  // Cleanup.
  await prisma.fundingAttempt.deleteMany({ where: { userId: { in: [userA.id, userB.id, userC.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id, userC.id] } } });

  console.log("PASS: funding-watch");
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
