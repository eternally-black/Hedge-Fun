// Populate/refresh the hedge market index from Polymarket Gamma. For each crypto major (tag slugs
// bitcoin/ethereum/solana — verified live 2026-07-17), pull every open market under the tag, upsert
// the base Market cache row (so an accepted hedge settles through the SAME poller), and upsert the
// MarketMeta enrichment with a DETERMINISTICALLY parsed strike + date + direction (D1 — no LLM).
// Only markets that parse cleanly (parseOk) qualify for S1 matching; the run logs coverage
// (parsed vs skipped) per asset so we can measure. Run: npm run refresh-hedge-index
//
// Follows scripts/refresh-deck.ts: pure fetch/parse lives in src/lib, this script owns the upserts.
//
// D10: persisted markets must also pass the DEPTH gate — both sides fill STAKE_CENTS within the
// eligibility slippage cap (src/lib/depth.ts) — and we persist the executable numbers (eff VWAP,
// max stake, book timestamp) alongside the Gamma mid. The gate here is depth ONLY, deliberately
// NOT the deck's contested band: the hedge engine has its own side bands downstream (matchS1's
// 1–99%, the S2 band below, and the accept-time band on the effective price), and a cheap tail
// market (5¢) is a legitimate hedge even though it would never make a swipe card.
//
// D10 follow-up (1b, item 4): a market the gate EVALUATED and found UNTRADABLE gets the same
// rejection stamp as refresh-deck (eff null, capacity 0, bookTsAt = now) — otherwise an already-
// cached row would keep serving stale eff prices on the shared Market row (deck/feed/fallback pool)
// until the display-staleness bound. Unevaluated rows (missing token ids, CLOB outage) are left
// untouched: unproven is not untradable.
import { PrismaClient } from "@prisma/client";
import { fetchMajorsMarkets, fetchSportsMarkets, type MarketCache } from "../src/lib/polymarket";
import { parseStrikeMarket, type HedgeAsset } from "../src/lib/hedge/parse";
import { S2_SIDE_FLOOR_BP, S2_SIDE_CEIL_BP } from "../src/lib/config";
import { evalMarketDepthBatch, type MarketDepth } from "../src/lib/depth";

const prisma = new PrismaClient();

// Gamma tag ids for the majors (verified live 2026-07-17 via /tags/slug/<slug>).
const MAJOR_TAGS: { slug: string; tagId: number; asset: HedgeAsset }[] = [
  { slug: "bitcoin", tagId: 235, asset: "BTC" },
  { slug: "ethereum", tagId: 39, asset: "ETH" },
  { slug: "solana", tagId: 818, asset: "SOL" },
];

