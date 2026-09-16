// Populate/refresh the StockAsset cache from the xStocks catalog + Jupiter prices so the stock deck
// reads the DB, not the live APIs per request. Run: npm run refresh-stocks (the poller calls both
// halves each tick — prices for the served subset, the full catalog every 5th tick).
//
// Two deliberately separate passes, because they have wildly different costs:
//  • refreshStockCatalog — ~9 paginated xStocks pages + a Jupiter read for ALL ~800 mints. Heavy,
//    so it runs on the poller's slow cadence and is the ONLY place deck eligibility is re-ranked.
//  • refreshStockPrices — Jupiter for the SERVED subset only (deck-eligible ∪ open positions ∪ the
//    hedge tables' tickers), ≤ 3 requests. Cheap enough for every tick, which is what keeps the
//    STOCK_PRICE_MAX_STALE_MS / HEDGE_STOCK_PRICE_MAX_AGE_MS gates from firing on a live deck.
//
// The catalog upsert NEVER touches price fields or pricedAt: a catalog refresh that also blanked
// prices would make every card stale for a tick, and pricedAt is the staleness anchor the serve
// paths gate on — only a successful Jupiter read may move it.
import { PrismaClient } from "@prisma/client";
import { getPriceEntries } from "../src/lib/prices";
import { xstockToAsset, priceFieldsFrom, isDeckEligible, deckRank, type XStockNode } from "../src/lib/stocks";
import { STOCK_DECK_POOL } from "../src/lib/config";
import { STOCK_RULES, WALLET_STOCK_RULES } from "../src/lib/hedge/stock-rules";
import { deadlineLeftMs, boundedTimeoutMs } from "../src/lib/deadline";

const prisma = new PrismaClient();

const XSTOCKS_BASE = process.env.XSTOCKS_API_BASE || "https://api.xstocks.fi/api/v2";
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // ~9 pages today; the cap is a runaway guard, not a target
const TIMEOUT_MS = 10_000;

// Page through the public xStocks catalog until the API says there is no next page (or MAX_PAGES).
// Network must be capitalised "Solana" — the API validates the enum and rejects a lowercase value.
export async function fetchXStocksCatalog(): Promise<XStockNode[]> {
  const nodes: XStockNode[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const left = deadlineLeftMs();
    if (left !== undefined && left <= 0) throw new Error("xStocks time budget exhausted");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), boundedTimeoutMs(TIMEOUT_MS));
    let json: { nodes?: XStockNode[]; page?: { hasNextPage?: boolean } };
    try {
      const res = await fetch(
        `${XSTOCKS_BASE}/public/assets?network=Solana&pageSize=${PAGE_SIZE}&page=${page}`,
        { cache: "no-store", headers: { accept: "application/json" }, signal: ctrl.signal },
      );
      if (!res.ok) throw new Error(`xstocks ${res.status}`);
      json = (await res.json()) as typeof json;
    } finally {
      clearTimeout(t);
    }
    for (const n of json.nodes ?? []) if (n) nodes.push(n);
    if (!json.page?.hasNextPage) break;
  }
  return nodes;
}

export interface CatalogResult {
  assets: number;
  priced: number;
  eligible: number;
}

