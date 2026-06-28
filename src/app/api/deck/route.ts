import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";

import { categoryOf, shuffleNoRun, isContextPoor, withinCategoryHorizon, DECK_FETCH_HORIZON_HOURS } from "@/lib/deck-mix";
import type { DeckResponse } from "@/lib/api-types";

// The blitz deck: cached OPEN binary markets, each kept only within ITS category's horizon
// (crypto/OU <=24h blitz-fresh; sports/esports <=72h so the deck carries variety, not a wall of
// crypto — see DECK_HORIZON_HOURS). The DB query pulls the OUTER window; withinCategoryHorizon then
// narrows per category. Reads the Market cache (refresh-deck/poller).
const DECK_WINDOW_HOURS = DECK_FETCH_HORIZON_HOURS; // outer bound; per-category cap applied below
const DECK_SIZE = 50;

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const now = new Date();
  const max = new Date(now.getTime() + DECK_WINDOW_HOURS * 3_600_000);

  // Wider candidate pool than DECK_SIZE so the mixer has variety to draw from. Pure
  // endDate-order would be a wall of crypto (resolves in minutes), so we shuffle below.
  // Exclude already-swiped markets with a `bets: { none }` anti-join (Postgres NOT EXISTS) instead
  // of fetching every swiped id and passing `id NOT IN (...)`: ONE query instead of two, and it
  // rides the Bet @@unique([userId, marketId]) index instead of an IN-list that grows unbounded
  // with the user's lifetime bets. Bet has one row per (user, market), so `none` == "not swiped"
  // (re-serving one would P2002 -> 409 on the next swipe anyway).
  const candidates = await prisma.market.findMany({
    where: {
      status: "OPEN",
      resolutionDeadline: { gt: now, lte: max },
      bets: { none: { userId: user.id } }, // anti-join: never re-serve a card the user already bet
      // Contested-price band (15%..85%): re-assert at serve time, because a market cached while
      // fair can collapse to ~100%/0% once its match goes live. Drops decided/live cards so the
      // user never sees a dead 100% swipe. Same band as fetchBlitzDeck's priceIsContested.
      yesPriceBp: { gte: 1500, lte: 8500 },
      noPriceBp: { gte: 1500, lte: 8500 },
    },
    orderBy: { resolutionDeadline: "asc" },
    // Cap generously above the live cache size so the soonest-ordered cut can't starve the sparse
    // sports/esports buckets (their cards resolve later, so a tight soonest-N would be all crypto).
    take: 500,
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

  // Drop, at serve time (so it also clears already-cached rows, not just new ingests):
  //  - context-poor markets (bare Over/Under totals with no match named, e.g. "Games Total: O/U 4.5")
  //  - markets past THEIR category horizon (a cached crypto row that drifted beyond 24h, etc.) — the
  //    real per-category enforcement; the DB query only knows the flat outer window.
  const nowMs = now.getTime();
  const usable = candidates.filter(
    (c) => !isContextPoor(c) && withinCategoryHorizon(c, c.resolutionDeadline.getTime(), nowMs),
  );

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
