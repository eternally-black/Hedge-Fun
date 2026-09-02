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

// In-process single-flight for the rebuild half (F15): N concurrent callers past the TTL would each
// duplicate the Helius + Jupiter (+ Birdeye) round-trip; coalescing them onto one in-flight rebuild
// per address kills the stampede (the Birdeye sub-call is already single-flighted internally). Same
// process-local caveat as the Birdeye guard: correct for the single-container deploy, but under a
// MULTI-INSTANCE deploy each container keeps its own map, so cross-instance duplication can still
// happen — acceptable (a few extra rebuilds), and the WalletSnapshot upsert is the shared source of
// truth either way. A `force` rebuild bypasses the coalescing (it must read truly fresh upstream).
const rebuildInFlight = new Map<string, Promise<SnapshotData>>();

// Return the cached snapshot when fresh (within TTL), else rebuild it. `force` bypasses the TTL.
export async function getSnapshot(address: string, opts: { force?: boolean } = {}): Promise<SnapshotData> {
  const now = Date.now();
  const existing = await prisma.walletSnapshot.findUnique({ where: { address } });

  if (existing && !opts.force && now - existing.fetchedAt.getTime() < WALLET_SNAPSHOT_TTL_MS) {
    return rowToData(existing);
  }

  // Coalesce concurrent non-forced rebuilds for this address onto a single in-flight promise.
  if (!opts.force) {
    const flight = rebuildInFlight.get(address);
    if (flight) return flight;
  }

  const p = rebuildSnapshot(address, existing, now);
  if (!opts.force) {
    rebuildInFlight.set(address, p);
    // Clear the slot once settled (success OR failure) so the next stale read rebuilds afresh.
    // then(clear, clear), NOT `void p.finally(clear)`: .finally() returns a NEW promise that rejects
    // whenever p rejects, and with nobody awaiting that one a Helius/Jupiter outage was an unhandled
    // rejection — the route answered its 502 and the process died with it (caught by
    // scripts/test-hedge-wallet-verified.ts, which links a wallet with no exposure upstream).
    const clear = () => {
      if (rebuildInFlight.get(address) === p) rebuildInFlight.delete(address);
    };
    void p.then(clear, clear);
  }
  return p;
}

// The actual rebuild: Helius balances × Jupiter prices (+ Birdeye avg-cost when its own half is stale),
// then upsert. Extracted so getSnapshot can single-flight it. Throwing here propagates to the route -> 502.
async function rebuildSnapshot(
  address: string,
  existing: { avgCost: Prisma.JsonValue | null; pnlFetchedAt: Date | null } | null,
  now: number,
): Promise<SnapshotData> {
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
