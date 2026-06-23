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

// Mark a referral qualified (e.g. invitee completed first real activity). Logs the event
// so an anti-abuse "reward only after activity" rule can gate on it later.
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
// Retroactive reward computation. ALL params are OPEN (§8). This computes rewards
// from logged data and is re-runnable: it pays only the delta, so re-running after
// a param change back-pays correctly. Idempotency on ReferralEvent.sourcePointsLedgerId
// for inviter accrual (1 accrual per source ledger row).
// ---------------------------------------------------------------------------
export interface ReferralRewardParams {
  inviteeBonus: number; // one-time points to invitee
  inviterRate: number; // fraction of referral's points to inviter
  inviterEligibleTypes: PointsType[]; // OPEN: which types count toward inviter share
  cadence: "one_time" | "ongoing"; // OPEN
  requireQualified: boolean; // OPEN: anti-abuse gate
}

export const DEFAULT_REWARD_PARAMS: ReferralRewardParams = {
  inviteeBonus: REFERRAL_INVITEE_BONUS,
  inviterRate: REFERRAL_INVITER_RATE,
  inviterEligibleTypes: ["SWIPE", "LOGIN"], // OPEN
  cadence: "ongoing", // OPEN
  requireQualified: false, // OPEN
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
