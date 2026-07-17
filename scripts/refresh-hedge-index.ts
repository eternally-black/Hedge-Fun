// Populate/refresh the hedge market index from Polymarket Gamma. For each crypto major (tag slugs
// bitcoin/ethereum/solana — verified live 2026-07-17), pull every open market under the tag, upsert
// the base Market cache row (so an accepted hedge settles through the SAME poller), and upsert the
// MarketMeta enrichment with a DETERMINISTICALLY parsed strike + date + direction (D1 — no LLM).
// Only markets that parse cleanly (parseOk) qualify for S1 matching; the run logs coverage
// (parsed vs skipped) per asset so we can measure. Run: npm run refresh-hedge-index
//
// Follows scripts/refresh-deck.ts: pure fetch/parse lives in src/lib, this script owns the upserts.
import { PrismaClient } from "@prisma/client";
import { fetchMajorsMarkets } from "../src/lib/polymarket";
import { parseStrikeMarket, type HedgeAsset } from "../src/lib/hedge/parse";

const prisma = new PrismaClient();

// Gamma tag ids for the majors (verified live 2026-07-17 via /tags/slug/<slug>).
const MAJOR_TAGS: { slug: string; tagId: number; asset: HedgeAsset }[] = [
  { slug: "bitcoin", tagId: 235, asset: "BTC" },
  { slug: "ethereum", tagId: 39, asset: "ETH" },
  { slug: "solana", tagId: 818, asset: "SOL" },
];

export interface HedgeIndexStats {
  discovered: number;
  upserted: number;
  parsed: number; // strike+date+direction all machine-parsed (S1-eligible)
  skipped: number; // discovered but not parseable (e.g. Up/Down dailies with no strike)
  byAsset: Record<string, { discovered: number; parsed: number; skipped: number }>;
}

export async function refreshHedgeIndex(): Promise<HedgeIndexStats> {
  const stats: HedgeIndexStats = { discovered: 0, upserted: 0, parsed: 0, skipped: 0, byAsset: {} };

  for (const tag of MAJOR_TAGS) {
    const rows = await fetchMajorsMarkets(tag.tagId);
    const a = (stats.byAsset[tag.asset] ??= { discovered: 0, parsed: 0, skipped: 0 });

    for (const row of rows) {
      stats.discovered++;
      a.discovered++;
      const m = row.cache;
      const parsed = parseStrikeMarket({ slug: row.slug, question: m.question });

      // Only S1-eligible markets are ever suggested/accepted, so we ONLY persist those — this keeps
      // the Market cache lean (skips the ~1.5k ephemeral Up/Down minute markets per run). Skipped
      // markets are still COUNTED for the coverage log.
      if (!parsed.parseOk) {
        stats.skipped++;
        a.skipped++;
        continue;
      }

      // Upsert the base Market cache row (mirrors refresh-deck) so the poller can settle it.
      const market = await prisma.market.upsert({
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
          question: m.question,
          outcomeYesLabel: m.outcomeYesLabel,
          outcomeNoLabel: m.outcomeNoLabel,
          yesPriceBp: m.yesPriceBp,
          noPriceBp: m.noPriceBp,
          startsAt: m.startsAt ? new Date(m.startsAt) : null,
          resolutionDeadline: new Date(m.resolutionDeadline),
          status: m.status,
          lastPolledAt: new Date(),
        },
        select: { id: true },
      });

      // Upsert the enrichment. asset from the parse when confident, else the tag's asset (coverage).
      const meta = {
        asset: parsed.asset ?? tag.asset,
        tagSlug: tag.slug,
        eventSlug: row.eventSlug,
        eventTicker: row.eventTicker,
        series: row.seriesTitle,
        strikeCents: parsed.strikeCents,
        direction: parsed.direction, // "UP" | "DOWN" | null (matches HedgeMarketDirection)
        parsedDeadline: new Date(m.resolutionDeadline),
        liquidityCents: row.liquidityNum != null ? Math.round(row.liquidityNum * 100) : null,
        volumeCents: row.volumeNum != null ? Math.round(row.volumeNum * 100) : null,
        parseOk: parsed.parseOk,
      };
      await prisma.marketMeta.upsert({
        where: { marketId: market.id },
        create: { marketId: market.id, ...meta },
        update: meta,
      });

      stats.upserted++;
      stats.parsed++;
      a.parsed++;
    }
  }

  return stats;
}

// Run directly (not when imported by the poller/tests).
if (process.argv[1] && process.argv[1].endsWith("refresh-hedge-index.ts")) {
  refreshHedgeIndex()
    .then((s) => {
      const pct = s.discovered ? ((s.parsed / s.discovered) * 100).toFixed(1) : "0.0";
      console.log(`refresh-hedge-index: discovered=${s.discovered} upserted=${s.upserted} parsed=${s.parsed} skipped=${s.skipped} (coverage ${pct}%)`);
      for (const [asset, a] of Object.entries(s.byAsset)) {
        const apct = a.discovered ? ((a.parsed / a.discovered) * 100).toFixed(1) : "0.0";
        console.log(`  ${asset}: discovered=${a.discovered} parsed=${a.parsed} skipped=${a.skipped} (coverage ${apct}%)`);
      }
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-hedge-index failed:", e);
      process.exit(1);
    });
}
