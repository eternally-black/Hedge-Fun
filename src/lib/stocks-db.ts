// DB glue for PAPER tokenized-stock positions (Stocklana). A stock lot is NOT a Bet: it never
// resolves, has no YES/NO, and its price is spot — so it lives in StockPosition, not Bet. But the
// MONEY model is identical to a swipe: a buy HOLDS stakeCents against Cash (VirtualBalance.lockedCents)
// via the same atomic conditional hold (holdCash), and a sell releases the hold and credits P&L to
// balanceCents — exactly the settle.ts release pattern (balance += pnl, hold released). requestId is
// the client idempotency key: a retried buy returns the SAME lot instead of double-spending.
//
// This module is the shared entry for a paper buy: the deck route calls buyStockPaper today; the
// hedge-accept packet calls openStockPosition inside its own transaction (so a hedge accept books a
// stock lot atomically with its telemetry).

import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { getPriceEntries, JupiterUnavailableError, type JupPriceEntry } from "./prices";
import { priceFieldsFrom, qtyBaseFor, valueCents } from "./stocks";
import { holdCash } from "./swipe";
import { STOCK_PRICE_MAX_STALE_MS, STOCK_TERMS_VERSION } from "./config";
import type {
  StockBuyResponse,
  StockSellResponse,
  StockPositionRow,
  StockTotals,
  StockPendingAttempt,
  StockPortfolioResponse,
} from "./api-types";

// Jupiter could not price the mint (transport failure, or the mint is absent/unpriced). Route -> 502
// price_unavailable — an outage, not an untradable asset, so the client may retry.
export class StockPriceUnavailableError extends Error {
  constructor(message = "price_unavailable") {
    super(message);
    this.name = "StockPriceUnavailableError";
  }
}

// The asset/lot can't be acted on. The MESSAGE IS THE CODE the route maps to a status:
//   asset_not_found | asset_halted | position_not_found | already_closed | stake_too_small | price_impact
export class StockUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockUnavailableError";
  }
}

// The live price of one mint, in integer cents per RAW token. Throws StockPriceUnavailableError when
// Jupiter is down OR the mint is unpriced (priceFieldsFrom -> null) — a buy must never book at a
// guessed price.
export async function liveStockPriceCents(mint: string): Promise<number> {
  let entries: Record<string, JupPriceEntry>;
  try {
    entries = await getPriceEntries([mint]);
  } catch (e) {
    if (e instanceof JupiterUnavailableError) throw new StockPriceUnavailableError();
    throw e;
  }
  const fields = priceFieldsFrom(entries[mint]);
  if (!fields) throw new StockPriceUnavailableError();
  return fields.priceCents;
}

