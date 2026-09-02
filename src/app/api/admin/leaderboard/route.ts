import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isAdmin } from "@/lib/admin";
import { scorePoints } from "@/lib/points";
import { utcDay, dayToDate } from "@/lib/time";
import type { PointsType } from "@prisma/client";
import type { AdminLeaderboardResponse, AdminLeaderboardRow } from "@/lib/api-types";

// PRIVATE admin growth tool (NOT the public leaderboard). Returns PII (twitter handle, activity),
// so it's behind the ADMIN_EMAILS allowlist and never cached/indexed.
export const dynamic = "force-dynamic"; // never statically cached — PII + always-live

type LedgerRow = { type: PointsType; amount: number; utcDay: string; createdAt: Date };

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isAdmin(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Same live-query shape as the public leaderboard (no snapshot at MVP scale), enriched with the
  // columns the admin tool needs. One ledger fetch feeds all three time windows. The raw ledger
  // grows ~11 rows per user per day; the scorer only needs per-day sums.
  const [rows, streaks, users] = await Promise.all([
    prisma.pointsLedger.groupBy({
      by: ["userId", "type", "utcDay"],
      _sum: { amount: true },
      _max: { createdAt: true },
    }),
    prisma.streak.findMany({ select: { userId: true, currentLevel: true, state: true } }),
    prisma.user.findMany({
      where: {
        OR: [
          { pointsLedger: { some: {} } },
          { createdAt: { gt: new Date(Date.now() - 30 * 86_400_000) } },
        ],
      },
      select: { id: true, twitterHandle: true, lastSeenAt: true, createdAt: true },
    }),
  ]);

  const today = utcDay();
  const weekCutoff = utcDay(new Date(dayToDate(today).getTime() - 6 * 86_400_000)); // last 7 days incl. today

  const rowsByUser = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const arr = rowsByUser.get(r.userId);
    const row: LedgerRow = { type: r.type, amount: r._sum.amount ?? 0, utcDay: r.utcDay, createdAt: r._max.createdAt ?? new Date(0) };
    if (arr) arr.push(row);
    else rowsByUser.set(r.userId, [row]);
  }
  const streakByUser = new Map(streaks.map((s) => [s.userId, s]));

  const scored: Omit<AdminLeaderboardRow, "rank">[] = users.map((u) => {
    const s = streakByUser.get(u.id);
    const all = rowsByUser.get(u.id) ?? [];

    // Windowed sums are exact now: STREAK_X2 rows are ledger facts, so filtering to week/today
    // simply sums the rows that fall in that window.
    const pointsAll = scorePoints(all).total;
    const pointsWeek = scorePoints(all.filter((r) => r.utcDay >= weekCutoff)).total;
    const pointsToday = scorePoints(all.filter((r) => r.utcDay === today)).total;

    // lastSeenAt is set only at account creation (privy.ts), so it's stale for activity. The latest
    // ledger row (every swipe/login writes one) is the real activity proxy; fall back to createdAt.
    let latestMs = u.lastSeenAt ? u.lastSeenAt.getTime() : 0;
    latestMs = Math.max(latestMs, u.createdAt.getTime());
    for (const r of all) latestMs = Math.max(latestMs, r.createdAt.getTime());
    const lastActive = latestMs > 0 ? new Date(latestMs).toISOString() : null;

    return {
      userId: u.id,
      handle: u.twitterHandle ?? `user_${u.id.slice(-6)}`,
      twitterHandle: u.twitterHandle,
      hasTwitter: u.twitterHandle != null,
      pointsAll,
      pointsWeek,
      pointsToday,
      streakLevel: s?.currentLevel ?? 0,
      lastActive,
    };
  });

  // Canonical rank by all-time points; stable id tiebreak (matches the public route).
  scored.sort((a, b) => b.pointsAll - a.pointsAll || (a.userId < b.userId ? -1 : 1));
  const ranked: AdminLeaderboardRow[] = scored.map((u, i) => ({ rank: i + 1, ...u }));

  const body: AdminLeaderboardResponse = { rows: ranked, generatedAt: new Date().toISOString() };
  return NextResponse.json(body, {
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex" }, // PII: never cache/index
  });
}
