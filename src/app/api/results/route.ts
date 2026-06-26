import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { resultBetSelect, toResultRow } from "@/lib/results";
import type { ResultsResponse } from "@/lib/api-types";

// Settled-results feed: the user's SETTLED/VOID bets, newest first. Feeds the inbox list and
// the reveal (reveal = rows where seen=false). Shape pinned by ResultsResponse.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Count unread over the FULL set, not the windowed rows — otherwise a user with >100 settled
  // bets whose unseen ones fall outside the latest 100 would show a different badge here than in
  // /api/me (which counts unwindowed). Both must agree, so unreadCount is its own count().
  const [bets, unreadCount] = await Promise.all([
    prisma.bet.findMany({
      where: { userId: user.id, settlementStatus: { in: ["SETTLED", "VOID"] } },
      orderBy: { settledAt: "desc" },
      take: 100,
      select: resultBetSelect,
    }),
    prisma.bet.count({
      where: { userId: user.id, settlementStatus: { in: ["SETTLED", "VOID"] }, seenAt: null },
    }),
  ]);

  const rows = bets.map(toResultRow);
  const body: ResultsResponse = { rows, unreadCount };
  return NextResponse.json(body);
}
