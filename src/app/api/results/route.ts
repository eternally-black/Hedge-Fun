import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { resultBetSelect, toResultRow } from "@/lib/results";
import { effectiveRealMode } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import type { ResultsResponse } from "@/lib/api-types";

// Settled-results feed: the user's SETTLED/VOID bets, newest first. Feeds the inbox list and
// the reveal (reveal = rows where seen=false). Shape pinned by ResultsResponse.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`results:${user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Count unread over the FULL set, not the windowed rows — otherwise a user with >100 settled
  // bets whose unseen ones fall outside the latest 100 would show a different badge here than in
  // /api/me (which counts unwindowed). Both must agree, so unreadCount is its own count().
  // FOLLOWS THE MODE. It did not, and could not: a real position never passed through the paper
  // settle job, so its settlementStatus stayed PENDING forever and a mode-following query would have
  // returned an empty screen. src/lib/real-settle.ts changed that — a resolved real position is now
  // booked and stamped server-side — and the consequence of leaving this paper-only was worse than
  // an empty screen: a market resolved, the collateral landed in the wallet, and the app told the
  // user nothing at all while still showing the position as awaiting a result.
  const [bets, unreadCount] = await Promise.all([
    prisma.bet.findMany({
      where: { userId: user.id, mode: effectiveRealMode(user), settlementStatus: { in: ["SETTLED", "VOID"] } },
      orderBy: { settledAt: "desc" },
      take: 100,
      select: resultBetSelect,
    }),
    prisma.bet.count({
      where: {
        userId: user.id,
        mode: effectiveRealMode(user),
        settlementStatus: { in: ["SETTLED", "VOID"] },
        seenAt: null,
      },
    }),
  ]);

  const rows = bets.map(toResultRow);
  const body: ResultsResponse = { rows, unreadCount };
  return NextResponse.json(body);
}
