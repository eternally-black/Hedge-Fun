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
import { utcDay } from "../src/lib/time";
import type { DeviceFingerprint } from "../src/lib/refclick"; // type-only: erased, no runtime load

// The self/device anti-fraud guard reads REFERRAL_HASH_SECRET + REFERRAL_DEVICE_GUARD at module
// load (src/lib/refclick.ts). Set BOTH before the dynamic import of referral/refclick in main(),
// the same env-before-import pattern as test-admin.ts. Nothing statically imported above pulls in
// refclick, so the dynamic import below is the first time it loads — with the env already in place.
process.env.REFERRAL_HASH_SECRET = process.env.REFERRAL_HASH_SECRET || "test-referral-secret";
process.env.REFERRAL_DEVICE_GUARD = "1";

async function mkUser(tag: string, signup?: DeviceFingerprint | null) {
  return prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(),
      signupIpHash: signup?.ipHash ?? null, signupUaHash: signup?.uaHash ?? null,
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
  // Dynamic import so refclick.ts reads the env set at the top of this file (see note there).
  const { captureReferral, qualifyReferral, computeReferralRewards, DEFAULT_REWARD_PARAMS, accrueReferralForInvitee } =
    await import("../src/lib/referral");
  const { deviceHashes } = await import("../src/lib/refclick");

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

  // ---- ANTI-FRAUD: same signup-device self-referral is NOT bound (no row, no accrual, no bonus) ----
  // The self-referrer creates account A AND account B on the same device D, so both rows store the
  // same signupIpHash+signupUaHash (captured at signup by ensureUser). Without the guard,
  // captureReferral(A, B) would bind A->B and pay A 20% of B's farming forever. The guard resolves
  // each user's STORED signup device and rejects when they match — symmetric and non-circular.
  const deviceD = new Headers({ "x-forwarded-for": "203.0.113.7", "user-agent": "Mozilla/5.0 (FraudPhone)", "accept-language": "en-US" });
  const dD = deviceHashes(deviceD)!; // secret is set at top of file, so never null
  const fraudInviter = await mkUser(`${tag}-fraud-inviter`, dD);
  const fraudInvitee = await mkUser(`${tag}-fraud-invitee`, dD);
  const fraud = await captureReferral(fraudInviter.id, fraudInvitee.id);
  assert.strictEqual(fraud.referralId, null, "same signup-device self-referral is rejected (no binding)");
  assert.strictEqual(fraud.reason, "self_device", "rejection reason = self_device");
  assert.strictEqual(await prisma.referral.count({ where: { inviteeId: fraudInvitee.id } }), 0, "no Referral row for the same-device pair");
  assert.strictEqual(await prisma.referralEvent.count({ where: { referral: { inviteeId: fraudInvitee.id } } }), 0, "no referral events (no SIGNUP)");
  // Accrual is a no-op (no referral) and the invitee never gets the one-time bonus.
  await accrueReferralForInvitee(fraudInvitee.id);
  const fraudInviteeReferralPts = await prisma.pointsLedger.aggregate({
    where: { userId: fraudInvitee.id, type: "REFERRAL" }, _sum: { amount: true },
  });
  assert.strictEqual(fraudInviteeReferralPts._sum.amount ?? 0, 0, "rejected invitee earns no referral bonus");
  const fraudInviterReferralPts = await prisma.pointsLedger.aggregate({
    where: { userId: fraudInviter.id, type: "REFERRAL" }, _sum: { amount: true },
  });
  assert.strictEqual(fraudInviterReferralPts._sum.amount ?? 0, 0, "fraud inviter accrues nothing");

  // Sanity: a DIFFERENT signup device IS allowed (the guard rejects only on a device match). Distinct
  // IP+UA -> distinct fingerprint -> binding succeeds (real invitee on their own phone).
  const deviceE = new Headers({ "x-forwarded-for": "198.51.100.42", "user-agent": "Mozilla/5.0 (HonestPhone)", "accept-language": "fr-FR" });
  const honestInvitee = await mkUser(`${tag}-honest-invitee`, deviceHashes(deviceE)!);
  const honest = await captureReferral(fraudInviter.id, honestInvitee.id);
  assert.ok(honest.referralId, "different signup-device invitee binds normally (guard does not over-match)");
  refIds.push(honest.referralId!);

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

  await cleanup(
    [inviter.id, invitee.id, inviter2.id, fraudInviter.id, fraudInvitee.id, honestInvitee.id],
    refIds,
  );
  console.log("OK: capture idempotent (1 row/invitee) + same-device self-referral rejected; rewards retroactive (delta-only back-pay)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
