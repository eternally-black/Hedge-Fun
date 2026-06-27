import { prisma } from "./prisma";
import { utcDay } from "./time";

// Skip a card: ALWAYS free and unlimited — a skip just advances the deck so the user spends their
// 10 daily swipes only on cards they care about. It makes no bet (never touches the swipe cap) and
// no longer costs a shard. We still increment the daily skipCount (kept for analytics). The shard
// economy is left in config for reference but no longer consumed by skips.
export type SkipResult =
  | { ok: true; free: boolean; shardsSpent: number; skipsToday: number; shards: number }
  | { ok: false; reason: "no_shards"; shards: number };

// Pure decision (DB-free, testable): a skip is always free, always allowed, costs nothing.
// (Signature kept so existing callers/tests compile; inputs no longer affect the outcome.)
export function decideSkip(
  _skipsUsedToday: number,
  _shards: number,
): { free: boolean; allowed: boolean; cost: number } {
  return { free: true, allowed: true, cost: 0 };
}

// freeOverride: dev test account — always free, unlimited, never spends a shard or blocks.
export async function recordSkip(userId: string, at?: Date, freeOverride = false): Promise<SkipResult> {
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

    const d = freeOverride
      ? { free: true, allowed: true, cost: 0 } // dev: unlimited free skips
      : decideSkip(counter.skipCount, bal.shards);
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
