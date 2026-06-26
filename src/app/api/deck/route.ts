import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";

import { categoryOf, shuffleNoRun, isContextPoor } from "@/lib/deck-mix";
import type { DeckResponse } from "@/lib/api-types";

// The blitz deck: cached OPEN binary markets resolving within 48h.
// 48h (not 24h) so the pool includes sports/esports (teams, players), which resolve further
// out than the minute-by-minute crypto Up/Down. Reads the Market cache (refresh-deck/poller).
const DECK_WINDOW_HOURS = 48;
const DECK_SIZE = 50;

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const max = new Date(now.getTime() + DECK_WINDOW_HOURS * 3_600_000);

  // Exclude markets this user already swiped: Bet has @@unique([userId, marketId]) (one bet per
  // card), so re-serving a swiped market would throw P2002 -> 409 on the next swipe. A swiped
  // card never comes back.
  const swiped = await prisma.bet.findMany({
    where: { userId: user.id },
    select: { marketId: true },
  });
  const swipedIds = swiped.map((b) => b.marketId);

  // Wider candidate pool than DECK_SIZE so the mixer has variety to draw from. Pure
  // endDate-order would be a wall of crypto (resolves in minutes), so we shuffle below.
  const candidates = await prisma.market.findMany({
    where: {
      status: "OPEN",
      resolutionDeadline: { gt: now, lte: max },
      id: { notIn: swipedIds }, // never re-serve a card the user already bet
      // Contested-price band (15%..85%): re-assert at serve time, because a market cached while
      // fair can collapse to ~100%/0% once its match goes live. Drops decided/live cards so the
      // user never sees a dead 100% swipe. Same band as fetchBlitzDeck's priceIsContested.
      yesPriceBp: { gte: 1500, lte: 8500 },
      noPriceBp: { gte: 1500, lte: 8500 },
    },
    orderBy: { resolutionDeadline: "asc" },
    take: 300,
    select: {
      id: true,
      question: true,
      category: true,
      outcomeYesLabel: true,
      outcomeNoLabel: true,
      yesPriceBp: true,
      noPriceBp: true,
      resolutionDeadline: true,
    },
  });

  // Drop context-poor markets (bare Over/Under totals with no match named, e.g. "Games Total:
  // O/U 4.5") at serve time — this also clears any such rows already cached in the DB, not just
  // new ingests. Applied before the mix so the deck only carries cards a user can make sense of.
  const usable = candidates.filter((c) => !isContextPoor(c));

  // Randomly mix categories with the rule: never >2 cards of the same category in a row.
  // Seed from the clock so each fetch yields a fresh order.
  const cards = shuffleNoRun(usable, (c) => categoryOf(c), DECK_SIZE, Date.now() & 0x7fffffff);
  const body: DeckResponse = {
    cards: cards.map((c) => ({
      ...c,
      // The query filters yes/noPriceBp to 1500..8500, so they're non-null here (the DB column
      // is nullable in general). resolutionDeadline is a Date → ISO string for the JSON contract.
      yesPriceBp: c.yesPriceBp!,
      noPriceBp: c.noPriceBp!,
      resolutionDeadline: c.resolutionDeadline.toISOString(),
    })),
  };
  return NextResponse.json(body);
}
