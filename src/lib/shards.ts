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
  let counted = true;
  if (!bypassCap) {
    const counter = await tx.dailyCounter.upsert({
      where: { userId_utcDay: { userId, utcDay: day } },
      create: { userId, utcDay: day, shardCount: 0 },
      update: {},
    });
    counted = counter.shardCount < SHARD_DAILY_CAP;
  }

  await tx.shardGrant.create({ data: { userId, betId, utcDay: day, counted } });

  if (!counted) {
    // Over cap: recorded but not added to balance.
    return { shardAwarded: false, artifactsCreated: 0, shards: bal0.shards, artifacts: bal0.artifacts };
  }

  if (!bypassCap) {
    await tx.dailyCounter.update({
      where: { userId_utcDay: { userId, utcDay: day } },
      data: { shardCount: { increment: 1 } },
    });
  }

  const next = rollUp(bal0.shards, bal0.artifacts, 1);
  await tx.collectibleBalance.update({
    where: { userId },
    data: { shards: next.shards, artifacts: next.artifacts },
  });

  return {
    shardAwarded: true,
    artifactsCreated: next.artifactsCreated,
    shards: next.shards,
    artifacts: next.artifacts,
  };
}