// The caller's VERIFIED Solana addresses (a wallet that signed Privy's challenge). Same predicate as
// /api/real/withdraw's autofill: only a verified wallet may be a money destination, so only a
// verified wallet gates "Buy on Solana".
export async function verifiedWallets(userId: string): Promise<string[]> {
  const rows = await prisma.hedgeWallet.findMany({
    where: { userId, verifiedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { address: true },
  });
  return rows.map((r) => r.address);
}

// Has the user accepted the CURRENT xStocks terms? A versioned record, not a click — an old
// acceptance stops meaning the same thing once the text changes.
export function hasStockConsent(u: { stockConsentVersion: number | null }): boolean {
  return u.stockConsentVersion === STOCK_TERMS_VERSION;
}

// THE shared paper-buy entry. Computes the lot size, creates the StockPosition, then HOLDS the stake
// against Cash (atomic — throws InsufficientFundsError, rolling back the lot). Callers pass their own
// transaction so a hedge accept can book the lot atomically with its telemetry.
export async function openStockPosition(
  tx: Prisma.TransactionClient,
  p: {
    userId: string;
    assetId: string;
    source: "DECK" | "HEDGE";
    stakeCents: number;
    priceCents: number;
    decimals: number;
    requestId?: string;
    hedgeSuggestionId?: string;
  },
): Promise<{ id: string; qtyBase: bigint }> {
  const qtyBase = qtyBaseFor(p.stakeCents, p.priceCents, p.decimals);
  if (qtyBase <= 0n) throw new StockUnavailableError("stake_too_small");
  const lot = await tx.stockPosition.create({
    data: {
      userId: p.userId,
      assetId: p.assetId,
      mode: "PAPER",
      source: p.source,
      requestId: p.requestId,
      hedgeSuggestionId: p.hedgeSuggestionId,
      qtyBase,
      costCents: p.stakeCents,
      entryPriceCents: p.priceCents,
    },
    select: { id: true },
  });
  await holdCash(tx, p.userId, p.stakeCents);
  return { id: lot.id, qtyBase };
}

type LotSummary = { id: string; userId: string; qtyBase: bigint; costCents: number; entryPriceCents: number };

function replay(lot: LotSummary): StockBuyResponse {
  return {
    positionId: lot.id,
    qtyBase: String(lot.qtyBase),
    priceCents: lot.entryPriceCents,
    costCents: lot.costCents,
    alreadyBought: true,
  };
}

const LOT_SELECT = { id: true, userId: true, qtyBase: true, costCents: true, entryPriceCents: true } as const;

async function priorLot(userId: string, opts: { requestId?: string; hedgeSuggestionId?: string }): Promise<LotSummary | null> {
  if (opts.requestId) {
    const prior = await prisma.stockPosition.findUnique({ where: { requestId: opts.requestId }, select: LOT_SELECT });
    if (prior && prior.userId === userId) return prior;
  }
  if (opts.hedgeSuggestionId) {
    const prior = await prisma.stockPosition.findUnique({
      where: { userId_hedgeSuggestionId: { userId, hedgeSuggestionId: opts.hedgeSuggestionId } },
      select: LOT_SELECT,
    });
    if (prior) return prior;
  }
  return null;
}

// PAPER buy. Idempotent by requestId (client uuid) and by hedgeSuggestionId (a hedge accept). Locks
// the LIVE price server-side, holds the stake against Cash. Returns the lot (alreadyBought:true on a
// replay).
export async function buyStockPaper(
  userId: string,
  assetId: string,
  stakeCents: number,
  source: "DECK" | "HEDGE" = "DECK",
  opts: { requestId?: string; hedgeSuggestionId?: string } = {},
): Promise<StockBuyResponse> {
  // 1) Idempotency fast path — a retried buy returns the SAME lot, never a second one.
  const prior = await priorLot(userId, opts);
  if (prior) return replay(prior);

  // 2) Asset must exist and be tradable.
  const asset = await prisma.stockAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new StockUnavailableError("asset_not_found");
  if (asset.halted) throw new StockUnavailableError("asset_halted");

  // 3) Live price — never book at a stale/guessed number.
  const priceCents = await liveStockPriceCents(asset.mint);

  // 4) Atomic lot + hold. Serializable so two concurrent buys can't both pass the Cash guard.
  try {
    const { id, qtyBase } = await prisma.$transaction((tx) =>
      openStockPosition(tx, {
        userId,
        assetId,
        source,
        stakeCents,
        priceCents,
        decimals: asset.decimals,
        requestId: opts.requestId,
        hedgeSuggestionId: opts.hedgeSuggestionId,
      }),
    );
    return { positionId: id, qtyBase: String(qtyBase), priceCents, costCents: stakeCents, alreadyBought: false };
  } catch (e) {
    // P2002 on requestId or userId_hedgeSuggestionId: a concurrent buy of the same key won the race.
    // Re-read the existing lot and return it as an idempotent replay.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await priorLot(userId, opts);
      if (existing) return replay(existing);
    }
    throw e;
  }
}

// PAPER sell. Closes the lot at the LIVE price, credits P&L to balanceCents and releases the hold —
// the settle.ts release pattern (balance += pnl, locked -= cost). Idempotent by the closedAt guard:
// a second sell of the same lot -> already_closed.
export async function sellStockPaper(userId: string, positionId: string): Promise<StockSellResponse> {
  const lot = await prisma.stockPosition.findFirst({
    where: { id: positionId, userId, mode: "PAPER" },
    include: { asset: true },
  });
  if (!lot) throw new StockUnavailableError("position_not_found");
  if (lot.closedAt) throw new StockUnavailableError("already_closed");

  const priceCents = await liveStockPriceCents(lot.asset.mint);
  const proceedsCents = valueCents(lot.qtyBase, priceCents, lot.asset.decimals);
  const pnlCents = proceedsCents - lot.costCents;

  await prisma.$transaction(async (tx) => {
    // Conditional close: only the FIRST sell flips closedAt. A concurrent second sell updates 0 rows.
    const closed = await tx.stockPosition.updateMany({
      where: { id: positionId, closedAt: null },
      data: { closedAt: new Date(), closeReason: "sold", proceedsCents, pnlCents },
    });
    if (closed.count === 0) throw new StockUnavailableError("already_closed");
    // Release the hold and credit P&L: balance += pnl, locked -= cost (the settle.ts pattern).
    await tx.virtualBalance.update({
      where: { userId },
      data: { balanceCents: { increment: pnlCents }, lockedCents: { decrement: lot.costCents } },
    });
  });

  return { positionId, proceedsCents, pnlCents, priceCents };
}

