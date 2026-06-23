// Self-checks for the pure engine cores (DB-free). Run: npx tsx scripts/test-engine.ts
import assert from "node:assert";
import { applyQualify, evaluateBurn } from "../src/lib/streak";
import { rollUp } from "../src/lib/shards";

// ---------------- streak: applyQualify ----------------
// First qualify -> level 1.
let s = applyQualify({ currentLevel: 0, state: "ACTIVE", lastQualifiedDay: null }, "2026-06-24");
assert.deepStrictEqual(s, { currentLevel: 1, state: "ACTIVE", lastQualifiedDay: "2026-06-24" });

// Consecutive day -> level++.
s = applyQualify({ currentLevel: 1, state: "ACTIVE", lastQualifiedDay: "2026-06-24" }, "2026-06-25");
assert.strictEqual(s.currentLevel, 2, "consecutive -> 2");

// Same day -> idempotent no-op.
s = applyQualify({ currentLevel: 2, state: "ACTIVE", lastQualifiedDay: "2026-06-25" }, "2026-06-25");
assert.strictEqual(s.currentLevel, 2, "same day -> no change");

// Gap of 2 from ACTIVE -> fresh start at 1.
s = applyQualify({ currentLevel: 5, state: "ACTIVE", lastQualifiedDay: "2026-06-20" }, "2026-06-24");
assert.strictEqual(s.currentLevel, 1, "gap -> fresh start");

// Qualify after burn (recoverable) without recovery -> fresh start at 1.
s = applyQualify({ currentLevel: 5, state: "BURNED_RECOVERABLE", lastQualifiedDay: "2026-06-20" }, "2026-06-24");
assert.deepStrictEqual(s, { currentLevel: 1, state: "ACTIVE", lastQualifiedDay: "2026-06-24" });

// ---------------- streak: evaluateBurn ----------------
// ACTIVE, missed a day (today is 2 days past last) -> BURNED_RECOVERABLE, window opens.
const now = new Date("2026-06-26T12:00:00.000Z");
let b = evaluateBurn({ state: "ACTIVE", lastQualifiedDay: "2026-06-24", recoverableUntil: null }, now);
assert.strictEqual(b.state, "BURNED_RECOVERABLE", "missed day -> burned");
assert.ok(b.recoverableUntil && b.recoverableUntil > now, "recovery window set in future");

// ACTIVE, qualified yesterday (gap 1) -> still ACTIVE (no burn).
b = evaluateBurn({ state: "ACTIVE", lastQualifiedDay: "2026-06-25", recoverableUntil: null }, now);
assert.strictEqual(b.state, "ACTIVE", "gap 1 -> no burn");

// BURNED_RECOVERABLE past the window -> LOST, level resets.
b = evaluateBurn(
  { state: "BURNED_RECOVERABLE", lastQualifiedDay: "2026-06-20", recoverableUntil: new Date("2026-06-25T00:00:00Z") },
  now,
);
assert.strictEqual(b.state, "LOST", "expired window -> lost");
assert.strictEqual(b.currentLevelReset, true, "lost resets level");

// BURNED_RECOVERABLE still inside window -> unchanged.
b = evaluateBurn(
  { state: "BURNED_RECOVERABLE", lastQualifiedDay: "2026-06-25", recoverableUntil: new Date("2026-06-28T00:00:00Z") },
  now,
);
assert.strictEqual(b.state, "BURNED_RECOVERABLE", "inside window -> still recoverable");

// ---------------- shards: rollUp ----------------
// 19 + 1 = 20 -> 1 artifact, 0 shard remainder.
assert.deepStrictEqual(rollUp(19, 0, 1), { shards: 0, artifacts: 1, artifactsCreated: 1 });
// 5 + 1 = 6 -> no artifact.
assert.deepStrictEqual(rollUp(5, 2, 1), { shards: 6, artifacts: 2, artifactsCreated: 0 });
// Adding a batch that crosses two thresholds (carry remainder).
assert.deepStrictEqual(rollUp(15, 0, 30), { shards: 5, artifacts: 2, artifactsCreated: 2 });

console.log("engine cores: OK");