// league label -> stable grouping slug ("Dota 2" -> "dota-2", "NBA" -> "nba").
// USD → cents for the RANKING columns only, saturated at the INT4 ceiling. Unclamped, a big
// BTC/ETH strike market — exactly this indexer's universe — writes past 2_147_483_647 cents
// ($21,474,836.47), Prisma throws a fit error, and because the majors loop has no per-item catch
// the whole run dies; the same market reappears next run, so the indexer fails from then on.
// Saturating keeps the only property these columns have: a $30M and a $25M market both rank top.
// ponytail: saturates above $21.47M, widen both columns to BigInt if the ordering ever matters up there.
function rankCents(usd: number | null | undefined): number | null {
  return usd == null ? null : Math.min(Math.round(usd * 100), 2_147_483_647);
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// The D10 columns persisted on every gated-in Market row: the CLOB token ids off the cache row plus
// the executable numbers from the depth eval. (Both refresh passes share this so the columns can't
// drift between create/update or S1/S2.)
function depthColumns(m: { yesTokenId: string | null; noTokenId: string | null }, d: MarketDepth) {
  return {
    yesTokenId: m.yesTokenId,
    noTokenId: m.noTokenId,
    yesEffPriceBp: d.yesEffPriceBp,
    noEffPriceBp: d.noEffPriceBp,
    yesMaxStakeCents: d.yesMaxStakeCents,
    noMaxStakeCents: d.noMaxStakeCents,
    bookTsAt: d.bookTsAtMs !== null ? new Date(d.bookTsAtMs) : null,
  };
}

export interface HedgeIndexStats {
  discovered: number;
  upserted: number;
  parsed: number; // strike+date+direction all machine-parsed (S1-eligible)
  skipped: number; // discovered but not parseable (e.g. Up/Down dailies with no strike)
  depthDropped: number; // parsed/band-passing but NOT tradable (thin/absent book) — dropped by D10
  depthStamped: number; // of those, already-cached rows stamped "read and untradable" (1b)
  byAsset: Record<string, { discovered: number; parsed: number; skipped: number }>;
  // S2 sports/esports index (life-event hedge).
  sports: {
    discovered: number; // NAMED sports/esports markets Gamma returned
    eligible: number; // within the S2 price band -> s2Eligible upserted
    clearedStale: number; // previously-eligible rows demoted this run (fell out of the fetch/band)
    byLeague: Record<string, number>; // eligible count per league label (or "(unknown)")
  };
}

// Shared upsert for BOTH refresh passes (S1 crypto + S2 sports). The two blocks were byte-identical
// copies of refresh-deck's upsert, and the fixes that landed there (no status on update, league
// backfill) reached neither copy; one function keeps them honest.
export async function upsertIndexedMarket(m: MarketCache, depth: MarketDepth): Promise<{ id: string }> {
  return prisma.market.upsert({
    where: { polymarketId: m.polymarketId },
    create: {
      polymarketId: m.polymarketId,
      question: m.question,
      category: m.category,
      league: m.league, // which sport / which game — from Gamma's tags, see MarketCache.league
      outcomeYesLabel: m.outcomeYesLabel,
      outcomeNoLabel: m.outcomeNoLabel,
      yesPriceBp: m.yesPriceBp,
      noPriceBp: m.noPriceBp,
      ...depthColumns(m, depth),
      startsAt: m.startsAt ? new Date(m.startsAt) : null,
      resolutionDeadline: new Date(m.resolutionDeadline),
      status: m.status,
    },
    update: {
      league: m.league, // backfills rows cached before tags were read
      outcomeYesLabel: m.outcomeYesLabel,
      outcomeNoLabel: m.outcomeNoLabel,
      yesPriceBp: m.yesPriceBp,
      noPriceBp: m.noPriceBp,
      ...depthColumns(m, depth),
      startsAt: m.startsAt ? new Date(m.startsAt) : null,
      resolutionDeadline: new Date(m.resolutionDeadline),
      // status is deliberately NOT written on update. Every fetcher feeding this script filters to
      // status === "OPEN", so this only ever wrote back "OPEN" — and writing it unconditionally
      // regresses a market the poller has already settled: a stale/lagging Gamma payload flips a
      // RESOLVED or CANCELED row back to OPEN while resolvedOutcome stays set, which breaks
      // planRedeem's terminal guard and re-admits a decided market to the deck. Terminal
      // transitions belong to the poller; create (above) still stamps the initial status.
      lastPolledAt: new Date(),
    },
    select: { id: true },
  });
}

export async function refreshHedgeIndex(): Promise<HedgeIndexStats> {
  const stats: HedgeIndexStats = {
    discovered: 0,
    upserted: 0,
    parsed: 0,
    skipped: 0,
    depthDropped: 0,
    depthStamped: 0,
    byAsset: {},
    sports: { discovered: 0, eligible: 0, clearedStale: 0, byLeague: {} },
  };
  // polymarketIds the depth gate EVALUATED this run and found untradable (both passes share it;
  // stamped once at the end). Null depth (missing token ids, CLOB outage) is NOT a rejection.
  const rejectedIds: string[] = [];

  for (const tag of MAJOR_TAGS) {
    const rows = await fetchMajorsMarkets(tag.tagId);
    const a = (stats.byAsset[tag.asset] ??= { discovered: 0, parsed: 0, skipped: 0 });
    // Depth-evaluate the whole tag batch up front — the micro-batch cache in clob.ts coalesces the
    // per-market book reads into a handful of union /books calls. Null = unquotable this run.
    const depths = await evalMarketDepthBatch(
      rows.map((r) => ({ key: r.cache.polymarketId, yesTokenId: r.cache.yesTokenId, noTokenId: r.cache.noTokenId })),
    );

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

      // D10 depth gate: both sides must fill STAKE_CENTS within the eligibility cap. A parsed
      // market whose book is a husk/thin shell is not a hedgeable instrument — drop it (counted
      // separately so parse coverage stays a pure parse metric). An EVALUATED untradable row is
      // also rejection-stamped below; an unevaluated one (null depth) is not.
      const depth = depths.get(m.polymarketId) ?? null;
      if (!depth || !depth.tradable) {
        stats.depthDropped++;
        if (depth) rejectedIds.push(m.polymarketId);
        continue;
      }

      // Upsert the base Market cache row (mirrors refresh-deck) so the poller can settle it.
      const market = await upsertIndexedMarket(m, depth);

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
        liquidityCents: rankCents(row.liquidityNum),
        volumeCents: rankCents(row.volumeNum),
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

  // ── S2 sports/esports pass (life-event hedge index) ────────────────────────────────────────────────
  // Discover upcoming NAMED sports/esports markets, keep the ones inside the S2 price band (a live/
  // decided price collapse is dropped; a pre-match favourite stays), and enrich MarketMeta so the
  // pickers + free-text matcher can turn them into AGAINST hedges. Same upsert idiom as the crypto pass.
  const sports = await fetchSportsMarkets();
  stats.sports.discovered = sports.length;
  const sportsDepths = await evalMarketDepthBatch(
    sports.map((s) => ({ key: s.cache.polymarketId, yesTokenId: s.cache.yesTokenId, noTokenId: s.cache.noTokenId })),
  );
  // Every market that PASSES the band this run stays/becomes s2Eligible; anything previously eligible
  // but NOT re-affirmed here (dropped from the Gamma fetch, or fell out of the price band because the
  // match started/decided) is demoted below (F2) so it can never surface in a picker/search/accept.
  // Rows the depth gate could NOT evaluate (CLOB outage) are tracked separately: they are neither
  // affirmed nor demoted — unproven is not untradable.
  const eligibleMarketIds: string[] = [];
  const unevaluatedPolymarketIds: string[] = [];
  for (const s of sports) {
    const m = s.cache;
    if (m.yesPriceBp == null || m.noPriceBp == null) continue;

    // D10 depth gate (same as the S1 pass): an S2 card's AGAINST side must be actually buyable.
    // Look the depth up BEFORE the band check so the band judges the executable price, not the mid.
    const depth = sportsDepths.get(m.polymarketId) ?? null;
    if (depth === null) {
      unevaluatedPolymarketIds.push(m.polymarketId);
      continue;
    }
    // Band-check on the eff VWAP (the price the accept path will honour); the mid is only the
    // stand-in when the book gave no executable number.
    const yesBandPriceBp = depth.yesEffPriceBp ?? m.yesPriceBp;
    const noBandPriceBp = depth.noEffPriceBp ?? m.noPriceBp;
    if (yesBandPriceBp < S2_SIDE_FLOOR_BP || yesBandPriceBp > S2_SIDE_CEIL_BP) continue;
    if (noBandPriceBp < S2_SIDE_FLOOR_BP || noBandPriceBp > S2_SIDE_CEIL_BP) continue;

    if (!depth.tradable) {
      stats.depthDropped++;
      rejectedIds.push(m.polymarketId);
      continue;
    }

    const leagueLabel = s.league;
    const leagueSlug = leagueLabel ? slugify(leagueLabel) : null;

    const market = await upsertIndexedMarket(m, depth);

    const meta = {
      s2Eligible: true,
      sportKind: s.category, // "sports" | "esports"
      leagueSlug,
      leagueLabel,
      eventSlug: s.eventSlug,
      eventTicker: s.eventTicker,
      series: s.seriesTitle,
      liquidityCents: rankCents(s.liquidityNum),
      volumeCents: rankCents(s.volumeNum),
      parsedDeadline: new Date(m.resolutionDeadline),
    };
    await prisma.marketMeta.upsert({
      where: { marketId: market.id },
      create: { marketId: market.id, ...meta },
      update: meta,
    });

    eligibleMarketIds.push(market.id);
    stats.sports.eligible++;
    const key = leagueLabel ?? "(unknown)";
    stats.sports.byLeague[key] = (stats.sports.byLeague[key] ?? 0) + 1;
  }

  // 1b rejection stamp (both passes): rows the gate EVALUATED and found untradable get eff null /
  // capacity 0 / bookTsAt now, so every eff-consuming surface (deck/feed routes, the S2 candidates
  // and fallback pool reads, all via authoritativePrices) drops them THIS run instead of after the
  // display-staleness bound. updateMany on purpose: absent rows have no stale state to clear.
  if (rejectedIds.length > 0) {
    const stamped = await prisma.market.updateMany({
      where: { polymarketId: { in: rejectedIds } },
      data: {
        yesEffPriceBp: null,
        noEffPriceBp: null,
        yesMaxStakeCents: 0,
        noMaxStakeCents: 0,
        bookTsAt: new Date(),
      },
    });
    stats.depthStamped = stamped.count;
  }

  // Demote every row that was s2Eligible but did NOT pass this run: a match that started/decided
  // (price collapsed out of band) or a market Gamma stopped returning. Clearing the flag is what
  // pulls it out of loadS2Candidates (pickers/search) AND deriveS2ForAccept — so a stale sports
  // market can no longer be suggested or accepted (F2). Rows the depth gate could not evaluate
  // (CLOB outage) keep whatever eligibility they had — unproven is not untradable, and demoting
  // the whole index on an outage would empty the pickers until the next good run. Only a market
  // that was evaluated, or that Gamma stopped returning, is demoted.
  if (sports.length > 0 && unevaluatedPolymarketIds.length === sports.length) {
    // Nothing could be evaluated this run — a CLOB outage. Skip the demotion entirely.
    stats.sports.clearedStale = 0;
    console.warn("[hedge-index] S2 clear-pass skipped: no depth read succeeded this run");
  } else {
    const cleared = await prisma.marketMeta.updateMany({
      where: {
        s2Eligible: true,
        marketId: { notIn: eligibleMarketIds },
        market: { polymarketId: { notIn: unevaluatedPolymarketIds } },
      },
      data: { s2Eligible: false },
    });
    stats.sports.clearedStale = cleared.count;
  }

  return stats;
}

// Run directly (not when imported by the poller/tests).
if (process.argv[1] && process.argv[1].endsWith("refresh-hedge-index.ts")) {
  refreshHedgeIndex()
    .then((s) => {
      const pct = s.discovered ? ((s.parsed / s.discovered) * 100).toFixed(1) : "0.0";
      console.log(`refresh-hedge-index [S1 crypto]: discovered=${s.discovered} upserted=${s.upserted} parsed=${s.parsed} skipped=${s.skipped} depthDropped=${s.depthDropped} depthStamped=${s.depthStamped} (coverage ${pct}%)`);
      for (const [asset, a] of Object.entries(s.byAsset)) {
        const apct = a.discovered ? ((a.parsed / a.discovered) * 100).toFixed(1) : "0.0";
        console.log(`  ${asset}: discovered=${a.discovered} parsed=${a.parsed} skipped=${a.skipped} (coverage ${apct}%)`);
      }
      const spct = s.sports.discovered ? ((s.sports.eligible / s.sports.discovered) * 100).toFixed(1) : "0.0";
      console.log(`refresh-hedge-index [S2 sports]: discovered=${s.sports.discovered} eligible=${s.sports.eligible} clearedStale=${s.sports.clearedStale} (coverage ${spct}%)`);
      for (const [league, n] of Object.entries(s.sports.byLeague).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${league}: ${n}`);
      }
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-hedge-index failed:", e);
      process.exit(1);
    });
}
