// Self-check for the skip decision (DB-free). Run: npx tsx scripts/test-skip.ts
// Rule (new): a skip is ALWAYS free, always allowed, costs nothing — unlimited, so the user spends
// their daily swipes only on cards they care about. Inputs no longer affect the outcome.
import assert from "node:assert";
import { decideSkip } from "../src/lib/skip";

const free = { free: true, allowed: true, cost: 0 };

// Always free regardless of skips-used-today or shard balance.
assert.deepStrictEqual(decideSkip(0, 0), free, "1st skip free with 0 shards");
assert.deepStrictEqual(decideSkip(1, 0), free, "2nd skip free with 0 shards (no longer paid)");
assert.deepStrictEqual(decideSkip(50, 0), free, "50 skips in, 0 shards -> still free");
assert.deepStrictEqual(decideSkip(999, 999), free, "any input -> free/allowed/0");

console.log("skip economy: OK");
