import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay } from "./time";
import {
  SWIPE_CAP,
  STAKE_CENTS,
  TOPUP_GRANT_CENTS,
  FREE_TOPUP_CASH_GATE_CENTS,
  TOPUP_ARTIFACT_COST,
} from "./config";

export type TopupKind = "free" | "artifact";

export type TopupResult =
  | { ok: true; kind: TopupKind; grantedCents: number; balanceCents: number }
  | {
      ok: false;
      reason: "free_used" | "free_not_eligible" | "no_artifact";
    };

// Credit +TOPUP_GRANT_CENTS of Cash. Two paths, one Serializable tx each (serializes concurrent
// top-ups per user so the free flag / artifact decrement can't double-fire):
//   free     — once ever, gated to low-cash users. Eligibility is RE-DERIVED here (never trust the
//              client's freeTopupAvailable): Cash < $30 AND Cash can't charge the rest of today's deck.
//   artifact — costs 1 artifact, NO cash gate (artifacts are the currency; user decides).
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

      // kind === "artifact" — costs 1 artifact, no cash gate.
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
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
