import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { effectiveRealMode } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import type { SeenRequest, SeenResponse } from "@/lib/api-types";

// Mark the user's unseen settled results as seen. Idempotent: only seenAt IS NULL rows are touched,
// so a second call marks 0.
//
// The body is OPTIONAL and its absence means "bets only" — that is what the shipped mobile client
// sends, and it cannot render stock alerts, so it must never clear them. A client that shows stock
// alerts acknowledges exactly the (positionId, tierBp) pairs it displayed: a tier that fired between
// its GET and this POST stays unread instead of being cleared unseen.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`results-seen:${user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as SeenRequest | null;
  const scope = body?.scope === "stocks" || body?.scope === "both" ? body.scope : "bets";

  let markedSeen = 0;
  if (scope !== "stocks") {
    const { count } = await prisma.bet.updateMany({
      where: {
        userId: user.id,
        mode: effectiveRealMode(user), // marks what the user was actually shown
        settlementStatus: { in: ["SETTLED", "VOID"] },
        seenAt: null,
      },
      data: { seenAt: new Date() },
    });
    markedSeen = count;
  }

  let markedStockAlertsSeen = 0;
  const pairs = Array.isArray(body?.stockAlerts) ? body.stockAlerts.slice(0, 100) : [];
  const valid = pairs.filter(
    (p): p is { positionId: string; tierBp: number } =>
      !!p && typeof p.positionId === "string" && p.positionId.length > 0 && Number.isInteger(p.tierBp) && p.tierBp > 0,
  );
  if (scope !== "bets" && valid.length > 0) {
    const { count } = await prisma.stockPosition.updateMany({
      where: {
        userId: user.id,
        alertSeenAt: null,
        OR: valid.map((p) => ({ id: p.positionId, alertTierBp: p.tierBp })),
      },
      data: { alertSeenAt: new Date() },
    });
    markedStockAlertsSeen = count;
  }

  const res: SeenResponse = { markedSeen, markedStockAlertsSeen };
  return NextResponse.json(res);
}
