import { Prisma } from "@prisma/client";
import { utcDay } from "./time";
import { SHARD_DAILY_CAP, SHARDS_PER_ARTIFACT } from "./config";

type Db = Prisma.TransactionClient;

// Pure conversion: given a shard balance and how many new shards to add, roll up
// every SHARDS_PER_ARTIFACT into 1 artifact, carry the remainder. DB-free, testable.
export function rollUp(
  shards: number,
  artifacts: number,
  add: number,
): { shards: number; artifacts: number; artifactsCreated: number } {
  const total = shards + add;
  const created = Math.floor(total / SHARDS_PER_ARTIFACT);
  return {
    shards: total % SHARDS_PER_ARTIFACT,
    artifacts: artifacts + created,
    artifactsCreated: created,
  };
}

// Award 1 shard for a winning bet. Called inside the settlement transaction (tx required).
//  - Idempotent on ShardGrant.betId (unique): a re-settled bet never double-awards.
//  - Daily cap (P-8): max SHARD_DAILY_CAP/day; over-cap grants are recorded counted=false.
//  - bypassCap (FEED bets): no daily cap AND no touch of shardCount — feed shards neither cap
//    themselves nor consume the deck's SHARD_DAILY_CAP. They're always counted (and rolled up).
//  - Auto-converts 20 shards -> 1 artifact.
export async function awardShard(
  tx: Db,
  userId: string,
  betId: string,
  at?: Date,
  opts?: { bypassCap?: boolean },
): Promise<{ shardAwarded: boolean; artifactsCreated: number; shards: number; artifacts: number }> {
  const day = utcDay(at);
  const bypassCap = opts?.bypassCap ?? false;

  // Idempotency: if a grant already exists for this bet, do nothing.
  const existing = await tx.shardGrant.findUnique({ where: { betId } });
  const bal0 = await tx.collectibleBalance.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  if (existing) {
    return { shardAwarded: false, artifactsCreated: 0, shards: bal0.shards, artifacts: bal0.artifacts };
  }

  // Daily cap check via per-day counter — DECK only. Feed bets (bypassCap) skip it: always counted,
  // and they don't read/increment shardCount, so they stay off the deck's daily-cap ledger entirely.
  //
  // Claim the slot with the bound IN THE WHERE, not read-then-increment. This function runs inside
  // the CALLER's transaction and two of the three callers (orders.ts bookExitFills, real-settle.ts
  // consumeResolvedPosition) open theirs at the default isolation, where two concurrent awards both
  // read the same shardCount and both pass a cap that had room for one. Deciding and counting in a
  // single statement holds at any isolation level.
  let counted = true;
  if (!bypassCap) {
    await tx.dailyCounter.upsert({
      where: { userId_utcDay: { userId, utcDay: day } },
      create: { userId, utcDay: day, shardCount: 0 },
      update: {},
    });
    const claimed = await tx.dailyCounter.updateMany({
      where: { userId, utcDay: day, shardCount: { lt: SHARD_DAILY_CAP } },
      data: { shardCount: { increment: 1 } },
    });
    counted = claimed.count > 0;
  }

  await tx.shardGrant.create({ data: { userId, betId, utcDay: day, counted } });

  if (!counted) {
    // Over cap: recorded but not added to balance.
    return { shardAwarded: false, artifactsCreated: 0, shards: bal0.shards, artifacts: bal0.artifacts };
  }

  // Same hazard as the cap, bigger payout: applying rollUp's ABSOLUTE result would write a balance
  // computed from `bal0`, read before this statement. Two concurrent awards both reading 19 shards
  // both write {shards: 0, artifacts: +1} — two artifacts minted from 21 shards, and an artifact
  // buys a TOPUP_GRANT_CENTS top-up. Increment (atomic everywhere), then convert the overflow with
  // the threshold in the WHERE so only one of the racers can take it. rollUp stays the pure model
  // of the same rule (and its unit tests in test-engine.ts).
  const bal = await tx.collectibleBalance.update({
    where: { userId },
    data: { shards: { increment: 1 } },
    select: { shards: true, artifacts: true },
  });
  const converted =
    bal.shards >= SHARDS_PER_ARTIFACT
      ? await tx.collectibleBalance.updateMany({
          where: { userId, shards: { gte: SHARDS_PER_ARTIFACT } },
          data: { shards: { decrement: SHARDS_PER_ARTIFACT }, artifacts: { increment: 1 } },
        })
      : { count: 0 };

  return {
    shardAwarded: true,
    artifactsCreated: converted.count,
    shards: bal.shards - converted.count * SHARDS_PER_ARTIFACT,
    artifacts: bal.artifacts + converted.count,
  };
}
