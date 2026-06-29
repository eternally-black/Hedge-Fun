import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import type { BetSide, FootballMarketCard, FootballMatchResponse } from "@/lib/api-types";

// GET /api/football/match?fixtureId=<id> — the relevant binary markets for one World Cup fixture
// (the "{team} to win?" 1X2 binaries + Over/Under total-goals lines), pulled from the cached TXODDS
// Market rows (synthetic id "txline:{fixtureId}:{kind}"). Display surface for the football match view;
// betting goes through POST /api/feed/bet (these are ordinary Market rows). NOT band-filtered — a
// match's detail shows all its markets, favorites included.

// Display order: "to win" first, then goals lines ascending.
const KIND_RANK: Record<string, number> = { WINH: 0, WINA: 1, OU15: 2, OU25: 3, OU35: 4 };
function rankOf(polymarketId: string): number {
  return KIND_RANK[polymarketId.split(":")[2] ?? ""] ?? 99;
}

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const fixtureId = new URL(req.url).searchParams.get("fixtureId") ?? "";
  if (!/^\d+$/.test(fixtureId)) return NextResponse.json({ error: "fixtureId required" }, { status: 400 });

  const markets = await prisma.market.findMany({
    where: {
      source: "TXODDS",
      status: "OPEN",
      polymarketId: { startsWith: `txline:${fixtureId}:` },
      yesPriceBp: { not: null },
      noPriceBp: { not: null },
    },
    select: {
      id: true,
      polymarketId: true,
      question: true,
      category: true,
      outcomeYesLabel: true,
      outcomeNoLabel: true,
      yesPriceBp: true,
      noPriceBp: true,
      resolutionDeadline: true,
    },
  });

  // Which of these the user already bet (one bet per market) — so the card shows locked across sessions.
  const placedBy = new Map<string, BetSide>();
  if (markets.length) {
    const bets = await prisma.bet.findMany({
      where: { userId: user.id, marketId: { in: markets.map((m) => m.id) } },
      select: { marketId: true, side: true },
    });
    for (const b of bets) placedBy.set(b.marketId, b.side);
  }

  const cards: FootballMarketCard[] = markets
    .toSorted((a, b) => rankOf(a.polymarketId) - rankOf(b.polymarketId))
    .map((m) => ({
      id: m.id,
      question: m.question,
      category: m.category,
      outcomeYesLabel: m.outcomeYesLabel,
      outcomeNoLabel: m.outcomeNoLabel,
      yesPriceBp: m.yesPriceBp!,
      noPriceBp: m.noPriceBp!,
      resolutionDeadline: m.resolutionDeadline.toISOString(),
      placedSide: placedBy.get(m.id) ?? null,
    }));

  const body: FootballMatchResponse = { cards };
  return NextResponse.json(body);
}