// Swipe-left: never deal this asset to this user again. Idempotent (upsert).
export async function passStock(userId: string, assetId: string): Promise<void> {
  const asset = await prisma.stockAsset.findUnique({ where: { id: assetId }, select: { id: true } });
  if (!asset) throw new StockUnavailableError("asset_not_found");
  await prisma.stockPass.upsert({
    where: { userId_assetId: { userId, assetId } },
    create: { userId, assetId },
    update: {},
  });
}

// One portfolio row. OPEN lots price off the STORED asset price (refreshed every poller tick) — null
// when the asset is unpriced; `fresh` is false when that price is older than the staleness bound.
// CLOSED lots carry their realized proceeds/pnl instead.
export function positionRow(
  p: Prisma.StockPositionGetPayload<{ include: { asset: true } }>,
  nowMs: number,
): StockPositionRow {
  const a = p.asset;
  const fresh = a.pricedAt != null && nowMs - a.pricedAt.getTime() <= STOCK_PRICE_MAX_STALE_MS;
  const open = p.closedAt == null;
  const priceCents = open ? a.priceCents : null;
  const valueCentsOpen = open && a.priceCents != null ? valueCents(p.qtyBase, a.priceCents, a.decimals) : null;
  const pnlCentsOpen = valueCentsOpen != null ? valueCentsOpen - p.costCents : null;
  return {
    id: p.id,
    assetId: p.assetId,
    symbol: a.symbol,
    name: a.name,
    logoUrl: a.logoUrl,
    mode: p.mode,
    source: p.source === "HEDGE" ? "HEDGE" : "DECK",
    qtyBase: String(p.qtyBase),
    decimals: a.decimals,
    uiMultiplierMicro: a.uiMultiplierMicro,
    costCents: p.costCents,
    entryPriceCents: p.entryPriceCents,
    priceCents,
    valueCents: open ? valueCentsOpen : (p.proceedsCents ?? null),
    pnlCents: open ? pnlCentsOpen : (p.pnlCents ?? null),
    fresh,
    txSig: p.txSig,
    payer: p.payer,
    createdAt: p.createdAt.toISOString(),
    closedAt: p.closedAt?.toISOString() ?? null,
    closeReason: p.closeReason,
    proceedsCents: p.proceedsCents,
  };
}

// The portfolio: open lots + the last 30 closed, both modes, plus totals over OPEN lots only (value
// falls back to cost when unpriced, so a total never reads as a loss just because a price is missing).
export async function portfolioFor(user: { id: string; stockConsentVersion: number | null }): Promise<StockPortfolioResponse> {
  const userId = user.id;
  const nowMs = Date.now();
  const [openLots, closedLots, wallets, attempts] = await Promise.all([
    prisma.stockPosition.findMany({
      where: { userId, closedAt: null },
      include: { asset: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.stockPosition.findMany({
      where: { userId, closedAt: { not: null } },
      include: { asset: true },
      orderBy: { closedAt: "desc" },
      take: 30,
    }),
    verifiedWallets(userId),
    prisma.stockBuyAttempt.findMany({
      where: { userId, status: "PENDING" },
      include: { asset: { select: { symbol: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  const open = openLots.map((p) => positionRow(p, nowMs));
  const closed = closedLots.map((p) => positionRow(p, nowMs));

  const totalsFor = (mode: "PAPER" | "REAL"): StockTotals => {
    let costCents = 0;
    let valueCentsSum = 0;
    let pnlCentsSum = 0;
    for (const p of openLots) {
      if (p.mode !== mode) continue;
      costCents += p.costCents;
      const v = p.asset.priceCents != null ? valueCents(p.qtyBase, p.asset.priceCents, p.asset.decimals) : p.costCents;
      valueCentsSum += v;
      pnlCentsSum += v - p.costCents;
    }
    return { costCents, valueCents: valueCentsSum, pnlCents: pnlCentsSum };
  };

  const pendingAttempts: StockPendingAttempt[] = attempts.map((a) => ({
    id: a.id,
    symbol: a.asset.symbol,
    stakeCents: a.stakeCents,
    status: a.status,
    sig: a.sig,
    createdAt: a.createdAt.toISOString(),
  }));

  return {
    open,
    closed,
    totals: { paper: totalsFor("PAPER"), real: totalsFor("REAL") },
    wallets,
    stockConsent: hasStockConsent(user),
    pendingAttempts,
  };
}
