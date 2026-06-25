// DB-backed referral seams the pure tests can't reach (test-referral covers inviterAccrualDelta):
//  (2) captureReferral IDEMPOTENCY — Android calls /login-mark?ref= on every first launch, so a
//      double capture must NOT create two referrals or two rewards. The unique inviteeId holds it.
//  (3) computeReferralRewards RETROACTIVITY — the most money-sensitive logic, DB-only. Accrue at
//      one rate, change the param, re-run: it must back-pay only the DELTA (re-runs pay 0; a wider
//      rate/types back-pays the difference). This is what "param changes back-pay retroactively"
//      means in practice, asserted against real ledger aggregation.
// Run: npx tsx scripts/test-referral-db.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { writePoints } from "../src/lib/points";
import {
  captureReferral,
  qualifyReferral,
  computeReferralRewards,
  DEFAULT_REWARD_PARAMS,
} from "../src/lib/referral";
import { utcDay } from "../src/lib/time";

async function mkUser(tag: string) {
  return prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} }, streak: { create: {} } },
  });
}

async function cleanup(ids: string[], refIds: string[]) {
  await prisma.referralEvent.deleteMany({ where: { referralId: { in: refIds } } });
  await prisma.referral.deleteMany({ where: { id: { in: refIds } } });
  await prisma.pointsLedger.deleteMany({ where: { userId: { in: ids } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: { in: ids } } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: { in: ids } } });
  await prisma.streak.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  const tag = `reftest-${process.pid}-${Date.now() & 0xffffff}`;
  const inviter = await mkUser(`${tag}-inviter`);
  const invitee = await mkUser(`${tag}-invitee`);
  const refIds: string[] = [];

  // ---- (2) captureReferral idempotency ----
  // Self-referral rejected (no row).
  const self = await captureReferral(inviter.id, inviter.id);
  assert.strictEqual(self.referralId, null, "self-referral rejected");
  assert.strictEqual(self.reason, "self", "self-referral reason");

  // First capture creates exactly one referral + one SIGNUP event.
  const first = await captureReferral(inviter.id, invitee.id);
  assert.ok(first.referralId, "first capture creates a referral");
  refIds.push(first.referralId!);

  // Double capture (Android first-launch fires it again) — same invitee, NOT a new row, no error.
  const second = await captureReferral(inviter.id, invitee.id);
  assert.strictEqual(second.referralId, null, "double capture returns null");
  assert.strictEqual(second.reason, "already_referred", "double capture reason = already_referred");

  // A DIFFERENT inviter trying to claim the same invitee must also be blocked (unique inviteeId).
  const inviter2 = await mkUser(`${tag}-inviter2`);
  const steal = await captureReferral(inviter2.id, invitee.id);
  assert.strictEqual(steal.reason, "already_referred", "another inviter cannot re-claim the invitee");

  const refCount = await prisma.referral.count({ where: { inviteeId: invitee.id } });
  assert.strictEqual(refCount, 1, "exactly one referral row for the invitee, ever");
  const signupCount = await prisma.referralEvent.count({ where: { referralId: first.referralId!, type: "SIGNUP" } });
  assert.strictEqual(signupCount, 1, "exactly one SIGNUP event (no duplicate from re-capture)");

  // ---- (3) computeReferralRewards retroactivity ----
  // Before qualifying, accrual is gated (requireQualified=true) -> pays nothing.
  await writePoints(prisma, { userId: invitee.id, type: "SWIPE", amount: 1, utcDay: utcDay(), betId: undefined });
  const preQual = await computeReferralRewards(first.referralId!);
  assert.strictEqual(preQual.inviterPaid, 0, "no inviter accrual before invitee qualifies");
  assert.strictEqual(preQual.inviteePaid, 0, "no invitee bonus before qualify");

  // Qualify the referral, then give the invitee 50 eligible (SWIPE+LOGIN) raw points across days.
  await qualifyReferral(invitee.id);
  // already 1 SWIPE above; add to reach 40 SWIPE + 10 LOGIN = 50 eligible raw.
  for (let i = 1; i < 40; i++) {
    await writePoints(prisma, { userId: invitee.id, type: "SWIPE", amount: 1, utcDay: `2026-06-${String(1 + (i % 27)).padStart(2, "0")}`, betId: undefined });
  }
  for (let i = 0; i < 10; i++) {
    await writePoints(prisma, { userId: invitee.id, type: "LOGIN", amount: 1, utcDay: `2026-05-${String(1 + i).padStart(2, "0")}` });
  }

  // First run at the DEFAULT rate (0.2): inviter bonus 0, invitee bonus 20, inviter share = floor(50*0.2)=10.
  const r1 = await computeReferralRewards(first.referralId!);
  assert.strictEqual(r1.inviteePaid, DEFAULT_REWARD_PARAMS.inviteeBonus, "invitee one-time bonus paid once");
  assert.strictEqual(r1.inviterPaid, 10, "inviter share = floor(50 * 0.2) = 10");

  // RE-RUN, same params: pays nothing more (delta = 0). This is the idempotency that makes the
  // GM-tap trigger safe to fire every day.
  const r2 = await computeReferralRewards(first.referralId!);
  assert.strictEqual(r2.inviteePaid, 0, "invitee bonus NOT paid twice");
  assert.strictEqual(r2.inviterPaid, 0, "inviter share re-run pays 0 (delta)");

  // PARAM CHANGE -> RETROACTIVE BACK-PAY: bump the rate to 0.5. New owed = floor(50*0.5)=25,
  // already paid 10, so this run must back-pay exactly the 15 delta over the SAME historical points.
  const r3 = await computeReferralRewards(first.referralId!, { ...DEFAULT_REWARD_PARAMS, inviterRate: 0.5 });
  assert.strictEqual(r3.inviterPaid, 15, "rate 0.2->0.5 back-pays delta 25-10 = 15 retroactively");

  // The inviter's REFERRAL ledger now sums to 25 (10 + 15), proving cumulative correctness.
  const inviterTotal = await prisma.pointsLedger.aggregate({
    where: { userId: inviter.id, type: "REFERRAL" }, _sum: { amount: true },
  });
  assert.strictEqual(inviterTotal._sum.amount, 25, "inviter REFERRAL ledger = 25 total after back-pay");

  await cleanup([inviter.id, invitee.id, inviter2.id], refIds);
  console.log("OK: capture idempotent (1 row/invitee); rewards retroactive (delta-only back-pay)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
