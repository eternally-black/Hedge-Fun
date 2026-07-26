import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";

import { categoryOf, shuffleNoRun, isContextPoor, isVagueEsports, withinCategoryHorizon, DECK_FETCH_HORIZON_HOURS } from "@/lib/deck-mix";
import { DECK_MIN_LEAD_MS } from "@/lib/config";
import { priceIsContested } from "@/lib/polymarket";
import { authoritativePrices } from "@/lib/depth";
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
  //
  // The contested band is NOT a SQL filter anymore: it must consume the AUTHORITATIVE price per row
  // (the eff VWAP for POLYMARKET — null when no fresh book read exists, i.e. "not servable"; the
  // synthetic mid for TXODDS) — not expressible as one column predicate. It runs in JS below
  // alongside the other serve-time quality filters (the take:500 pool leaves ample headroom).
  const candidates = await prisma.market.findMany({
    where: {
      status: "OPEN",
      // Lower bound = now + lead: never serve a card already within the freshness cutoff (the client
      // also prunes live as cards age, and the swipe route rejects a stale market — defense in depth).
      resolutionDeadline: { gt: new Date(now.getTime() + DECK_MIN_LEAD_MS), lte: max },
      bets: { none: { userId: user.id } }, // anti-join: never re-serve a card the user already bet
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
      yesEffPriceBp: true,
      noEffPriceBp: true,
      bookTsAt: true,
      source: true,
      resolutionDeadline: true,
    },
  });

  // Drop, at serve time (so it also clears already-cached rows, not just new ingests):
  //  - context-poor markets (bare Over/Under totals with no match named, e.g. "Games Total: O/U 4.5")
  //  - vague esports (classified esports but no identifiable game → bare "Esports" badge)
  //  - markets past THEIR category horizon (a cached crypto row that drifted beyond 24h, etc.) — the
  //    real per-category enforcement; the DB query only knows the flat outer window.
  //  - rows outside the contested band on the AUTHORITATIVE price (D10): re-asserted at serve time
  //    because a market cached while tradable can collapse or lose its book between poller ticks.
  //    authoritativePrices returns nulls for a POLYMARKET row with no usable (fresh-enough) book
  //    read — never a mid — so those rows drop out here too.
  const nowMs = now.getTime();
  const usable = candidates
    .filter(
      (c) => !isContextPoor(c) && !isVagueEsports(c) && withinCategoryHorizon(c, c.resolutionDeadline.getTime(), nowMs),
    )
    .map((c) => ({ c, p: authoritativePrices(c, nowMs) }))
    .filter(({ p }) => p.yes !== null && p.no !== null && priceIsContested(p.yes, p.no));

  // Randomly mix categories with the rule: never >2 cards of the same category in a row.
  // Seed from the clock so each fetch yields a fresh order.
  const cards = shuffleNoRun(usable, (u) => categoryOf(u.c), DECK_SIZE, Date.now() & 0x7fffffff);
  const body: DeckResponse = {
    cards: cards.map(({ c, p }) => ({
      // Explicit field list (no spread of the wider select) — the payload is the DeckCard contract.
      // yesPriceBp/noPriceBp carry the AUTHORITATIVE price (see above): the client always believed
      // this field to be "the price this side costs", and now it actually is. Band-filtered above,
      // so both are non-null here. resolutionDeadline is a Date → ISO string for the JSON contract.
      id: c.id,
      question: c.question,
      category: c.category,
      outcomeYesLabel: c.outcomeYesLabel,
      outcomeNoLabel: c.outcomeNoLabel,
      yesPriceBp: p.yes!,
      noPriceBp: p.no!,
      resolutionDeadline: c.resolutionDeadline.toISOString(),
    })),
  };
  return NextResponse.json(body);
}
