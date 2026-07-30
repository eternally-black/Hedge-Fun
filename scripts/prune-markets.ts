// Market cache GC. The Market table is an append-only cache of everything the poller ever ingested:
// nothing removes a market once it resolves, because settlement only touches rows that have bets.
// On prod (2026-07-30) that had grown to 157,301 rows of which 157,275 were already expired —
// 99.98% dead weight sitting in the path of every deck/feed query.
//
// What is safe to delete: a market whose deadline is comfortably past AND which no user ever bet on.
// A market WITH bets is kept forever — history, results and settlement all read through it, and the
// Bet -> Market foreign key would refuse the delete anyway.
//
// FOREIGN KEYS ARE THE MAINTENANCE HAZARD HERE. Every table that references Market must be cleared
// (or proven empty) before the row goes, or the DELETE fails with P2003 — the safe failure, but a
// failure nonetheless. Three referrers, handled three different ways on purpose:
//   Bet                  -> EXCLUDE the market. History, results and settlement all read through it.
//   HedgeSuggestionEvent -> EXCLUDE the market. Append-only funnel telemetry; deleting the market
//                           would orphan impression/dismiss rows and break any join that explains
//                           them. This set is small by construction (only markets ever SUGGESTED),
//                           so it cannot grow into the backlog this GC exists to clear.
//   MarketMeta           -> DELETE it alongside. Pure derived cache (strike/direction/league parse),
//                           rebuilt from Gamma by refresh-hedge-index; nothing is lost.
//
// Run: npm run prune-markets   (also called by the poller on a slow cadence)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Keep a week of already-resolved markets around. Cheap, and it leaves room to inspect recent
// settlement behaviour without going to Polymarket.
export const PRUNE_OLDER_THAN_DAYS = 7;
// Rows per run. Bounded so a poller tick stays short and no single statement takes a long lock —
// the backlog drains over several runs instead of one multi-second table sweep.
export const PRUNE_MAX_ROWS = 5_000;
const DELETE_CHUNK = 1_000; // ids per DELETE statement

export interface PruneResult {
  deleted: number;
  /** true when we hit the per-run cap, i.e. there is more to collect on the next run. */
  more: boolean;
}

export async function pruneMarkets(opts: { olderThanDays?: number; maxRows?: number } = {}): Promise<PruneResult> {
  const days = opts.olderThanDays ?? PRUNE_OLDER_THAN_DAYS;
  const maxRows = opts.maxRows ?? PRUNE_MAX_ROWS;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  // `none: {}` is an anti-join (NOT EXISTS) — one query, riding the existing indexes instead of
  // pulling every bet/event id into an IN-list.
  const doomed = await prisma.market.findMany({
    where: { resolutionDeadline: { lt: cutoff }, bets: { none: {} }, hedgeEvents: { none: {} } },
    select: { id: true },
    take: maxRows,
  });
  if (doomed.length === 0) return { deleted: 0, more: false };

  let deleted = 0;
  for (let i = 0; i < doomed.length; i += DELETE_CHUNK) {
    const chunk = doomed.slice(i, i + DELETE_CHUNK).map((m) => m.id);
    // Derived cache first — it has no independent value and its FK would block the market delete.
    await prisma.marketMeta.deleteMany({ where: { marketId: { in: chunk } } });
    // Re-assert the anti-joins inside the DELETE, not just in the SELECT above: a user can swipe
    // one of these ids, or a suggestion can log an impression against it, between the two
    // statements. Without the re-check the delete would fail on the foreign key — or, on a
    // cascade, silently take their bet or telemetry with it.
    const r = await prisma.market.deleteMany({
      where: { id: { in: chunk }, bets: { none: {} }, hedgeEvents: { none: {} } },
    });
    deleted += r.count;
  }
  return { deleted, more: doomed.length >= maxRows };
}

// Run directly (not when imported by the poller). Loops until the table is clean so a one-off
// cleanup of a large backlog doesn't need to be babysat.
if (process.argv[1] && process.argv[1].endsWith("prune-markets.ts")) {
  (async () => {
    let total = 0;
    for (;;) {
      const r = await pruneMarkets();
      total += r.deleted;
      console.log(`prune-markets: deleted ${r.deleted} (running total ${total})`);
      if (!r.more || r.deleted === 0) break;
    }
    const remaining = await prisma.market.count();
    console.log(`prune-markets: done — deleted ${total}, ${remaining} markets remain`);
    await prisma.$disconnect();
  })().catch(async (e) => {
    console.error("prune-markets failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
}
