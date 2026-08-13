import { Prisma, type PointsType } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay } from "./time";
import { writePoints } from "./points";
import { REFERRAL_INVITEE_BONUS, REFERRAL_INVITER_RATE } from "./config";
import { resolveUserDevice, sameDevice, type DeviceFingerprint } from "./refclick";
import { runSerializable } from "./tx";

// Capture the inviter<->invitee relationship at signup. The invitee can only ever
// have one referral (unique inviteeId). Logs a SIGNUP event so reward can be computed
// retroactively once params (§8 Q4-7) are decided.
//
// Anti-fraud (self / multi-account): a referral is bound — and so pays out — only when inviter
// and invitee are plausibly different humans/devices. Guards, in strength order:
//   1. Same User row (inviterId === inviteeId).
//   2. Same embedded wallet (User.embeddedWalletAddress): strong, per-user, request-free — the
//      same human re-using their Privy wallet across two accounts. Always checked.
//   3. Same device fingerprint (ipHash+uaHash), when the caller supplies the invitee's current
//      device hashes AND we can resolve the inviter's device — the same phone spinning up a
//      second account. Fail-safe: hashes unavailable (no REFERRAL_HASH_SECRET) -> skipped.
// Any guard that trips returns referralId:null (no Referral row, no SIGNUP event) so neither the
// inviter accrual nor the invitee bonus can ever fire for a self-referral.
export async function captureReferral(
  inviterId: string,
  inviteeId: string,
  at?: Date,
  opts?: { inviteeDevice?: DeviceFingerprint | null },
): Promise<{ referralId: string | null; reason?: string }> {
  if (inviterId === inviteeId) return { referralId: null, reason: "self" };

  // Guard 2 — same embedded wallet = same human. Per-user, no request context needed, so this
  // runs on BOTH the cookie and device-fallback paths. Only matches non-null addresses (the field
  // is nullable when Privy hasn't propagated the wallet yet — see F1-wallet — so two null rows
  // must NOT collide). Single query fetches both rows.
  const [inviter, invitee] = await Promise.all([
    prisma.user.findUnique({ where: { id: inviterId }, select: { embeddedWalletAddress: true } }),
    prisma.user.findUnique({ where: { id: inviteeId }, select: { embeddedWalletAddress: true } }),
  ]);
  // ponytail: belt-and-suspenders — User.embeddedWalletAddress is @unique, so two rows can't
  // actually share one address today (Privy provisions one wallet per DID). Kept because it's
  // free, self-documents intent, and activates if that uniqueness is ever relaxed (e.g. shared
  // external payout wallets). The signup-device guard below is the live same-human enforcement.
  if (
    inviter?.embeddedWalletAddress &&
    invitee?.embeddedWalletAddress &&
    inviter.embeddedWalletAddress === invitee.embeddedWalletAddress
  ) {
    return { referralId: null, reason: "self_wallet" };
  }

  // Guard 3 — same signup device. Compares the inviter's and invitee's device captured at signup
  // (User.signupIpHash/signupUaHash), resolved symmetrically. Falls back to the invitee's CURRENT
  // request device (opts.inviteeDevice) when their stored signup device is null (a pre-guard account,
  // or REFERRAL_HASH_SECRET added after they signed up). Fail-safe: any missing piece -> skip (never
  // crashes; the wallet guard above still applies). On by default when REFERRAL_HASH_SECRET is set.
  const inviterDevice = await resolveUserDevice(inviterId);
  const inviteeDevice = (await resolveUserDevice(inviteeId)) ?? opts?.inviteeDevice ?? null;
  if (inviterDevice && inviteeDevice && sameDevice(inviterDevice, inviteeDevice)) {
    return { referralId: null, reason: "self_device" };
  }

  try {
    const ref = await prisma.referral.create({
      data: {
        inviterId,
        inviteeId,
        events: { create: { type: "SIGNUP", metadata: { day: utcDay(at) } } },
      },
      select: { id: true },
    });
    return { referralId: ref.id };
  } catch (e) {
    // P2002 = invitee already referred. Don't reassign.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { referralId: null, reason: "already_referred" };
    }
    throw e;
  }
}

// Mark a referral qualified once the invitee has done enough real activity. Logs the event;
// DECIDED (Q7): inviter accrual is gated on this (requireQualified=true). Idempotent.
export async function qualifyReferral(inviteeId: string, at?: Date): Promise<void> {
  const ref = await prisma.referral.findUnique({ where: { inviteeId } });
  if (!ref || ref.qualifiedAt) return;
  await prisma.$transaction(async (tx) => {
    await tx.referral.update({ where: { inviteeId }, data: { qualifiedAt: at ?? new Date() } });
    await tx.referralEvent.create({
      data: { referralId: ref.id, type: "QUALIFIED", metadata: { day: utcDay(at) } },
    });
  });
}

