// DB-backed check for the shared hedge-index upsert (scripts/refresh-hedge-index.ts): a settled
// market must STAY settled when the indexer re-upserts it from a lagging OPEN Gamma payload, and
// the league name from Gamma's tags must be persisted on both create and update.
// Needs DATABASE_URL (Docker DB). Run: npx tsx scripts/test-hedge-index-upsert.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { upsertIndexedMarket } from "./refresh-hedge-index";
import type { MarketCache } from "../src/lib/polymarket";
import type { MarketDepth } from "../src/lib/depth";

async function main() {
  const tag = `hedgeidx-${process.pid}-${Date.now() & 0xffffff}`;
  const polymarketId = `${tag}-m1`;
  let marketId: string | null = null;

  try {
    // C1: a settled market row, as the poller would have left it.
    const created = await prisma.market.create({
      data: {
        polymarketId,
        question: "hedge index upsert test",
        status: "RESOLVED",
        resolvedOutcome: "YES",
        resolvedAt: new Date(),
        league: null,
        yesPriceBp: 5000,
        noPriceBp: 5000,
        resolutionDeadline: new Date(Date.now() - 3_600_000), // one hour in the past
      },
    });
    marketId = created.id;

    // C2: the indexer's view of the SAME market — OPEN (Gamma lagging), league named from tags.
    const cache: MarketCache = {
      polymarketId,
      question: "hedge index upsert test",
      category: "sports",
      outcomeYesLabel: "Yes",
      outcomeNoLabel: "No",
      yesPriceBp: 4800,
      noPriceBp: 5200,
      yesTokenId: null,
      noTokenId: null,
      bestAskBp: null,
      yesEffPriceBp: null,
      noEffPriceBp: null,
      yesMaxStakeCents: null,
      noMaxStakeCents: null,
      bookTsAt: null,
      league: "Soccer",
      startsAt: null,
      resolutionDeadline: new Date(Date.now() - 3_600_000).toISOString(),
      status: "OPEN",
      resolvedOutcome: null,
    };
    const depth: MarketDepth = {
      yesEffPriceBp: 5100,
      noEffPriceBp: 5100,
      yesMaxStakeCents: 1000,
      noMaxStakeCents: 1000,
      bookTsAtMs: Date.now(),
      tradable: true,
    };

    // C3: upsert and assert the settled state survives + league/depth numbers land.
    const upserted = await upsertIndexedMarket(cache, depth);
    assert.strictEqual(upserted.id, created.id, "upsert returned the existing row's id");

    const row = await prisma.market.findUniqueOrThrow({ where: { id: created.id } });
    assert.strictEqual(row.status, "RESOLVED", "settled status survives the OPEN upsert");
    assert.strictEqual(row.resolvedOutcome, "YES", "resolved outcome survives");
    assert.strictEqual(row.league, "Soccer", "league persisted from Gamma tags");
    assert.strictEqual(row.yesEffPriceBp, 5100, "depth eff price persisted");
    assert.strictEqual(row.yesPriceBp, 4800, "Gamma mid updated");
    assert.notStrictEqual(row.lastPolledAt, null, "lastPolledAt stamped");

    console.log("OK: hedge-index upsert — a settled market stays settled, league is persisted");
  } finally {
    // C4: cleanup — marketMeta first (FK), then the market row.
    if (marketId) {
      await prisma.marketMeta.deleteMany({ where: { marketId } });
      await prisma.market.deleteMany({ where: { id: marketId } });
    }
  }
}

// The import above creates a second PrismaClient at module scope; its CLI guard keeps the refresh
// from running, but that client could keep the process alive — exit explicitly after the OK log.
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
