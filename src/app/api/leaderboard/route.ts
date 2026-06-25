import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { scorePoints } from "@/lib/points";
import type { LeaderboardResponse } from "@/lib/api-types";

const TOP_N = 100;

// ponytail: "private" here means auth-required, not a separate audience — a valid session
// is needed so the board isn't publicly scrapable. A full public leaderboard is out of
// July scope.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // ponytail: no LeaderboardSnapshot for MVP — compute live every request. Reuse the SAME
  // multiplier seam as /me (scorePoints), so a strategy change rescores everyone here too.
  // Two queries, group in JS, score per user (avoids per-user N+1). Upgrade path: when live
  // scoring gets slow, materialise into LeaderboardSnapshot on a daily cron and read that.
  const [rows, streaks, users] = await Promise.all([
    prisma.pointsLedger.findMany({ select: { userId: true, type: true, amount: true, utcDay: true } }),
    prisma.streak.findMany({ select: { userId: true, currentLevel: true, state: true } }),
    prisma.user.findMany({ select: { id: true, twitterHandle: true } }),
  ]);

  const rowsByUser = new Map<string, { type: (typeof rows)[number]["type"]; amount: number; utcDay: string }[]>();
  for (const r of rows) {
    const arr = rowsByUser.get(r.userId);
    if (arr) arr.push(r);
    else rowsByUser.set(r.userId, [r]);
  }
  const streakByUser = new Map(streaks.map((s) => [s.userId, s]));

  // Score every user via the pure core, mask PII (twitter handle, else short id).
  const scored = users.map((u) => {
    const s = streakByUser.get(u.id);
    const result = scorePoints(
      rowsByUser.get(u.id) ?? [],
      { currentLevel: s?.currentLevel ?? 0, state: s?.state ?? "ACTIVE" },
      u.id,
    );
    return {
      userId: u.id,
      handle: u.twitterHandle ?? `user_${u.id.slice(-6)}`,
      points: result.total,
    };
  });

  // Rank desc by effective points; stable id tiebreak so ranks are deterministic.
  scored.sort((a, b) => b.points - a.points || (a.userId < b.userId ? -1 : 1));

  const top = scored.slice(0, TOP_N).map((u, i) => ({ rank: i + 1, ...u }));
  const meIdx = scored.findIndex((u) => u.userId === user.id);
  const me =
    meIdx === -1
      ? { rank: null, points: 0 }
      : { rank: meIdx + 1, points: scored[meIdx].points };

  const body: LeaderboardResponse = { top, me };
  return NextResponse.json(body);
}
