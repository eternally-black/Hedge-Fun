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

  // ---- Deposit ATTRIBUTION (§2.5): the watcher's transitions come from Transfer logs when a
  // chain probe is passed. The regression it exists for: an OUTFLOW (a trade, a withdrawal) makes
  // the balance delta negative and the old watcher could never transition. Without a probe the
  // delta path is unchanged — every section above still exercises it.
  const attrWallet = `0x${"44".repeat(20)}`;
  const attrUser = await prisma.user.create({
    data: {
      privyId: `did:privy:${tag}-attr`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      depositWalletAddress: attrWallet,
    },
  });
  const attrAttempt = await prisma.fundingAttempt.create({
    data: {
      userId: attrUser.id,
      state: "AWAITING",
      baselineUsdceMicro: 5_000_000n, // the wallet HELD $5 at declare time…
      baselinePusdMicro: 0n,
      latestUsdceMicro: 5_000_000n,
      latestPusdMicro: 0n,
      declaredAt: new Date(Date.now() - 60_000),
      lastCheckedAt: null,
    },
  });

  const head = { n: 100_000n };
  const logs: { token: "usdce" | "pusd"; block: bigint; micro: bigint; tx: string }[] = [];
  const ranges: { from: bigint; to: bigint }[] = [];
  const chain = {
    head: async () => head.n,
    incoming: async (token: string, holder: string, from: bigint, to: bigint) => {
      ranges.push({ from, to });
      if (holder.toLowerCase() !== attrWallet) return { totalMicro: 0n, transfers: 0, lastTxHash: null };
      const kind = token.toLowerCase().includes("2791") ? "usdce" : "pusd";
      const hits = logs.filter((l) => l.token === kind && l.block >= from && l.block <= to);
      return {
        totalMicro: hits.reduce((s, l) => s + l.micro, 0n),
        transfers: hits.length,
        lastTxHash: hits.length ? hits[hits.length - 1]!.tx : null,
      };
    },
  };
  // …and holds LESS now: the delta is negative while a $5 deposit really did land.
  const attrBalances = { usdce: 1_000_000n, pusd: 0n };
  const attrReader: BalanceReader = async (token) =>
    token.toLowerCase().includes("2791") ? attrBalances.usdce : attrBalances.pusd;
  logs.push({ token: "usdce", block: head.n - 10n, micro: 5_000_000n, tx: "0xattr1" });

  r = await watchFunding(prisma, attrReader, new Date(Date.now() + 1000), chain);
  assert.ok(r.detected >= 1, "attribution detects the deposit the negative delta hid");
  row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attrAttempt.id } });
  assert.strictEqual(row.state, "DETECTED");
  assert.strictEqual(row.inUsdceMicro, 5_000_000n, "attributed exactly the transferred amount");
  assert.strictEqual(row.lastDepositTx, "0xattr1", "the transition names a real transaction");
  assert.ok(row.scanBlock !== null, "cursor persisted");

  // Re-scan with nothing new must not re-count: the cursor only moves forward.
  await watchFunding(prisma, attrReader, new Date(Date.now() + 70_000), chain);
  row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attrAttempt.id } });
  assert.strictEqual(row.inUsdceMicro, 5_000_000n, "no double-count on re-scan");
  assert.ok(row.scanBlock !== null && row.scanBlock >= head.n - 1n, "cursor caught up to head");

  // pUSD arriving above the cursor funds the attempt.
  const cursor = row.scanBlock!;
  logs.push({ token: "pusd", block: cursor + 5n, micro: 5_000_000n, tx: "0xattr2" });
  head.n = cursor + 10n;
  r = await watchFunding(prisma, attrReader, new Date(Date.now() + 140_000), chain);
  assert.ok(r.funded >= 1, "pUSD attribution funds");
  row = await prisma.fundingAttempt.findUniqueOrThrow({ where: { id: attrAttempt.id } });
  assert.strictEqual(row.state, "FUNDED");
  assert.strictEqual(row.inPusdMicro, 5_000_000n);
  assert.ok(row.fundedAt, "fundedAt set");

  // Every scan stayed inside the RPC-safe span — one unbounded getLogs would break a parked attempt.
  for (const range of ranges) {
    assert.ok(range.to - range.from <= 9_000n, `span bounded: ${range.from}..${range.to}`);
    assert.ok(range.to <= head.n, `never scans past the finalized head: ${range.to} <= ${head.n}`);
  }
  console.log("OK: funding attribution — Transfer logs beat balance deltas, cursor bounded and monotone");

  // Cleanup.
  await prisma.fundingAttempt.deleteMany({ where: { userId: { in: [userA.id, userB.id, userC.id, attrUser.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id, userC.id, attrUser.id] } } });

  console.log("PASS: funding-watch");
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
