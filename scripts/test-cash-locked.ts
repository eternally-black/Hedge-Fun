// End-to-end check of the Cash/Locked hold model in ONE process (one connection): provision →
// hold-on-swipe (atomic conditional update) → cash gate blocks when broke → settle releases hold &
// credits payout → void releases hold (refund) → top-up free/artifact. Run: npx tsx scripts/test-cash-locked.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { recordSwipe, InsufficientFundsError } from "../src/lib/swipe";
import { settleMarket } from "./settle";
import { topUp } from "../src/lib/topup";
import { STAKE_CENTS, FREE_TOPUP_CASH_GATE_CENTS, ARTIFACT_TOPUP_CASH_GATE_CENTS, TOPUP_GRANT_CENTS } from "../src/lib/config";
import { randomCode } from "../src/lib/refcode";

async function main() {
  const tag = `cltest-${process.pid}-${Date.now() & 0xffffff}`;
  const start = 3 * STAKE_CENTS; // funds exactly 3 swipes, 4th must fail
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: start } }, collectibleBalance: { create: { artifacts: 1 } }, streak: { create: {} } },
  });
  const mk = async (i: number, yesBp = 4000) => prisma.market.create({
    data: { polymarketId: `${tag}-m${i}`, question: `q${i}`, status: "OPEN", yesPriceBp: yesBp, noPriceBp: 10000 - yesBp, resolutionDeadline: new Date(Date.now() + 3_600_000) },
  });
  const markets = [];
  for (let i = 0; i < 5; i++) markets.push(await mk(i));

  // 1. HOLD: 3 swipes succeed; each adds STAKE_CENTS to lockedCents, balance untouched.
  for (let i = 0; i < 3; i++) await recordSwipe({ userId: user.id, marketId: markets[i].id, side: "YES", lockedPriceBp: 4000 });
  let vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, 3 * STAKE_CENTS, "3 stakes held");
  assert.strictEqual(vb.balanceCents, start, "balance untouched by holds");
  assert.strictEqual(vb.balanceCents - vb.lockedCents, 0, "Cash == 0 after holding the whole balance");

  // 2. CASH GATE: the 4th swipe has no free Cash → InsufficientFundsError, nothing stored.
  let blocked = false;
  try { await recordSwipe({ userId: user.id, marketId: markets[3].id, side: "YES", lockedPriceBp: 4000 }); }
  catch (e) { blocked = e instanceof InsufficientFundsError; }
  assert.ok(blocked, "4th swipe blocked by cash gate");
  assert.strictEqual(await prisma.bet.count({ where: { userId: user.id, marketId: markets[3].id } }), 0, "blocked swipe stored no bet");
  vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, 3 * STAKE_CENTS, "hold unchanged after blocked swipe");

  // 3. SETTLE WIN: market[0] resolves YES (bet was YES@0.40). Releases hold, credits full payout.
  const bet0 = await prisma.bet.findFirstOrThrow({ where: { userId: user.id, marketId: markets[0].id } });
  const payout = Math.round((bet0.stakeCents * 10000) / bet0.lockedPriceBp); // YES@4000 → 2.5x
  await settleMarket(prisma, markets[0].id, { kind: "resolved", resolvedYes: true });
  vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, 2 * STAKE_CENTS, "win released one hold");
  assert.strictEqual(vb.balanceCents, start + payout, "win credited full payout to balance");

  // 4. SETTLE LOSS: market[1] resolves NO. Releases hold, credits 0.
  const balBeforeLoss = vb.balanceCents;
  await settleMarket(prisma, markets[1].id, { kind: "resolved", resolvedYes: false });
  vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, 1 * STAKE_CENTS, "loss released one hold");
  assert.strictEqual(vb.balanceCents, balBeforeLoss, "loss credited nothing");

  // 5. VOID: market[2] voids. Releases hold (refund), no balance change.
  const balBeforeVoid = vb.balanceCents;
  await settleMarket(prisma, markets[2].id, { kind: "void" });
  vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, 0, "void released the last hold");
  assert.strictEqual(vb.balanceCents, balBeforeVoid, "void made no balance change (release IS the refund)");

  // 6. IDEMPOTENT settle: re-run does nothing (no double release → no negative lockedCents).
  await settleMarket(prisma, markets[0].id, { kind: "resolved", resolvedYes: true });
  vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.lockedCents, 0, "re-settle didn't drive lockedCents negative");

  // 7. TOP-UP ARTIFACT GATE: it bails out a near-empty balance, so it's gated to Cash < $50. Cash is
  //    high here → blocked (cash_too_high) and the artifact is NOT spent.
  assert.ok(vb.balanceCents - vb.lockedCents >= ARTIFACT_TOPUP_CASH_GATE_CENTS, "cash above the artifact gate");
  const rArtHigh = await topUp(user.id, "artifact");
  assert.ok(!rArtHigh.ok && rArtHigh.reason === "cash_too_high", "artifact top-up blocked when cash is high");
  assert.strictEqual((await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: user.id } })).artifacts, 1, "artifact retained while gated");

  // 8. TOP-UP ARTIFACT SUCCESS: drop Cash below the gate → spends the 1 artifact, +$200.
  await prisma.virtualBalance.update({ where: { userId: user.id }, data: { balanceCents: 0 } });
  const rArt = await topUp(user.id, "artifact");
  assert.ok(rArt.ok, "artifact top-up granted when cash is low");
  vb = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb.balanceCents, TOPUP_GRANT_CENTS, "artifact top-up +grant from 0");
  assert.strictEqual((await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: user.id } })).artifacts, 0, "artifact spent");

  // 9. FREE TOP-UP GATE: the +$200 grant put cash above the free gate → free path not eligible.
  assert.ok(vb.balanceCents - vb.lockedCents >= FREE_TOPUP_CASH_GATE_CENTS, "cash above the free gate");
  const rFree = await topUp(user.id, "free");
  assert.ok(!rFree.ok && rFree.reason === "free_not_eligible", "free top-up blocked when cash is high");

  // cleanup (children before parents: ShardGrant FK → Bet, so shards first)
  await prisma.shardGrant.deleteMany({ where: { userId: user.id } });
  await prisma.bet.deleteMany({ where: { userId: user.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
  await prisma.market.deleteMany({ where: { polymarketId: { startsWith: `${tag}-m` } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: user.id } });
  await prisma.streak.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log("OK: hold→gate→settle(win/loss/void)→idempotent→topup(artifact/free-gate) all correct");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
