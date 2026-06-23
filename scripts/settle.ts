import { Prisma, PrismaClient } from "@prisma/client";
import { awardShard } from "../src/lib/shards";
import { START_BALANCE_CENTS } from "../src/lib/config";

// ---------------------------------------------------------------------------
// Paper P&L (share math). User "buys" $stake of the YES or NO share at the locked
// price p (fraction). A winning share pays $1, a losing share pays $0.
//
//   YES bet, price p (yes-bp/10000):   win -> payout = S/p     ; pnl = S*(1-p)/p
//                                       lose -> payout = 0      ; pnl = -S
//   NO bet, effective price q = 1-p:    win -> payout = S/q     ; pnl = S*(1-q)/q
//                                       lose -> payout = 0      ; pnl = -S
//
// Worked example: YES at p=0.40 (4000bp), stake $100 (10000c), resolves YES.
//   payout = 10000 * 10000 / 4000 = 25000c ($250). pnl = 25000-10000 = +15000c (+$150).
// NO at p_yes=0.40 -> q=0.60 (6000bp), stake $100, resolves NO.
//   payout = 10000 * 10000 / 6000 = 16667c. pnl = +6667c.
// ---------------------------------------------------------------------------
export function computePnl(a: {
  side: "YES" | "NO";
  stakeCents: number;
  lockedPriceBp: number; // price of the SIDE BOUGHT, in bp, at swipe time
  resolvedYes: boolean;
}): { payoutCents: number; pnlCents: number; won: boolean } {
  const won = a.side === "YES" ? a.resolvedYes : !a.resolvedYes;
  if (!won) return { payoutCents: 0, pnlCents: -a.stakeCents, won };
  // lockedPriceBp is already the bought side's price (YES bet -> yes price, NO bet -> no
  // price), locked from the card the user saw. Clamp guards div-by-zero on ~certain markets.
  const priceBp = Math.min(9999, Math.max(1, a.lockedPriceBp));
  const payoutCents = Math.round((a.stakeCents * 10000) / priceBp);
  return { payoutCents, pnlCents: payoutCents - a.stakeCents, won };
}

export type Resolution =
  | { kind: "open" } // not resolved yet -> no-op, re-poll
  | { kind: "void" } // canceled/invalid -> push (refund pnl 0, no shard)
  | { kind: "resolved"; resolvedYes: boolean };

// Settle every PENDING bet on one market. Idempotent: only PENDING bets transition,
// so re-running is a no-op. One transaction per market.
// ponytail: one Serializable tx settles ALL bets on a market in a loop (M2). Fine at MVP
// scale; a market with thousands of bets is one heavy serializable tx that will contend.
// Upgrade path if it bites in September: batch bets in chunks, or move shard-cap counting
// off the read-then-increment pattern (which only stays correct under Serializable).
export async function settleMarket(
  prisma: PrismaClient,
  marketId: string,
  resolution: Resolution,
): Promise<{ settled: number; voided: number; shardsAwarded: number }> {
  if (resolution.kind === "open") return { settled: 0, voided: 0, shardsAwarded: 0 };

  return prisma.$transaction(
    async (tx) => {
      const bets = await tx.bet.findMany({
        where: { marketId, settlementStatus: "PENDING" },
      });

      // Update the cached market status either way.
      await tx.market.update({
        where: { id: marketId },
        data:
          resolution.kind === "void"
            ? { status: "CANCELED", resolvedOutcome: "INVALID", resolvedAt: new Date() }
            : {
                status: "RESOLVED",
                resolvedOutcome: resolution.resolvedYes ? "YES" : "NO",
                resolvedAt: new Date(),
              },
      });

      let settled = 0;
      let voided = 0;
      let shardsAwarded = 0;

      for (const bet of bets) {
        if (resolution.kind === "void") {
          await tx.bet.update({
            where: { id: bet.id },
            data: {
              settlementStatus: "VOID",
              result: "PUSH",
              payoutCents: 0,
              pnlCents: 0,
              settledAt: new Date(),
            },
          });
          voided++;
          continue;
        }

        const { payoutCents, pnlCents, won } = computePnl({
          side: bet.side,
          stakeCents: bet.stakeCents,
          lockedPriceBp: bet.lockedPriceBp,
          resolvedYes: resolution.resolvedYes,
        });

        await tx.bet.update({
          where: { id: bet.id },
          data: {
            settlementStatus: "SETTLED",
            result: won ? "WIN" : "LOSS", // outcome-based, not pnl-sign (a 0-pnl win is still a win)
            payoutCents,
            pnlCents,
            resolvedYes: resolution.resolvedYes,
            settledAt: new Date(),
          },
        });

        // Apply net P&L delta to the virtual balance (race-safe increment).
        // The create branch is a safety net — balance is provisioned at signup, so it
        // should never fire; if it does, start from the configured balance, not a literal.
        await tx.virtualBalance.upsert({
          where: { userId: bet.userId },
          create: { userId: bet.userId, balanceCents: START_BALANCE_CENTS + pnlCents },
          update: { balanceCents: { increment: pnlCents } },
        });

        if (won) {
          const r = await awardShard(tx, bet.userId, bet.id, bet.createdAt);
          if (r.shardAwarded) shardsAwarded++;
        }
        settled++;
      }

      return { settled, voided, shardsAwarded };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
