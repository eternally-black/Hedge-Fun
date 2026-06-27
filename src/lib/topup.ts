import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay } from "./time";
import { effectivePoints, writePoints } from "./points";
import {
  SWIPE_CAP,
  STAKE_CENTS,
  TOPUP_GRANT_CENTS,
  FREE_TOPUP_CASH_GATE_CENTS,
  TOPUP_ARTIFACT_COST,
  TOPUP_POINTS_ENABLED,
  TOPUP_POINTS_COST,
} from "./config";

export type TopupKind = "free" | "artifact" | "points";

export type TopupResult =
  | { ok: true; kind: TopupKind; grantedCents: number; balanceCents: number }
  | {
      ok: false;
      reason:
        | "free_used"
        | "free_not_eligible"
        | "no_artifact"
        | "points_disabled"
        | "not_enough_points";
    };

// Credit +TOPUP_GRANT_CENTS of Cash. Three paths, one Serializable tx each (serializes concurrent
// top-ups per user so the free flag / artifact decrement can't double-fire):
//   free     — once ever, gated to low-cash users. Eligibility is RE-DERIVED here (never trust the
//              client's freeTopupAvailable): Cash < $30 AND Cash can't charge the rest of today's deck.
//   artifact — costs 1 artifact, NO cash gate (artifacts are the currency; user decides).
//   points   — DORMANT (TOPUP_POINTS_ENABLED=false). Spends points via a NEGATIVE TOPUP_SPEND row.
// Mirrors the artifact-spend pattern in streak.ts recoverStreak().
export async function topUp(userId: string, kind: TopupKind, at = new Date()): Promise<TopupResult> {
  return prisma.$transaction(
    async (tx): Promise<TopupResult> => {
      const vb = await tx.virtualBalance.upsert({ where: { userId }, create: { userId }, update: {} });

      if (kind === "free") {
        if (vb.freeTopupUsed) return { ok: false, reason: "free_used" };
        // Re-derive eligibility server-side. Cash = balance − locked (the maintained hold).
        const cash = vb.balanceCents - vb.lockedCents;
        const day = utcDay(at);
        const counter = await tx.dailyCounter.findUnique({
          where: { userId_utcDay: { userId, utcDay: day } },
        });
        const remaining = Math.max(0, SWIPE_CAP - (counter?.swipeCount ?? 0));
        const eligible = cash < FREE_TOPUP_CASH_GATE_CENTS && cash < remaining * STAKE_CENTS;
        if (!eligible) return { ok: false, reason: "free_not_eligible" };

        const updated = await tx.virtualBalance.update({
          where: { userId },
          data: { balanceCents: { increment: TOPUP_GRANT_CENTS }, freeTopupUsed: true },
        });
        return { ok: true, kind, grantedCents: TOPUP_GRANT_CENTS, balanceCents: updated.balanceCents };
      }

      if (kind === "artifact") {
        const cb = await tx.collectibleBalance.findUnique({ where: { userId } });
        if (!cb || cb.artifacts < TOPUP_ARTIFACT_COST) return { ok: false, reason: "no_artifact" };
        await tx.collectibleBalance.update({
          where: { userId },
          data: { artifacts: { decrement: TOPUP_ARTIFACT_COST } },
        });
        const updated = await tx.virtualBalance.update({
          where: { userId },
          data: { balanceCents: { increment: TOPUP_GRANT_CENTS }, topupCount: { increment: 1 } },
        });
        return { ok: true, kind, grantedCents: TOPUP_GRANT_CENTS, balanceCents: updated.balanceCents };
      }

      // kind === "points" — DORMANT. Flag-gated at both the route (404) and here.
      if (!TOPUP_POINTS_ENABLED) return { ok: false, reason: "points_disabled" };
      const score = await effectivePoints(tx, userId);
      if (score.total < TOPUP_POINTS_COST) return { ok: false, reason: "not_enough_points" };
      // Append-only "debit": a NEGATIVE row reduces effective points everywhere (scorePoints).
      await writePoints(tx, {
        userId,
        type: "TOPUP_SPEND",
        amount: -TOPUP_POINTS_COST,
        utcDay: utcDay(at),
        metadata: { reason: "topup", grantCents: TOPUP_GRANT_CENTS },
      });
      const updated = await tx.virtualBalance.update({
        where: { userId },
        data: { balanceCents: { increment: TOPUP_GRANT_CENTS }, topupCount: { increment: 1 } },
      });
      return { ok: true, kind, grantedCents: TOPUP_GRANT_CENTS, balanceCents: updated.balanceCents };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
