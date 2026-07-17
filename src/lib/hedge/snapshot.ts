// WalletSnapshot builder/reader — the TTL cache that keeps the beta-capped Birdeye call (D4) OFF the
// per-request path. A snapshot fresh within WALLET_SNAPSHOT_TTL_MS is returned with ZERO external
// calls. On a rebuild we fetch balances (Helius) × prices (Jupiter) and, ONLY when the pnl half is
// also stale, one Birdeye avg-cost call (single-flight). Helius/Jupiter failure propagates (no
// exposure => no suggestion); Birdeye failure degrades to null avg-cost (card still renders).

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { getWalletBalances } from "../helius";
import { getPrices } from "../prices";
import { getWalletAvgCost, type AvgCostMap } from "../birdeye";
import { exposureFromBalances, WSOL_MINT, type ExposureResult } from "./exposure";
import { WALLET_SNAPSHOT_TTL_MS, WALLET_PNL_TTL_MS } from "../config";

export interface SnapshotData {
  address: string;
  exposure: ExposureResult;
  avgCost: AvgCostMap | null; // per-mint cents; null => Birdeye unavailable (no narratives)
  totalNotionalCents: number;
  fetchedAt: Date;
  pnlAvailable: boolean;
}

function rowToData(row: {
  address: string;
  exposure: Prisma.JsonValue;
  avgCost: Prisma.JsonValue | null;
  totalNotionalCents: number;
  fetchedAt: Date;
}): SnapshotData {
  const avgCost = (row.avgCost as AvgCostMap | null) ?? null;
  return {
    address: row.address,
    exposure: row.exposure as unknown as ExposureResult,
    avgCost,
    totalNotionalCents: row.totalNotionalCents,
    fetchedAt: row.fetchedAt,
    pnlAvailable: avgCost !== null,
  };
}

// Read the cached snapshot WITHOUT any external calls (null if never built). /accept uses this so a
// re-derivation is fast + deterministic against whatever snapshot produced the suggestion.
export async function getCachedSnapshot(address: string): Promise<SnapshotData | null> {
  const row = await prisma.walletSnapshot.findUnique({ where: { address } });
  return row ? rowToData(row) : null;
}

// Return the cached snapshot when fresh (within TTL), else rebuild it. `force` bypasses the TTL.
export async function getSnapshot(address: string, opts: { force?: boolean } = {}): Promise<SnapshotData> {
  const now = Date.now();
  const existing = await prisma.walletSnapshot.findUnique({ where: { address } });

  if (existing && !opts.force && now - existing.fetchedAt.getTime() < WALLET_SNAPSHOT_TTL_MS) {
    return rowToData(existing);
  }

  // Rebuild exposure (Helius + Jupiter). Throwing here propagates to the route -> 502.
  const balances = await getWalletBalances(address);
  const mints = [WSOL_MINT, ...balances.map((b) => b.mint).filter((m): m is string => m !== null)];
  const prices = await getPrices(mints);
  const exposure = exposureFromBalances(balances, prices);

  // Refresh the Birdeye avg-cost half ONLY when it is also stale (respects the 5 rps / 75 rpm cap).
  let avgCost: AvgCostMap | null = (existing?.avgCost as AvgCostMap | null) ?? null;
  let pnlFetchedAt: Date | null = existing?.pnlFetchedAt ?? null;
  const pnlStale = !pnlFetchedAt || now - pnlFetchedAt.getTime() >= WALLET_PNL_TTL_MS;
  if (pnlStale) {
    const fresh = await getWalletAvgCost(address); // null on failure/cap/keyless -> keep prior avgCost
    if (fresh !== null) {
      avgCost = fresh;
      pnlFetchedAt = new Date();
    }
  }

  const exposureJson = exposure as unknown as Prisma.InputJsonValue;
  const avgCostJson: Prisma.InputJsonValue | typeof Prisma.DbNull =
    avgCost === null ? Prisma.DbNull : (avgCost as Prisma.InputJsonValue);

  const saved = await prisma.walletSnapshot.upsert({
    where: { address },
    create: {
      address,
      exposure: exposureJson,
      avgCost: avgCostJson,
      totalNotionalCents: exposure.totalNotionalCents,
      fetchedAt: new Date(),
      pnlFetchedAt,
    },
    update: {
      exposure: exposureJson,
      avgCost: avgCostJson,
      totalNotionalCents: exposure.totalNotionalCents,
      fetchedAt: new Date(),
      pnlFetchedAt,
    },
  });

  return rowToData(saved);
}
