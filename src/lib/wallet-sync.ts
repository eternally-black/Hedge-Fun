import type { Prisma, PrismaClient } from "@prisma/client";

export type WalletDb = Prisma.TransactionClient;

export async function lockWalletPayer(db: WalletDb, payer: string): Promise<void> {
  // Payer-scoped, rather than user-scoped: one verified wallet can appear on more than one account.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${payer}))`;
}

export async function ensureWalletState(db: WalletDb, userId: string, payer: string): Promise<void> {
  // A wallet can be verified by more than one account. A newly linked owner must inherit the
  // payer-wide slot floor already learned by existing owners, or it could accept a replica snapshot
  // from before a confirmed trade. Callers hold the payer advisory lock while this runs.
  const inherited = await db.stockWalletState.aggregate({
    where: { payer },
    _max: { lastAcceptedSlot: true, latestConfirmedReceiptSlot: true },
  });
  await db.stockWalletState.upsert({
    where: { userId_payer: { userId, payer } },
    create: {
      userId,
      payer,
      lastAcceptedSlot: inherited._max.lastAcceptedSlot,
      latestConfirmedReceiptSlot: inherited._max.latestConfirmedReceiptSlot,
    },
    update: {
      lastAcceptedSlot: inherited._max.lastAcceptedSlot,
      latestConfirmedReceiptSlot: inherited._max.latestConfirmedReceiptSlot,
    },
  });
}

export async function bumpWalletGeneration(
  db: WalletDb,
  userId: string,
  payer: string,
  confirmedSlot?: bigint,
): Promise<void> {
  await lockWalletPayer(db, payer);
  const now = new Date();
  await ensureWalletState(db, userId, payer);
  // Materialize clocks for every account that can legitimately act through this payer before the
  // shared generation bump. This closes the cross-user race where one verified wallet is linked to
  // two accounts and the second account had not yet created its state row.
  await db.$executeRaw`
    INSERT INTO "stock_wallet_states" ("userId", "payer", "generation", "createdAt", "updatedAt")
    SELECT "userId", ${payer}, 0, ${now}, ${now}
    FROM "hedge_wallets"
    WHERE "address" = ${payer} AND "verifiedAt" IS NOT NULL
    ON CONFLICT ("userId", "payer") DO NOTHING
  `;
  if (confirmedSlot === undefined) {
    await db.stockWalletState.updateMany({ where: { payer }, data: { generation: { increment: 1n } } });
  } else {
    // Propagate the landed-slot fence to every account that shares this verified payer. The payer
    // lock serializes this raw GREATEST update with snapshot acceptance.
    await db.$executeRaw`
      UPDATE "stock_wallet_states"
      SET "generation" = "generation" + 1,
          "latestConfirmedReceiptSlot" = GREATEST(COALESCE("latestConfirmedReceiptSlot", 0), ${confirmedSlot}),
          "updatedAt" = ${now}
      WHERE "payer" = ${payer}
    `;
  }
}

export interface WalletSnapshotFence {
  generation: bigint;
  requiredSlot: bigint;
}

export async function captureWalletSnapshotFence(
  prisma: PrismaClient,
  userId: string,
  payer: string,
): Promise<WalletSnapshotFence> {
  return prisma.$transaction(async (db) => {
    await lockWalletPayer(db, payer);
    await ensureWalletState(db, userId, payer);
    const state = await db.stockWalletState.findUniqueOrThrow({ where: { userId_payer: { userId, payer } } });
    const requiredSlot = [state.lastAcceptedSlot, state.latestConfirmedReceiptSlot]
      .filter((slot): slot is bigint => slot !== null)
      .reduce((max, slot) => (slot > max ? slot : max), 0n);
    return { generation: state.generation, requiredSlot };
  });
}

export async function claimWalletRefreshLease(
  prisma: PrismaClient,
  userId: string,
  payer: string,
  now: Date,
  leaseMs: number,
): Promise<Date | null> {
  return prisma.$transaction(async (db) => {
    await lockWalletPayer(db, payer);
    await ensureWalletState(db, userId, payer);
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await db.stockWalletState.updateMany({
      where: {
        userId,
        payer,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: { leaseUntil },
    });
    return result.count === 1 ? leaseUntil : null;
  });
}

export async function releaseWalletRefreshLease(
  prisma: PrismaClient,
  userId: string,
  payer: string,
  leaseUntil: Date,
): Promise<void> {
  await prisma.$transaction(async (db) => {
    await lockWalletPayer(db, payer);
    // A slow worker may finish after its lease expired and another worker acquired a new one. Match
    // the exact acquisition token so the old worker cannot clear the new owner's lease.
    await db.stockWalletState.updateMany({ where: { userId, payer, leaseUntil }, data: { leaseUntil: null } });
  });
}
