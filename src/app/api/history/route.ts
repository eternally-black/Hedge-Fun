import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import type { HistoryResponse } from "@/lib/api-types";

// Prediction history: the user's bets joined with market info. PENDING (awaiting resolution)
// first, then most-recently-settled. Returns the REAL side label the user picked (team/Over/Up/
// Yes), the status, and P&L in cents for settled bets.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const bets = await prisma.bet.findMany({
    where: { userId: user.id },
    // Pending first (settlementStatus PENDING < SETTLED alphabetically is wrong, so order by a
    // computed flag): we sort in JS below. Pull a generous recent window.
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      side: true,
      stakeCents: true,
      lockedPriceBp: true,
      settlementStatus: true,
      result: true,
      pnlCents: true,
      createdAt: true,
      settledAt: true,
      market: {
        select: { question: true, outcomeYesLabel: true, outcomeNoLabel: true, resolutionDeadline: true },
      },
    },
  });

  const rows: HistoryResponse["rows"] = bets.map((b) => ({
    id: b.id,
    question: b.market.question,
    // The label of the side the user actually bet (YES = side A label, NO = side B label).
    sideLabel: b.side === "YES" ? b.market.outcomeYesLabel : b.market.outcomeNoLabel,
    side: b.side, // "YES" | "NO" — drives the badge color
    stakeCents: b.stakeCents,
    lockedPriceBp: b.lockedPriceBp,
    status: b.settlementStatus === "PENDING" ? "PENDING" : b.result, // PENDING | WIN | LOSS | PUSH
    pnlCents: b.pnlCents,
    resolutionDeadline: b.market.resolutionDeadline.toISOString(),
    createdAt: b.createdAt.toISOString(),
  }));

  // Pending first (most urgent / what the user wants to glance at), then settled by recency.
  rows.sort((a, b) => {
    const ap = a.status === "PENDING" ? 0 : 1;
    const bp = b.status === "PENDING" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return +new Date(b.createdAt) - +new Date(a.createdAt);
  });

  const pendingCount = rows.filter((r) => r.status === "PENDING").length;
  return NextResponse.json({ rows, pendingCount });
}
