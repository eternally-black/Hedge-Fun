// Server-side settlement for REAL positions, and the sweep that stops a dead intent from wedging a
// market. Both exist because the money path was, until now, entirely client-driven: a position on a
// market that had already resolved sat "open" in the app until the user happened to open the
// developer console and press REDEEM. A lost position needs no signature and no relayer — it
// redeems to zero — so waiting for a human to ask for it was never the right shape.
import type { PrismaClient } from "@prisma/client";
import { planRedeem, type RedeemCandidate } from "./redeem";
import { SHARE_TICK_MICRO } from "./config";

// Close a resolved position's remainder and realize it. Winner: $1/share. CANCELED (this repo's
// INVALID resolution): an invalid binary CTF market pays [1,1], so EVERY share of either side
// redeems $0.50 — booking it 1:1 overstated realized PnL by half the remainder. Loser: zero.
// Idempotent by construction: a consumed position has no remainder left, and false says there was
// nothing to consume. The re-read lives INSIDE the transaction — a read-then-update could double
// book under two concurrent callers.
export async function consumeResolvedPosition(
  prisma: PrismaClient,
  betId: string,
  won: boolean,
  canceled: boolean,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const b = await tx.bet.findUnique({ where: { id: betId } });
    if (!b) return false;
    const filled = b.filledSharesMicro ?? 0n;
    const rem = filled - (b.closedSharesMicro ?? 0n);
    if (rem <= 0n) return false;
    const proceeds = won ? (canceled ? rem / 2n : rem) : 0n;
    const basis = filled > 0n ? (((b.spendMicro ?? 0n) + (b.feeMicro ?? 0n)) * rem) / filled : 0n;
    await tx.bet.update({
      where: { id: b.id },
      data: {
        closedSharesMicro: filled,
        proceedsMicro: (b.proceedsMicro ?? 0n) + proceeds,
        realizedPnlMicro: (b.realizedPnlMicro ?? 0n) + proceeds - basis,
      },
    });
    return true;
  });
}

// Book what needs no signature: positions on markets that have already resolved AGAINST the user,
// and the sub-tick remnants an exit cannot sell. Winners are deliberately NOT booked here — their
// collateral only exists once a redemption actually lands on chain, and inventing it in the ledger
// because the market resolved our way would be booking money the wallet may not hold. They are
// counted and returned so the caller can say so out loud.
export async function settleResolvedRealPositions(
  prisma: PrismaClient,
): Promise<{ lost: number; dust: number; winnersPending: number }> {
  const bets = await prisma.bet.findMany({
    where: {
      mode: "REAL",
      market: { status: { in: ["RESOLVED", "CANCELED"] } },
    },
    select: {
      id: true,
      side: true,
      filledSharesMicro: true,
      closedSharesMicro: true,
      market: { select: { status: true, resolvedOutcome: true, negRisk: true } },
    },
    take: 200,
  });
  const open = bets.filter((b) => (b.filledSharesMicro ?? 0n) - (b.closedSharesMicro ?? 0n) > 0n);
  if (open.length === 0) return { lost: 0, dust: 0, winnersPending: 0 };

  const plan = planRedeem(open as unknown as RedeemCandidate[]);
  let lost = 0;
  for (const l of plan.losses) if (await consumeResolvedPosition(prisma, l.id, false, false)) lost++;

  // Sub-tick remnants on a WINNER. The exit sold everything it could and left less than one share
  // tick behind; nobody can sell it and a redemption of a few thousandths of a share is not worth a
  // device prompt, so it is written off at zero rather than left holding the position open forever.
  let dust = 0;
  let winnersPending = 0;
  for (const c of open) {
    if (plan.losses.some((l) => l.id === c.id)) continue;
    const rem = (c.filledSharesMicro ?? 0n) - (c.closedSharesMicro ?? 0n);
    if (rem <= 0n) continue;
    if (rem < SHARE_TICK_MICRO) {
      if (await consumeResolvedPosition(prisma, c.id, false, false)) dust++;
    } else {
      winnersPending++;
    }
  }
  return { lost, dust, winnersPending };
}

// An ISSUED attempt is an intent nobody signed. The client that asked for it is long gone, but the
// row still occupies the one-in-flight-per-market slot, so that market is closed to the user until
// something clears it. The intent route only expires these when a NEW intent arrives for the SAME
// market — which never happens if the reason nobody re-tried is that the button vanished. One such
// row (an exit for a remainder too small to sell) is what wedged the first real market.
export async function expireStaleIntents(prisma: PrismaClient, olderThanMs = 30 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const { count } = await prisma.orderAttempt.updateMany({
    where: { state: "ISSUED", createdAt: { lt: cutoff } },
    data: { state: "FAILED", error: "intent_expired" },
  });
  return count;
}
