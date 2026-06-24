import { Prisma, type PointsType } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay } from "./time";
import { writePoints } from "./points";
import { REFERRAL_INVITEE_BONUS, REFERRAL_INVITER_RATE } from "./config";

type Db = Prisma.TransactionClient;

// Capture the inviter<->invitee relationship at signup. The invitee can only ever
// have one referral (unique inviteeId). Logs a SIGNUP event so reward can be computed
// retroactively once params (§8 Q4-7) are decided. Self-referral is rejected.
export async function captureReferral(
  inviterId: string,
  inviteeId: string,
  at?: Date,
): Promise<{ referralId: string | null; reason?: string }> {
  if (inviterId === inviteeId) return { referralId: null, reason: "self" };

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

export async function computeReferralRewards(
  referralId: string,
  p: ReferralRewardParams = DEFAULT_REWARD_PARAMS,
): Promise<{ inviteePaid: number; inviterPaid: number }> {
  return prisma.$transaction(async (tx) => {
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

    // 2. Inviter share of the referral's eligible points. Per source ledger row, idempotent.
    // Scope the scan to rows NOT yet accrued (H3): the DB excludes processed rows, so this
    // doesn't re-read the invitee's whole history on every call.
    const accruedIds = (
      await tx.referralEvent.findMany({
        where: { referralId: ref.id, type: "INVITER_ACCRUAL", sourcePointsLedgerId: { not: null } },
        select: { sourcePointsLedgerId: true },
      })
    )
      .map((e) => e.sourcePointsLedgerId)
      .filter((id): id is string => id !== null);

    const rows =
      p.cadence === "one_time"
        ? [] // one-time cadence accrues nothing ongoing (signup bonus only)
        : await tx.pointsLedger.findMany({
            where: {
              userId: ref.inviteeId,
              type: { in: p.inviterEligibleTypes },
              id: { notIn: accruedIds },
            },
            select: { id: true, amount: true },
          });

    for (const row of rows) {
      const reward = Math.floor(row.amount * p.inviterRate);
      if (reward <= 0) continue;
      await writePoints(tx, {
        userId: ref.inviterId,
        type: "REFERRAL",
        amount: reward,
        utcDay: utcDay(),
        referralId: ref.id,
      });
      await tx.referralEvent.create({
        data: {
          referralId: ref.id,
          type: "INVITER_ACCRUAL",
          sourcePointsLedgerId: row.id,
          sourceAmount: row.amount,
          rewardAmount: reward,
        },
      });
      inviterPaid += reward;
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
  const lifetimeBets = await prisma.bet.count({ where: { userId: inviteeId } });
  if (!hasQualifyingSwipes(lifetimeBets)) return;
  await qualifyReferral(inviteeId);
  await accrueReferralForInvitee(inviteeId, params);
}

// --- self-check (pure gate logic only; DB-backed funcs above need a live DB) ---
if (process.env.NODE_ENV !== "production" && process.argv[1]?.includes("referral")) {
  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error("referral self-check: " + m);
  };
  assert(!hasQualifyingSwipes(9), "9 swipes must NOT qualify");
  assert(hasQualifyingSwipes(10), "10th swipe must qualify");
  assert(hasQualifyingSwipes(11), "past-threshold stays qualified");
  // single-level: the invitee's own REFERRAL income must never feed the inviter share.
  assert(!DEFAULT_REWARD_PARAMS.inviterEligibleTypes.includes("REFERRAL"), "no multi-level");
  // eslint-disable-next-line no-console
  console.log("referral self-check OK");
}