// ---------------------------------------------------------------------------
// Retroactive reward computation. Params DECIDED (§8 Q4-7). This computes rewards
// from logged data and is re-runnable: it pays only the delta, so re-running after
// a param change back-pays correctly. Idempotency on ReferralEvent.sourcePointsLedgerId
// for inviter accrual (1 accrual per source ledger row).
// ---------------------------------------------------------------------------
export interface ReferralRewardParams {
  inviteeBonus: number; // one-time points to invitee
  inviterRate: number; // fraction of referral's points to inviter
  inviterEligibleTypes: PointsType[]; // which of the invitee's earned types feed the inviter share
  cadence: "one_time" | "ongoing";
  requireQualified: boolean; // anti-abuse gate: only accrue after the invitee qualifies
}

export const DEFAULT_REWARD_PARAMS: ReferralRewardParams = {
  inviteeBonus: REFERRAL_INVITEE_BONUS, // Q6: 20 one-time to invitee, no inviter signup bonus
  inviterRate: REFERRAL_INVITER_RATE, // Q4: inviter gets 20%
  // Q4: SWIPE + LOGIN are the invitee's directly-earned point types. REFERRAL and STREAK_X2
  // are EXCLUDED ON PURPOSE, not an oversight: accruing on the invitee's own REFERRAL income
  // would pay the inviter a cut of THEIR invitees' activity = multi-level, which the client
  // rejected (single-level only). STREAK_X2 is a read-time multiplier, never a raw ledger type.
  inviterEligibleTypes: ["SWIPE", "LOGIN"],
  cadence: "ongoing", // Q4: 20% forever while the referral keeps farming
  requireQualified: true, // Q7: referral counts only after the invitee makes 10 lifetime swipes
};

// Pure: the inviter's unpaid share = floor(cumulative eligible raw * rate) - already paid.
// Cumulative (not per-row) is load-bearing — floor(1 * 0.2) == 0, so per-row flooring pays
// the inviter nothing on a ledger of amount-1 rows. Never returns negative (clamp at 0).
export function inviterAccrualDelta(
  eligibleRaw: number,
  alreadyPaid: number,
  rate: number,
): number {
  return Math.max(0, Math.floor(eligibleRaw * rate) - alreadyPaid);
}

export async function computeReferralRewards(
  referralId: string,
  p: ReferralRewardParams = DEFAULT_REWARD_PARAMS,
): Promise<{ inviteePaid: number; inviterPaid: number }> {
  // Serializable + retry: the inviter accrual is a read-then-write on a high-water mark with no
  // unique constraint, so two concurrent triggers for the SAME referral (the invitee's GM tap
  // racing their own post-swipe accrual, ms apart) could both read the same alreadyPaid and
  // double-credit the delta. Serializable makes one abort (P2034); the retry re-reads the updated
  // mark and computes delta=0. Same isolation topup.ts/settle.ts already use for money writes.
  return runSerializable(async (tx) => {
    const ref = await tx.referral.findUnique({ where: { id: referralId } });
    if (!ref) return { inviteePaid: 0, inviterPaid: 0 };
    if (p.requireQualified && !ref.qualifiedAt) return { inviteePaid: 0, inviterPaid: 0 };

    let inviteePaid = 0;
    let inviterPaid = 0;

    // 1. Invitee one-time signup bonus (idempotent via inviteeBonusPaidAt).
    if (!ref.inviteeBonusPaidAt && p.inviteeBonus > 0) {
      await writePoints(tx, {
        userId: ref.inviteeId,
        type: "REFERRAL",
        amount: p.inviteeBonus,
        utcDay: utcDay(),
        referralId: ref.id,
      });
      await tx.referral.update({ where: { id: ref.id }, data: { inviteeBonusPaidAt: new Date() } });
      await tx.referralEvent.create({
        data: { referralId: ref.id, type: "INVITEE_BONUS", rewardAmount: p.inviteeBonus },
      });
      inviteePaid = p.inviteeBonus;
    }

    // 2. Inviter share = floor(CUMULATIVE eligible raw * rate), pay the delta vs already-paid.
    //
    // Why cumulative, not per-row: the ledger is all amount-1 rows (1 pt/swipe, 1 pt/login),
    // and floor(1 * 0.2) == 0, so a per-row floor pays the inviter 0 forever. Flooring the
    // running total instead (50 pts -> floor(10) = 10) is the only correct way to pay 20% of
    // single-point rows. Idempotency without a per-row mapping: track a high-water mark — sum
    // what we've already accrued and pay only `owed - alreadyPaid`. Re-runs pay 0 (delta=0);
    // a param change (wider eligibleTypes / rate) back-pays the new delta. ongoing-only.
    // ponytail: idempotency is read-then-write under Read Committed, NOT a unique constraint.
    // Two concurrent accruals for the SAME referral (this invitee's GM tap racing their own
    // post-swipe trigger, ms apart) could both read the same alreadyPaid and double-credit the
    // delta — bounded, self-inflicted, rare. Upgrade if it bites: SELECT ... FOR UPDATE on the
    // Referral row at the top of the tx (serialize per-referral), or a unique high-water mark.
    if (p.cadence !== "one_time") {
      const eligible = await tx.pointsLedger.aggregate({
        where: { userId: ref.inviteeId, type: { in: p.inviterEligibleTypes } },
        _sum: { amount: true },
      });
      const eligibleRaw = eligible._sum.amount ?? 0;

      const accrued = await tx.referralEvent.aggregate({
        where: { referralId: ref.id, type: "INVITER_ACCRUAL" },
        _sum: { rewardAmount: true },
      });
      const alreadyPaid = accrued._sum.rewardAmount ?? 0;

      const delta = inviterAccrualDelta(eligibleRaw, alreadyPaid, p.inviterRate);
      if (delta > 0) {
        await writePoints(tx, {
          userId: ref.inviterId,
          type: "REFERRAL",
          amount: delta,
          utcDay: utcDay(),
          referralId: ref.id,
        });
        await tx.referralEvent.create({
          data: {
            referralId: ref.id,
            type: "INVITER_ACCRUAL",
            sourceAmount: eligibleRaw, // the cumulative eligible raw this accrual brought us to
            rewardAmount: delta,
          },
        });
        inviterPaid = delta;
      }
    }

    return { inviteePaid, inviterPaid };
  });
}

