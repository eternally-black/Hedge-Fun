import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import type { SeenRequest, SeenResponse } from "@/lib/api-types";

// Mark only the results the client actually received. Idempotent: only seenAt IS NULL rows are
// touched, so a replay marks 0. The delivery mode comes from GET /results and is echoed back; it is
// intentionally independent of the user's current toggle because that may change while a page is
// open.
//
// The body is OPTIONAL for old clients, but an absent betIds list is now a safe no-op. A client that
// shows stock alerts acknowledges exactly the (positionId, tierBp) pairs it displayed: a tier that
// fired between its GET and this POST stays unread instead of being cleared unseen.
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
    const rawIds = body?.betIds;
    if (rawIds !== undefined && !Array.isArray(rawIds)) {
      return NextResponse.json({ error: "bad_bet_ids" }, { status: 400 });
    }
    if (Array.isArray(rawIds) && rawIds.length > 100) {
      return NextResponse.json({ error: "too_many_bet_ids" }, { status: 400 });
    }
    if (body?.mode !== undefined && body.mode !== "PAPER" && body.mode !== "REAL") {
      return NextResponse.json({ error: "bad_mode" }, { status: 400 });
    }
    if (Array.isArray(rawIds) && rawIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 191)) {
      return NextResponse.json({ error: "bad_bet_ids" }, { status: 400 });
    }
    const betIds = [...new Set(rawIds ?? [])];
    if (betIds.length > 0) {
      if (body?.mode !== "PAPER" && body?.mode !== "REAL") {
        return NextResponse.json({ error: "bad_mode" }, { status: 400 });
      }
      const { count } = await prisma.bet.updateMany({
        where: {
          id: { in: betIds },
          userId: user.id,
          mode: body.mode,
          settlementStatus: { in: ["SETTLED", "VOID"] },
          seenAt: null,
        },
        data: { seenAt: new Date() },
      });
      markedSeen = count;
    }
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
