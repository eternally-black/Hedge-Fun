// Stock profit alerts — the evaluator behind the results inbox. A tier fires ONCE per lot: the
// conditional updateMany IS the idempotency (alertTierBp < tier), so a poller restart, a double
// tick or two runners cannot re-fire a tier. Pure decision (alertTierBp) + one DB sweep
// (evalStockAlerts) so the arithmetic is testable without a database.
import type { PrismaClient } from "@prisma/client";
import {
  STOCK_ALERT_TIERS_BP,
  STOCK_ALERT_MIN_PNL_CENTS,
  STOCK_ALERT_PRICE_MAX_STALE_MS,
  STOCK_ALERT_SCAN_MAX,
  STOCK_ALERT_FIRE_MAX_PER_TICK,
  STOCK_WALLET_RECONCILE_MAX_AGE_MS,
} from "./config";
import { readSweepCursor, writeSweepCursor } from "./sweep-cursor";

export interface AlertInput {
  pnlCents: number;
  costCents: number;
  currentTierBp: number;
  pricedAt: Date | null;
  halted: boolean;
  walletCheckedAt: Date | null;
  mode: "PAPER" | "REAL";
  now: Date;
  tiers?: readonly number[];
}

// PURE. The tier this lot should be at right now, or 0 for "nothing to fire". 0 is returned for
// every reason NOT to alert — a halted asset, a price nobody refreshed, a REAL lot the wallet may
// no longer back, a cost basis we cannot divide by, and a gain too small to be news. The caller
// only ever sees "fire this tier" or "do nothing", so the reasons stay here.
export function alertTierBp(i: AlertInput): number {
  if (i.halted) return 0;
  if (i.pricedAt === null) return 0;
  if (i.now.getTime() - i.pricedAt.getTime() > STOCK_ALERT_PRICE_MAX_STALE_MS) return 0;
  // A REAL lot is only evaluated while the wallet reconciliation is recent: a lot the wallet may no
  // longer back (sold in Phantom, moved out) must not alert on a price we can no longer claim.
  if (i.mode === "REAL") {
    if (i.walletCheckedAt === null) return 0;
    if (i.now.getTime() - i.walletCheckedAt.getTime() > STOCK_WALLET_RECONCILE_MAX_AGE_MS) return 0;
  }
  if (i.costCents <= 0) return 0;
  if (i.pnlCents < STOCK_ALERT_MIN_PNL_CENTS) return 0;
  const pnlBp = Math.floor((i.pnlCents * 10_000) / i.costCents);
  const tiers = i.tiers ?? STOCK_ALERT_TIERS_BP;
  let tier = 0;
  for (const t of tiers) {
    if (pnlBp >= t && t > tier) tier = t;
  }
  // Monotonic: a tier already fired is never re-fired, and a lower tier never replaces a higher one.
  return tier > i.currentTierBp ? tier : 0;
}

// Injected so tests can fake P&L without a price feed. Production passes livePnlCents.
export type PnlFn = (
  p: { qtyBase: bigint; costCents: number },
  a: { priceCents: number; decimals: number },
) => number;

export interface AlertSweep {
  scanned: number;
  fired: number;
  skipped: number;
  errors: number;
}

// One pass over the open lots. Bounded by STOCK_ALERT_SCAN_MAX (scan) and
// STOCK_ALERT_FIRE_MAX_PER_TICK (fire) — the rest wait one tick. A per-lot failure is counted, not
// thrown: one bad row must not stop the sweep.
export async function evalStockAlerts(
  prisma: PrismaClient,
  pnl: PnlFn,
  now = new Date(),
): Promise<AlertSweep> {
  const cursorName = "stock-alerts";
  let cursor = await readSweepCursor(prisma, cursorName);
  const read = (after: typeof cursor) =>
    prisma.stockPosition.findMany({
      where: {
        closedAt: null,
        ...(after
          ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }
          : {}),
      },
      include: { asset: true },
      orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
      take: STOCK_ALERT_SCAN_MAX,
    });
  let positions = await read(cursor);
  if (positions.length === 0 && cursor) {
    await writeSweepCursor(prisma, cursorName, null);
    cursor = null;
    positions = await read(null);
  }
  if (positions.length === 0) return { scanned: 0, fired: 0, skipped: 0, errors: 0 };
  let scanned = 0;
  let fired = 0;
  let skipped = 0;
  let errors = 0;
  for (const p of positions) {
    scanned++;
    const a = p.asset;
    if (a.priceCents === null) {
      skipped++;
      continue;
    }
    const tier = alertTierBp({
      pnlCents: pnl(p, { priceCents: a.priceCents, decimals: a.decimals }),
      costCents: p.costCents,
      currentTierBp: p.alertTierBp,
      pricedAt: a.pricedAt,
      halted: a.halted,
      walletCheckedAt: p.walletCheckedAt,
      mode: p.mode,
      now,
    });
    if (!tier) continue;
    if (fired >= STOCK_ALERT_FIRE_MAX_PER_TICK) continue;
    try {
      const { count } = await prisma.stockPosition.updateMany({
        where: { id: p.id, closedAt: null, alertTierBp: { lt: tier } },
        data: { alertTierBp: tier, alertedAt: now, alertSeenAt: null },
      });
      fired += count;
    } catch (e) {
      errors++;
      console.warn("[stock-alerts] lot failed:", (e as Error).message);
    }
  }
  const last = positions[positions.length - 1];
  await writeSweepCursor(prisma, cursorName, { createdAt: last.createdAt, id: last.id });
  return { scanned, fired, skipped, errors };
}
