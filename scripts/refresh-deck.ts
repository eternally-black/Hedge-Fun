// Populate/refresh the Market cache from Polymarket so /api/deck reads the DB, not the
// live API per request. Run: npm run refresh-deck  (later: poller calls this each tick).
//
// D10: fetchBlitzDeck returns only markets that PASSED the depth gate (both books fill STAKE_CENTS
// within the eligibility cap, effective prices contested) with the executable numbers attached —
// we persist them verbatim. Markets that fail the gate on EITHER side are dropped (a card offers
// two swipe directions, so both must be tradable). Markets the gate EVALUATED and found UNTRADABLE
// also come back in `rejected` and get an explicit rejection stamp (1b: eff prices null, capacity 0,
// bookTsAt = now) so an already-cached row stops serving within this tick instead of lingering on
// stale eff prices until the display-staleness bound — and "read and untradable" (bookTsAt set, eff
// null) is distinguishable from "never read" (both null). Rows never evaluated are left untouched
// (fetchBlitzDeck breaks early once its buckets fill). TXODDS football rows are untouched here
// (they are owned by refresh-football.ts and have no CLOB book — their new columns stay NULL).
import { PrismaClient } from "@prisma/client";
import { fetchBlitzDeck } from "../src/lib/polymarket";
import { DECK_FETCH_HORIZON_HOURS } from "../src/lib/deck-mix";

const prisma = new PrismaClient();

export async function refreshDeck(hours = DECK_FETCH_HORIZON_HOURS, limit = 100): Promise<number> {
  const { deck: markets, rejected } = await fetchBlitzDeck(hours, limit);
  for (const m of markets) {
    await prisma.market.upsert({
      where: { polymarketId: m.polymarketId },
      create: {
        polymarketId: m.polymarketId,
        question: m.question,
        category: m.category,
        outcomeYesLabel: m.outcomeYesLabel,
        outcomeNoLabel: m.outcomeNoLabel,
        yesPriceBp: m.yesPriceBp,
        noPriceBp: m.noPriceBp,
        yesTokenId: m.yesTokenId,
        noTokenId: m.noTokenId,
        yesEffPriceBp: m.yesEffPriceBp,
        noEffPriceBp: m.noEffPriceBp,
        yesMaxStakeCents: m.yesMaxStakeCents,
        noMaxStakeCents: m.noMaxStakeCents,
        bookTsAt: m.bookTsAt ? new Date(m.bookTsAt) : null,
        startsAt: m.startsAt ? new Date(m.startsAt) : null,
        resolutionDeadline: new Date(m.resolutionDeadline),
        status: m.status,
      },
      update: {
        outcomeYesLabel: m.outcomeYesLabel,
        outcomeNoLabel: m.outcomeNoLabel,
        yesPriceBp: m.yesPriceBp,
        noPriceBp: m.noPriceBp,
        yesTokenId: m.yesTokenId,
        noTokenId: m.noTokenId,
        yesEffPriceBp: m.yesEffPriceBp,
        noEffPriceBp: m.noEffPriceBp,
        yesMaxStakeCents: m.yesMaxStakeCents,
        noMaxStakeCents: m.noMaxStakeCents,
        bookTsAt: m.bookTsAt ? new Date(m.bookTsAt) : null,
        startsAt: m.startsAt ? new Date(m.startsAt) : null,
        resolutionDeadline: new Date(m.resolutionDeadline),
        status: m.status,
        lastPolledAt: new Date(),
      },
    });
  }
  // 1b rejection stamp: ONLY rows the gate evaluated and found untradable. updateMany (not upsert)
  // on purpose — there is nothing to CREATE: a rejected market that was never persisted has no stale
  // state to clear and nothing serves it. Absent ids no-op.
  if (rejected.length > 0) {
    const stamped = await prisma.market.updateMany({
      where: { polymarketId: { in: rejected } },
      data: {
        yesEffPriceBp: null,
        noEffPriceBp: null,
        yesMaxStakeCents: 0,
        noMaxStakeCents: 0,
        bookTsAt: new Date(), // "read and untradable" NOW — not the book's ts: this marks the verdict
      },
    });
    if (stamped.count > 0) console.log(`refresh-deck: stamped ${stamped.count} gate-rejected market(s) untradable`);
  }
  return markets.length;
}

// Run directly (not when imported by the poller).
if (process.argv[1] && process.argv[1].endsWith("refresh-deck.ts")) {
  refreshDeck()
    .then((n) => {
      console.log(`refresh-deck: upserted ${n} markets`);
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-deck failed:", e);
      process.exit(1);
    });
}