// Full refresh: catalog upsert -> price every mint -> re-rank deck eligibility. The poller's slow
// pass; the direct-run entry point.
export async function refreshStockCatalog(): Promise<CatalogResult> {
  const nodes = await fetchXStocksCatalog();
  const assets = nodes.map(xstockToAsset).filter((a): a is NonNullable<typeof a> => a !== null);
  for (const a of assets) {
    await prisma.stockAsset.upsert({
      where: { mint: a.mint },
      create: {
        mint: a.mint,
        symbol: a.symbol,
        name: a.name,
        underlying: a.underlying,
        logoUrl: a.logoUrl,
        halted: a.halted,
        tradingHours: a.tradingHours,
        openNow: a.openNow,
      },
      // Catalog fields only. priceCents/change24hBp/liquidityCents/decimals/uiMultiplierMicro and
      // pricedAt belong to the Jupiter pass — writing them here would blank a live card's price on
      // every catalog tick and reset the staleness anchor without a real read behind it.
      update: {
        symbol: a.symbol,
        name: a.name,
        underlying: a.underlying,
        logoUrl: a.logoUrl,
        halted: a.halted,
        tradingHours: a.tradingHours,
        openNow: a.openNow,
      },
    });
  }
  const priced = await priceAssets(assets.map((a) => a.mint));

  // Eligibility is a RANKING, not a per-row predicate: the deck draws from the top STOCK_DECK_POOL
  // (liquidity desc, then market cap desc — deckRank), so a name can be pushed out by a deeper or
  // bigger one. Two updateMany calls (set the winners, clear everyone else) keep the flag exactly
  // equal to the current top-N — a per-row write would leave yesterday's winners flagged after a re-rank.
  const rows = await prisma.stockAsset.findMany({
    select: { id: true, halted: true, priceCents: true, liquidityCents: true, mcapMillions: true },
  });
  const eligible = rows
    .filter(isDeckEligible)
    .sort(deckRank)
    .slice(0, STOCK_DECK_POOL)
    .map((r) => r.id);
  await prisma.stockAsset.updateMany({ where: { id: { in: eligible } }, data: { deckEligible: true } });
  await prisma.stockAsset.updateMany({
    where: { id: { notIn: eligible }, deckEligible: true },
    data: { deckEligible: false },
  });
  return { assets: assets.length, priced, eligible: eligible.length };
}

// The per-tick price pass: the SERVED subset only. Three groups, one query:
//  • deckEligible — what the deck can actually deal right now.
//  • open positions — a user's holding must be priced even if the asset fell out of the pool, or
//    their P&L freezes at the last catalog tick.
//  • hedge tickers — the rules' preferred symbols and trigger symbols, plus the wallet rules'
//    tickers: a spotted card fires off change24hBp, so those assets must stay fresh even when
//    they are not deck-eligible.
export async function refreshStockPrices(): Promise<{ priced: number; requested: number }> {
  const tickers = new Set<string>();
  for (const r of STOCK_RULES) {
    for (const t of r.tickers) tickers.add(t);
    if (r.trigger) tickers.add(r.trigger.symbol);
  }
  for (const r of WALLET_STOCK_RULES) for (const t of r.tickers) tickers.add(t);

  const openPositions = await prisma.stockPosition.findMany({
    where: { closedAt: null },
    distinct: ["assetId"],
    select: { assetId: true },
  });
  const rows = await prisma.stockAsset.findMany({
    where: {
      OR: [
        { deckEligible: true },
        { id: { in: openPositions.map((p) => p.assetId) } },
        { symbol: { in: [...tickers] } },
      ],
    },
    select: { id: true, mint: true },
  });
  const priced = await priceAssets(rows.map((r) => r.mint));
  return { priced, requested: rows.length };
}

// Write Jupiter's numbers for the mints it priced. A mint Jupiter does not price is SKIPPED — its
// pricedAt stays where it was, so the staleness gates keep treating it as old and the serve paths
// drop it. Writing a null price here would be worse than skipping: it would look like a fresh read
// of an unpriced asset.
async function priceAssets(mints: string[]): Promise<number> {
  if (mints.length === 0) return 0;
  const entries = await getPriceEntries(mints);
  const now = new Date();
  let updated = 0;
  // Bounded concurrency: ~800 updates one-by-one is a minute of round trips on the catalog tick.
  // 8 is enough to hide the latency without opening a pool of connections the DB has to queue.
  const queue = [...mints];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length) {
      const mint = queue.shift()!;
      const fields = priceFieldsFrom(entries[mint]);
      if (!fields) continue;
      await prisma.stockAsset.update({
        where: { mint },
        data: { ...fields, pricedAt: now },
      });
      updated++;
    }
  });
  await Promise.all(workers);
  return updated;
}

// Run directly (not when imported by the poller).
if (process.argv[1] && process.argv[1].endsWith("refresh-stocks.ts")) {
  refreshStockCatalog()
    .then((r) => {
      console.log(`refresh-stocks: ${r.assets} assets, ${r.priced} priced, ${r.eligible} deck-eligible`);
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-stocks failed:", e);
      process.exit(1);
    });
}
