import { Prisma, PrismaClient } from "@prisma/client";
import { awardShard } from "../src/lib/shards";

// ---------------------------------------------------------------------------
// Balance model (Cash/Locked): the stake is HELD at swipe time (lockedCents += stake on
// virtual_balances), never decremented from balanceCents. Settlement releases the hold and credits
// the full payout (Cash = balanceCents − lockedCents):
//   - win  -> balanceCents += payoutCents, lockedCents −= stake (Cash net change = payout − stake = pnl)
//   - loss -> payoutCents = 0, lockedCents −= stake (stake consumed; only the hold is released)
//   - void -> lockedCents −= stake, NO balance change — releasing the hold IS the refund
// balanceCents thus only ever increments, by payouts (here) and top-ups (src/lib/topup.ts).
//
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

      // Update the cached market status at first resolution only. PENDING bets exist only on the
      // first settle; on repeat/duplicate calls bets.length === 0, so we skip the write — otherwise
      // resolvedAt (= new Date()) would drift forward on every re-call of an already-settled market.
      if (bets.length > 0) {
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
      }

      let settled = 0;
      let voided = 0;
      let shardsAwarded = 0;

      for (const bet of bets) {
        if (resolution.kind === "void") {
          // Release the hold (lockedCents −= stake) with NO balance change — that release IS the
          // refund (Cash returns by stake). The stake was held, never debited from balanceCents.
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
          await tx.virtualBalance.update({
            where: { userId: bet.userId },
            data: { lockedCents: { decrement: bet.stakeCents } },
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

        // Release the hold (lockedCents −= stake) and credit the FULL payout (balanceCents +=
        // payout). Cash net change = payout − stake = pnl. A loss has payoutCents = 0 → only the
        // hold is released. The create branch is a safety net — balance is provisioned at signup,
        // so it should never fire; if it does, seed ONLY the payout (no $200 base re-grant) with no hold.
        await tx.virtualBalance.upsert({
          where: { userId: bet.userId },
          create: { userId: bet.userId, balanceCents: payoutCents, lockedCents: 0 },
          update: { balanceCents: { increment: payoutCents }, lockedCents: { decrement: bet.stakeCents } },
        });

        if (won) {
          // FEED bets earn shards UNCAPPED (and off the deck's daily-cap ledger); DECK bets stay
          // capped at SHARD_DAILY_CAP. The bet's own source decides — see awardShard bypassCap.
          const r = await awardShard(tx, bet.userId, bet.id, bet.createdAt, { bypassCap: bet.source === "FEED" });
          if (r.shardAwarded) shardsAwarded++;
        }
        settled++;
      }

      return { settled, voided, shardsAwarded };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
