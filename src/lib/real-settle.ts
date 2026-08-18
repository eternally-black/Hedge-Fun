// Server-side settlement for REAL positions, and the sweep that stops a dead intent from wedging a
// market. Both exist because the money path was, until now, entirely client-driven: a position on a
// market that had already resolved sat "open" in the app until the user happened to open the
// developer console and press REDEEM. A lost position needs no signature and no relayer — it
// redeems to zero — so waiting for a human to ask for it was never the right shape.
import type { PrismaClient } from "@prisma/client";
import { planRedeem, type RedeemCandidate } from "./redeem";
import { erc1155BalanceOf } from "./polygon";
import { CONDITIONAL_TOKENS } from "./wallet-ops";
import { SHARE_TICK_MICRO } from "./config";

// Close a resolved position's remainder and realize it. Winner: $1/share. CANCELED (this repo's
// INVALID resolution): an invalid binary CTF market pays [1,1], so EVERY share of either side
// redeems $0.50 — booking it 1:1 overstated realized PnL by half the remainder. Loser: zero.
// Idempotent by construction: a consumed position has no remainder left, and false says there was
// nothing to consume. The re-read lives INSIDE the transaction — a read-then-update could double
// book under two concurrent callers.
//
// It also stamps the paper-shaped settlement fields. A real position never passes through the paper
// settle job, so without this it has no result, no settledAt and no unseen flag — which is why a
// market could resolve, the money arrive, and the app still say "awaiting result" with nothing to
// tell the user. Those three fields are what the results inbox and the reveal ritual read.
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
    const realized = (b.realizedPnlMicro ?? 0n) + proceeds - basis;
    await tx.bet.update({
      where: { id: b.id },
      data: {
        closedSharesMicro: filled,
        proceedsMicro: (b.proceedsMicro ?? 0n) + proceeds,
        realizedPnlMicro: realized,
        // The outcome as the LEDGER sees it, which is the money and not the market: a position
        // exited at a profit on a market that later resolved against it is a win for the person who
        // took it. PUSH is reserved for the exactly-flat case — an invalid market usually is not.
        settlementStatus: "SETTLED",
        result: realized > 0n ? "WIN" : realized < 0n ? "LOSS" : "PUSH",
        pnlCents: Number(realized / 10_000n),
        settledAt: new Date(),
      },
    });
    return true;
  });
}

// Book what the server can settle on its own. Two of the three cases need no signature at all: a
// position the market decided AGAINST redeems to zero, and a sub-tick remnant is unsellable by
// construction. The third — a WINNER — is only booked once the collateral has demonstrably moved:
// the outcome token has left the wallet, which is what Polymarket's auto-redeemer does with the
// operator right granted during activation. Resolution alone is not proof; the token balance is.
// `tokenBalance` is injected the way funding.ts and reconcile.ts inject their probes: the chain read
// is the one thing a test cannot fake otherwise, and it is exactly the rule worth pinning — a win is
// booked on PROOF, not on the market's verdict.
export type TokenBalanceProbe = (wallet: string, tokenId: string) => Promise<bigint>;

export async function settleResolvedRealPositions(
  prisma: PrismaClient,
  tokenBalance: TokenBalanceProbe = (wallet, tokenId) => erc1155BalanceOf(CONDITIONAL_TOKENS, wallet, tokenId),
): Promise<{ lost: number; won: number; dust: number; winnersPending: number }> {
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
      user: { select: { depositWalletAddress: true } },
      market: {
        select: { status: true, resolvedOutcome: true, negRisk: true, yesTokenId: true, noTokenId: true },
      },
    },
    take: 200,
  });
  const open = bets.filter((b) => (b.filledSharesMicro ?? 0n) - (b.closedSharesMicro ?? 0n) > 0n);
  if (open.length === 0) return { lost: 0, won: 0, dust: 0, winnersPending: 0 };

  const plan = planRedeem(open as unknown as RedeemCandidate[]);
  let lost = 0;
  for (const l of plan.losses) if (await consumeResolvedPosition(prisma, l.id, false, false)) lost++;

  let won = 0;
  let dust = 0;
  let winnersPending = 0;
  for (const c of open) {
    if (plan.losses.some((l) => l.id === c.id)) continue;
    const rem = (c.filledSharesMicro ?? 0n) - (c.closedSharesMicro ?? 0n);
    if (rem <= 0n) continue;
    // A remnant below one share tick is not worth a redemption of its own — nobody can sell it and
    // a device prompt for three thousandths of a share is not a trade. Written off at zero so it
    // stops holding the position open.
    if (rem < SHARE_TICK_MICRO) {
      if (await consumeResolvedPosition(prisma, c.id, false, false)) dust++;
      continue;
    }
    const wallet = c.user?.depositWalletAddress;
    const tokenId = c.side === "YES" ? c.market.yesTokenId : c.market.noTokenId;
    if (!wallet || !tokenId) {
      winnersPending++;
      continue;
    }
    let balance: bigint;
    try {
      balance = await tokenBalance(wallet, tokenId);
    } catch {
      winnersPending++; // an unreadable chain is not proof of anything
      continue;
    }
    if (balance > 0n) {
      winnersPending++; // still holding the position: the redemption has not landed yet
      continue;
    }
    // The token is gone from a wallet that held it on a market that resolved in its favour: the
    // redeemer burned it and sent the collateral. THAT is when the win is booked.
    const canceled = c.market.status === "CANCELED";
    if (await consumeResolvedPosition(prisma, c.id, true, canceled)) won++;
  }
  return { lost, won, dust, winnersPending };
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
