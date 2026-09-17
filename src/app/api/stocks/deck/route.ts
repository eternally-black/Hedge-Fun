import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { shuffleNoRun } from "@/lib/deck-mix";
import { STOCK_DECK_POOL, STOCK_DECK_SIZE, STOCK_MIN_LIQUIDITY_CENTS, STOCK_PRICE_MAX_STALE_MS } from "@/lib/config";
import { effectiveRealMode } from "@/lib/real";
import { verifiedWallets, hasStockConsent } from "@/lib/stocks-db";
import { isTradable } from "@/lib/stocks";
import { sponsorConfigured } from "@/lib/sponsor";
import type { StockDeckResponse, StockDeckCard } from "@/lib/api-types";

// The tokenized-stock deck: deck-eligible assets with a FRESH price, minus the caller's open lots and
// passes, shuffled. `wallets` is the verified payer list a real buy picks from; `stockConsent` gates
// the xStocks terms.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-deck:${user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // The deck is dealt for ONE economy. In REAL mode every card is there to be bought on chain, so an
  // asset with no Solana pool is not dealt at all (same predicate as isTradable, as a where clause);
  // in PAPER mode it is dealt like any other and bought with play money.
  const realOnly = effectiveRealMode(user) === "REAL";
  const rows = await prisma.stockAsset.findMany({
    where: {
      deckEligible: true,
      pricedAt: { gt: new Date(Date.now() - STOCK_PRICE_MAX_STALE_MS) },
      ...(realOnly ? { halted: false, liquidityCents: { gte: STOCK_MIN_LIQUIDITY_CENTS } } : {}),
      positions: { none: { userId: user.id, closedAt: null } },
      passes: { none: { userId: user.id } },
    },
    orderBy: [{ liquidityCents: { sort: "desc", nulls: "last" } }, { mcapMillions: { sort: "desc", nulls: "last" } }],
    take: STOCK_DECK_POOL,
  });

  const mixed = shuffleNoRun(rows, () => "stock", STOCK_DECK_SIZE, Date.now() & 0x7fffffff);
  const cards: StockDeckCard[] = mixed.map((a) => ({
    id: a.id,
    symbol: a.symbol,
    name: a.name,
    underlying: a.underlying,
    blurb: a.blurb,
    logoUrl: a.logoUrl,
    mint: a.mint,
    priceCents: a.priceCents ?? 0,
    change24hBp: a.change24hBp,
    uiMultiplierMicro: a.uiMultiplierMicro,
    tradingHours: a.tradingHours,
    openNow: a.openNow,
    tradable: isTradable(a),
    pricedAt: (a.pricedAt ?? a.updatedAt).toISOString(),
  }));

  const body: StockDeckResponse = {
    // A sponsored server needs no SOL from the buyer — the card can say "buy with USDC only".
    sponsored: sponsorConfigured(),
    cards,
    wallets: await verifiedWallets(user.id),
    stockConsent: hasStockConsent(user),
  };
  return NextResponse.json(body);
}
