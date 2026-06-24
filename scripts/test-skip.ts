// Self-check for the skip economy decision (DB-free). Run: npx tsx scripts/test-skip.ts
// Rule: first FREE_SKIPS_PER_DAY skips/day are free; each next costs SKIP_SHARD_COST shards;
// blocked if the balance can't cover the cost.
import assert from "node:assert";
import { decideSkip } from "../src/lib/skip";
import { FREE_SKIPS_PER_DAY, SKIP_SHARD_COST } from "../src/lib/config";

// First skip of the day is free regardless of shards (even 0).
{
  const d = decideSkip(0, 0);
  assert.deepStrictEqual(d, { free: true, allowed: true, cost: 0 }, "1st skip free even with 0 shards");
}

// At the free limit with shards -> paid skip allowed, costs SKIP_SHARD_COST.
{
  const d = decideSkip(FREE_SKIPS_PER_DAY, 5);
  assert.strictEqual(d.free, false, "past free limit -> not free");
  assert.strictEqual(d.allowed, true, "has shards -> allowed");
  assert.strictEqual(d.cost, SKIP_SHARD_COST, "costs one shard");
}

// At the free limit with NO shards -> blocked (no count, no spend).
{
  const d = decideSkip(FREE_SKIPS_PER_DAY, SKIP_SHARD_COST - 1);
  assert.strictEqual(d.allowed, false, "no shards -> blocked");
  assert.strictEqual(d.cost, 0, "blocked skip costs nothing");
}

// Exactly enough shards -> allowed (boundary).
{
  const d = decideSkip(FREE_SKIPS_PER_DAY, SKIP_SHARD_COST);
  assert.strictEqual(d.allowed, true, "exactly cost shards -> allowed");
}

// Many skips in, still gated purely by shards.
{
  assert.strictEqual(decideSkip(50, 1).allowed, SKIP_SHARD_COST <= 1, "deep into the day, gated by shards");
  assert.strictEqual(decideSkip(50, 0).allowed, false, "50 skips, 0 shards -> blocked");
}

console.log("skip economy: OK");
