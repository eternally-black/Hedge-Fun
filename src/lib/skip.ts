import { prisma } from "./prisma";
import { utcDay } from "./time";

// Skip a card: ALWAYS free and unlimited — a skip just advances the deck so the user spends their
// 10 daily swipes only on cards they care about. It makes no bet (never touches the swipe cap) and
// costs nothing (product pivot away from the shard sink). We still increment the daily skipCount
// (kept for analytics).
export type SkipResult = { ok: true; skipsToday: number };

// Bump today's skip count and return it. One upsert: create today's counter at 1, or increment it.
export async function recordSkip(userId: string, at?: Date): Promise<SkipResult> {
  const day = utcDay(at);
  const counter = await prisma.dailyCounter.upsert({
    where: { userId_utcDay: { userId, utcDay: day } },
    create: { userId, utcDay: day, skipCount: 1 },
    update: { skipCount: { increment: 1 } },
    select: { skipCount: true },
  });
  return { ok: true, skipsToday: counter.skipCount };
}
