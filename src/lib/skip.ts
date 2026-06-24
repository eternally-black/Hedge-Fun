import { prisma } from "./prisma";
import { utcDay } from "./time";
import { FREE_SKIPS_PER_DAY, SKIP_SHARD_COST } from "./config";

// Skip a card: the first FREE_SKIPS_PER_DAY/day are free; each subsequent skip costs
// SKIP_SHARD_COST shards. Blocked (no-op) if a paid skip is needed and the user lacks shards.
// Skip is NOT tied to a market (it makes no bet), so it's a daily counter increment plus a
// conditional shard decrement, all atomic so the counter and the spend can't diverge.
export type SkipResult =
  | { ok: true; free: boolean; shardsSpent: number; skipsToday: number; shards: number }
  | { ok: false; reason: "no_shards"; shards: number };

// Pure decision (DB-free, testable): given skips used today and shard balance, decide whether
// the next skip is free, paid, or blocked. Free until FREE_SKIPS_PER_DAY used; then it costs
// SKIP_SHARD_COST shards; blocked if the balance can't cover the cost.
export function decideSkip(
  skipsUsedToday: number,
  shards: number,
): { free: boolean; allowed: boolean; cost: number } {
  if (skipsUsedToday < FREE_SKIPS_PER_DAY) return { free: true, allowed: true, cost: 0 };
  const allowed = shards >= SKIP_SHARD_COST;
  return { free: false, allowed, cost: allowed ? SKIP_SHARD_COST : 0 };
}

export async function recordSkip(userId: string, at?: Date): Promise<SkipResult> {
  const day = utcDay(at);

  return prisma.$transaction(async (tx) => {
    // Read current state — count today's skips and the shard balance — WITHOUT mutating yet,
    // so a blocked paid skip neither counts nor spends.
    const counter = await tx.dailyCounter.upsert({
      where: { userId_utcDay: { userId, utcDay: day } },
      create: { userId, utcDay: day },
      update: {},
      select: { skipCount: true },
    });
    const bal = await tx.collectibleBalance.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { shards: true },
    });

    const d = decideSkip(counter.skipCount, bal.shards);
    if (!d.allowed) return { ok: false, reason: "no_shards", shards: bal.shards };

    const updated = await tx.dailyCounter.update({
      where: { userId_utcDay: { userId, utcDay: day } },
      data: { skipCount: { increment: 1 } },
      select: { skipCount: true },
    });
    let shards = bal.shards;
    if (d.cost > 0) {
      const spent = await tx.collectibleBalance.update({
        where: { userId },
        data: { shards: { decrement: d.cost } },
        select: { shards: true },
      });
      shards = spent.shards;
    }
    return { ok: true, free: d.free, shardsSpent: d.cost, skipsToday: updated.skipCount, shards };
  });
}
