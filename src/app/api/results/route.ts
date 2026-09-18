import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { resultBetSelect, toResultRow, toStockAlertRow } from "@/lib/results";
import { livePnlCents } from "@/lib/stocks";
import { effectiveRealMode } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import { encodeKeysetCursor, decodeKeysetCursor } from "@/lib/cursor";
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
  const mode = effectiveRealMode(user);
  const params = new URL(req.url).searchParams;
  const cursor = params.get("cursor");
  const unreadOnly = params.get("unseen") === "1";
  const after = cursor ? decodeKeysetCursor(cursor) : null;
  // Keyset on (settledAt desc, id desc) — a stable total order across pages. Over-fetch by one so
  // we can tell whether another page exists (51 rows = yes, drop the last and emit a cursor).
  const [bets, unreadCount, alertLots] = await Promise.all([
    prisma.bet.findMany({
      where: {
        userId: user.id,
        mode,
        settlementStatus: { in: ["SETTLED", "VOID"] },
        ...(unreadOnly ? { seenAt: null } : {}),
        ...(after
          ? { OR: [{ settledAt: { lt: after.at } }, { settledAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ settledAt: "desc" }, { id: "desc" }],
      take: 51,
      select: resultBetSelect,
    }),
    prisma.bet.count({
      where: {
        userId: user.id,
        mode,
        settlementStatus: { in: ["SETTLED", "VOID"] },
        seenAt: null,
      },
    }),
    // Stock profit alerts: open lots that crossed a tier, BOTH modes (deliberately not `mode` —
    // a Phantom buyer never flips the Polymarket real-mode switch). Newest tier first.
    prisma.stockPosition.findMany({
      where: { userId: user.id, closedAt: null, alertTierBp: { gt: 0 }, alertedAt: { not: null } },
      include: { asset: true },
      orderBy: { alertedAt: "desc" },
      take: 50,
    }),
  ]);
  // 51 rows = there is at least one more page. Drop the over-fetched row and remember where the
  // next page starts (the last row we actually keep).
  const hasMore = bets.length === 51;
  if (hasMore) bets.pop();
  const last = bets[bets.length - 1];
  const nextCursor = hasMore && last?.settledAt ? encodeKeysetCursor(last.settledAt, last.id) : null;

  const rows = bets.map(toResultRow);
  const stockAlerts = alertLots.map((p) => toStockAlertRow(p, livePnlCents));
  const body: ResultsResponse = { rows, mode, unreadCount, nextCursor, stockAlerts };
  return NextResponse.json(body);
}
