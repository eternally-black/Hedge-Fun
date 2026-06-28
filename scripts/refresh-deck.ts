// Populate/refresh the Market cache from Polymarket so /api/deck reads the DB, not the
// live API per request. Run: npm run refresh-deck  (later: poller calls this each tick).
import { PrismaClient } from "@prisma/client";
import { fetchBlitzDeck } from "../src/lib/polymarket";
import { DECK_FETCH_HORIZON_HOURS } from "../src/lib/deck-mix";

const prisma = new PrismaClient();

export async function refreshDeck(hours = DECK_FETCH_HORIZON_HOURS, limit = 100): Promise<number> {
  const markets = await fetchBlitzDeck(hours, limit);
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
        startsAt: m.startsAt ? new Date(m.startsAt) : null,
        resolutionDeadline: new Date(m.resolutionDeadline),
        status: m.status,
      },
      update: {
        outcomeYesLabel: m.outcomeYesLabel,
        outcomeNoLabel: m.outcomeNoLabel,
        yesPriceBp: m.yesPriceBp,
        noPriceBp: m.noPriceBp,
        startsAt: m.startsAt ? new Date(m.startsAt) : null,
        resolutionDeadline: new Date(m.resolutionDeadline),
        status: m.status,
        lastPolledAt: new Date(),
      },
    });
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
