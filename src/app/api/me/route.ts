import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { effectivePoints } from "@/lib/points";
import { evaluateStreak } from "@/lib/streak";
import { utcDay } from "@/lib/time";
import { SWIPE_CAP } from "@/lib/config";

// Account snapshot: balance, points (multiplier-applied), today's swipe count, shards,
// artifacts, streak, login state.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
