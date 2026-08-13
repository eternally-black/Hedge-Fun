// Dev/testing affordances, gated by the DEV_USER_EMAIL env var. When unset (production), every
// check returns false, so none of this affects real users. Only an exact, case-insensitive email
// match enables the bypass — so it's one specific tester account, not "any dev build".
import { prisma } from "./prisma";

const DEV_EMAIL = (process.env.DEV_USER_EMAIL ?? "").trim().toLowerCase();

export function isDevUser(email: string | null | undefined): boolean {
  if (!DEV_EMAIL) return false;
  return (email ?? "").trim().toLowerCase() === DEV_EMAIL;
}

// Wipe a user's bets so every market becomes swipeable again (the deck route excludes
// already-bet markets). Deletes dependent rows first (FKs: ShardGrant.betId, PointsLedger.betId,
// Bet -> shardGrant). Also clears today's swipe/skip counters so caps reset for fresh testing.
// Does NOT touch points/shards/streak balances — just re-deals the deck. Returns counts.
export async function resetUserDeck(userId: string): Promise<{ bets: number }> {
  return prisma.$transaction(async (tx) => {
    // PAPER only: deleting a REAL row would silently drop the position aggregate while the
    // exchange position lives on (OrderAttempt.betId goes SET NULL — no error, lost tracking).
    const betIds = (await tx.bet.findMany({ where: { userId, mode: "PAPER" }, select: { id: true } })).map((b) => b.id);
    await tx.shardGrant.deleteMany({ where: { betId: { in: betIds } } });
    await tx.pointsLedger.deleteMany({ where: { betId: { in: betIds } } });
    const del = await tx.bet.deleteMany({ where: { userId, mode: "PAPER" } });
    // Reset today's per-day counters so swipe/skip caps don't carry into the next test run.
    await tx.dailyCounter.updateMany({
      where: { userId },
      data: { swipeCount: 0, skipCount: 0, shardCount: 0 },
    });
    return { bets: del.count };
  });
}
