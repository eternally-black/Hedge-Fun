import { Prisma, type PrismaClient } from "@prisma/client";
import {
  STOCK_WALLET_RECONCILE_MAX_AGE_MS,
  STOCK_WALLET_REFRESH_BUDGET_MS,
  STOCK_WALLET_REFRESH_LEASE_MS,
  STOCK_WALLET_REFRESH_MAX_PER_TICK,
} from "./config";
import { refreshWalletHoldings, type WalletRefreshResult } from "./stocks-real";
import { readSweepCursor, writeSweepCursor } from "./sweep-cursor";
import { claimWalletRefreshLease, releaseWalletRefreshLease } from "./wallet-sync";

const CURSOR = "stock-wallet-refresh";

type Candidate = { userId: string; payer: string; createdAt: Date };

export async function refreshStaleStockWallets(
  prisma: PrismaClient,
  now = new Date(),
  refresh: (userId: string, payer: string, now: Date) => Promise<WalletRefreshResult> = refreshWalletHoldings,
): Promise<{ scanned: number; refreshed: number; errors: number }> {
  const cursor = await readSweepCursor(prisma, CURSOR);
  const staleBefore = new Date(now.getTime() - STOCK_WALLET_RECONCILE_MAX_AGE_MS);
  const afterId = cursor?.id ?? "";
  const afterCreatedAt = cursor?.createdAt ?? new Date(0);
  const candidates = await prisma.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT s."userId", s."payer", s."createdAt"
    FROM "stock_wallet_states" s
    WHERE (s."lastCheckedAt" IS NULL OR s."lastCheckedAt" < ${staleBefore})
      AND (
        s."createdAt" > ${afterCreatedAt}
        OR (s."createdAt" = ${afterCreatedAt} AND (s."userId" || '|' || s."payer") > ${afterId})
      )
      AND EXISTS (
        SELECT 1 FROM "stock_positions" p
        WHERE p."userId" = s."userId" AND p."payer" = s."payer"
          AND p."mode" = 'REAL' AND p."closedAt" IS NULL
      )
    ORDER BY s."createdAt" ASC, (s."userId" || '|' || s."payer") ASC
    LIMIT ${STOCK_WALLET_REFRESH_MAX_PER_TICK}
  `);
  if (candidates.length === 0) {
    if (cursor) await writeSweepCursor(prisma, CURSOR, null);
    return { scanned: 0, refreshed: 0, errors: 0 };
  }

  const started = Date.now();
  let scanned = 0;
  let refreshed = 0;
  let errors = 0;
  let last = cursor;
  for (const candidate of candidates) {
    if (Date.now() - started >= STOCK_WALLET_REFRESH_BUDGET_MS) break;
    scanned++;
    last = { createdAt: candidate.createdAt, id: `${candidate.userId}|${candidate.payer}` };
    try {
      const leaseUntil = await claimWalletRefreshLease(
        prisma,
        candidate.userId,
        candidate.payer,
        now,
        STOCK_WALLET_REFRESH_LEASE_MS,
      );
      if (!leaseUntil) continue;
      try {
        const result = await refresh(candidate.userId, candidate.payer, now);
        if (result.accepted) refreshed++;
      } finally {
        await releaseWalletRefreshLease(prisma, candidate.userId, candidate.payer, leaseUntil);
      }
    } catch (error) {
      errors++;
      console.warn("[stock-wallets] refresh failed:", (error as Error).message);
    }
  }
  if (last) await writeSweepCursor(prisma, CURSOR, last);
  return { scanned, refreshed, errors };
}