// Convenience trigger: if this user was referred, run their referral's reward computation
// (invitee bonus + inviter accrual on newly-earned points). Safe to call often — it's
// idempotent and only scans un-accrued rows. No-op if the user wasn't referred.
export async function accrueReferralForInvitee(
  inviteeId: string,
  params: ReferralRewardParams = DEFAULT_REWARD_PARAMS,
): Promise<void> {
  const ref = await prisma.referral.findUnique({ where: { inviteeId }, select: { id: true } });
  if (!ref) return;
  await computeReferralRewards(ref.id, params);
}

// Referral stats for the inviter's invite screen: how many invitees they've bound, and the total
// points they've earned FROM those invitees (sum of INVITER_ACCRUAL rewards — excludes the user's
// own signup bonus if they were themselves referred, so "points earned" means earned-from-friends).
export async function getReferralStats(userId: string): Promise<{ joined: number; pointsEarned: number }> {
  const [joined, earned] = await Promise.all([
    prisma.referral.count({ where: { inviterId: userId } }),
    prisma.referralEvent.aggregate({
      where: { referral: { inviterId: userId }, type: "INVITER_ACCRUAL" },
      _sum: { rewardAmount: true },
    }),
  ]);
  return { joined, pointsEarned: earned._sum.rewardAmount ?? 0 };
}

// Q7: a referral qualifies after the invitee's 10th LIFETIME swipe (= 10 stored bets).
export const QUALIFY_MIN_SWIPES = 10;
export const hasQualifyingSwipes = (lifetimeBets: number): boolean =>
  lifetimeBets >= QUALIFY_MIN_SWIPES;

// Call after each swipe. Counts the invitee's LIFETIME bets (NOT the per-day swipe count the
// swipe route returns) and, once the threshold is hit, marks the referral qualified and runs
// accrual so the inviter promptly back-pays 20% of the invitee's prior swipe+login points.
// Both qualifyReferral and accrueReferralForInvitee are idempotent, so calling this on every
// swipe past the gate is safe (no double-pay). No-op if the invitee wasn't referred.
export async function maybeQualifyReferralOnSwipe(
  inviteeId: string,
  params: ReferralRewardParams = DEFAULT_REWARD_PARAMS,
): Promise<void> {
  // Deliberately mode-agnostic (owner Q1 2026-08-13: real swipes fully participate) — a REAL bet
  // counts toward the qualification threshold like a paper one. The check only FIRES from the
  // paper swipe route today; step 6's fill path must call this too or real-only invitees never qualify.
  const lifetimeBets = await prisma.bet.count({ where: { userId: inviteeId } });
  if (!hasQualifyingSwipes(lifetimeBets)) return;
  await qualifyReferral(inviteeId);
  await accrueReferralForInvitee(inviteeId, params);
}
