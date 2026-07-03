import { runSerializable } from "./tx";
import { utcDay } from "./time";
import {
  SWIPE_CAP,
  STAKE_CENTS,
  TOPUP_GRANT_CENTS,
  FREE_TOPUP_CASH_GATE_CENTS,
  TOPUP_ARTIFACT_COST,
  ARTIFACT_TOPUP_CASH_GATE_CENTS,
} from "./config";

export type TopupKind = "free" | "artifact";

export type TopupResult =
  | { ok: true; kind: TopupKind; grantedCents: number; balanceCents: number }
  | {
      ok: false;
      reason: "free_used" | "free_not_eligible" | "no_artifact" | "cash_too_high";
    };

// Credit +TOPUP_GRANT_CENTS of Cash. Two paths, one Serializable tx each (serializes concurrent
// top-ups per user so the free flag / artifact decrement can't double-fire):
//   free     — once ever, gated to low-cash users. Eligibility is RE-DERIVED here (never trust the
//              client's freeTopupAvailable): Cash < $30 AND Cash can't charge the rest of today's deck.
//   artifact — costs 1 artifact, gated to Cash < $50 (a top-up bails out a near-empty balance; it's
//              not free money to stack on a full one). Gate RE-DERIVED here, never trusting the client.
// Mirrors the artifact-spend pattern in streak.ts recoverStreak().
export async function topUp(userId: string, kind: TopupKind, at = new Date()): Promise<TopupResult> {
  // Serializable + P2034 retry (src/lib/tx): serializes concurrent top-ups per user so the free
  // flag / artifact decrement can't double-fire, and a write conflict retries instead of 500ing.
  // The body re-reads vb/cb state, so a retry is idempotent (no double-grant).
  return runSerializable<TopupResult>(
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

      // kind === "artifact" — costs 1 artifact, but only while Cash is low (< $50). Check
      // artifact-presence first (the more fundamental blocker), then the cash gate. Cash = balance −
      // locked (the maintained hold). Neither the artifact nor the grant fires while gated.
      const cb = await tx.collectibleBalance.findUnique({ where: { userId } });
      if (!cb || cb.artifacts < TOPUP_ARTIFACT_COST) return { ok: false, reason: "no_artifact" };
      const cash = vb.balanceCents - vb.lockedCents;
      if (cash >= ARTIFACT_TOPUP_CASH_GATE_CENTS) return { ok: false, reason: "cash_too_high" };
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
  );
}
