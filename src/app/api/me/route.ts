import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { effectivePoints } from "@/lib/points";
import { evaluateStreak } from "@/lib/streak";
import { utcDay } from "@/lib/time";
import { SWIPE_CAP, FREE_SKIPS_PER_DAY, SKIP_SHARD_COST } from "@/lib/config";
import { isDevUser } from "@/lib/dev";

// Account snapshot: balance, points (multiplier-applied), today's swipe count, shards,
// artifacts, streak, login state.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const dev = isDevUser(user.email);
  const day = utcDay();
  // Defensive streak sweep on read (idempotent), then fan out the reads in parallel.
  await evaluateStreak(user.id);
  const [points, balance, collectibles, streak, counter, loginMark] = await Promise.all([
    effectivePoints(prisma, user.id),
    prisma.virtualBalance.findUnique({ where: { userId: user.id } }),
    prisma.collectibleBalance.findUnique({ where: { userId: user.id } }),
    prisma.streak.findUnique({ where: { userId: user.id } }),
    prisma.dailyCounter.findUnique({ where: { userId_utcDay: { userId: user.id, utcDay: day } } }),
    prisma.loginMark.findUnique({ where: { userId_utcDay: { userId: user.id, utcDay: day } } }),
  ]);

  return NextResponse.json({
    user: { id: user.id, email: user.email, twitter: user.twitterHandle, referralCode: user.referralCode },
    balanceCents: balance?.balanceCents ?? 0,
    points: { total: points.total, breakdown: points.breakdown, bonusFromX2: points.bonusFromX2 },
    swipes: { used: counter?.swipeCount ?? 0, cap: SWIPE_CAP },
    skips: {
      usedToday: counter?.skipCount ?? 0,
      // Dev account skips free forever, so the client never pre-blocks it.
      nextIsFree: dev || (counter?.skipCount ?? 0) < FREE_SKIPS_PER_DAY,
      shardCost: SKIP_SHARD_COST, // cost of the next skip once free ones are used
    },
    dev,
    shards: collectibles?.shards ?? 0,
    artifacts: collectibles?.artifacts ?? 0,
    streak: {
      level: streak?.currentLevel ?? 0,
      state: streak?.state ?? "ACTIVE",
      recoverableUntil: streak?.recoverableUntil ?? null,
    },
    loginMarkedToday: !!loginMark,
  });
}
