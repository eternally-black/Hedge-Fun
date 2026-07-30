// Populate/refresh the Market cache from Polymarket so /api/deck reads the DB, not the
// live API per request. Run: npm run refresh-deck  (later: poller calls this each tick).
import { PrismaClient } from "@prisma/client";
import { fetchBlitzDeck } from "../src/lib/polymarket";
import { DECK_FETCH_HORIZON_HOURS } from "../src/lib/deck-mix";
import { DECK_MIN_LEAD_MS, DECK_MIN_SERVABLE } from "../src/lib/config";

const prisma = new PrismaClient();

// What a refresh actually achieved. `upserted` is how many rows we wrote; `servable` is how many of
// them a user could still be DEALT once the DECK_MIN_LEAD_MS buffer is applied.
//
// Those two numbers diverged catastrophically on prod (2026-07-30) and only `upserted` was logged:
// every tick cheerfully reported "refreshed 100 markets" while all 100 expired within the hour, so
// the live deck held ~26 cards and users saw an empty screen for weeks. Counting the wrong thing is
// what made a gradual degradation invisible — so the poller now reports BOTH and alarms on the one
// that matters.
export interface RefreshResult {
  upserted: number;
  servable: number;
}

export async function refreshDeck(hours = DECK_FETCH_HORIZON_HOURS, limit = 100): Promise<RefreshResult> {
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
  // Measure against the SERVE rule, not the fetch rule: a market inside the lead buffer is cached
  // but undealable, so it must not count as inventory.
  const cutoff = Date.now() + DECK_MIN_LEAD_MS;
  const servable = markets.filter((m) => new Date(m.resolutionDeadline).getTime() > cutoff).length;
  return { upserted: markets.length, servable };
}

// Run directly (not when imported by the poller).
if (process.argv[1] && process.argv[1].endsWith("refresh-deck.ts")) {
  refreshDeck()
    .then((r) => {
      console.log(`refresh-deck: upserted ${r.upserted} markets (${r.servable} servable)`);
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-deck failed:", e);
      process.exit(1);
    });
}
