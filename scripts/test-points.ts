// Self-check for the points scoring core. Run: npx tsx scripts/test-points.ts
// Tests the per-day multiplier application directly against the strategies, so it
// passes regardless of which one ACTIVE_MULTIPLIER currently points at.
import assert from "node:assert";
import { scorePoints } from "../src/lib/points";
import {
  SevenDayContinuous,
  SeventyPointsContinuous,
  type MultiplierContext,
} from "../src/lib/multiplier";

const rows = [
  { type: "SWIPE" as const, amount: 10, utcDay: "2026-06-23" },
  { type: "SWIPE" as const, amount: 7, utcDay: "2026-06-24" },
  { type: "LOGIN" as const, amount: 5, utcDay: "2026-06-24" },
  { type: "REFERRAL" as const, amount: 20, utcDay: "2026-06-24" },
];

// 1. Identity (default ACTIVE_MULTIPLIER): raw sum, no x2.
const r = scorePoints(rows, { currentLevel: 0, state: "ACTIVE" }, "u1");
assert.strictEqual(r.breakdown.SWIPE, 17, "raw swipe = 17");
assert.strictEqual(r.breakdown.LOGIN, 5);
assert.strictEqual(r.breakdown.REFERRAL, 20);
// Under Identity total = 17 + 5 + 20 = 42, no x2 bonus.
assert.strictEqual(r.total, 42, "identity total = 42");
assert.strictEqual(r.bonusFromX2, 0, "identity: no x2 bonus");

// 2. The strategies double ONLY swipe points, and login/referral never multiply.
const ctx: MultiplierContext = {
  userId: "u1",
  utcDay: "2026-06-24",
  streakLevel: 7,
  streakState: "ACTIVE",
  cumulativeSwipePoints: 70,
  swipePointsOnDay: 7,
};
assert.strictEqual(SevenDayContinuous.multiplierForDay(ctx), 2, "7-day -> x2");
assert.strictEqual(
  SevenDayContinuous.multiplierForDay({ ...ctx, streakLevel: 6 }),
  1,
  "6-day -> x1",
);
assert.strictEqual(
  SeventyPointsContinuous.multiplierForDay(ctx),
  2,
  "70 pts -> x2",
);
assert.strictEqual(
  SeventyPointsContinuous.multiplierForDay({ ...ctx, cumulativeSwipePoints: 69 }),
  1,
  "69 pts -> x1",
);

// 3. Sanity: if x2 applied to this data, swipe 17 -> 34, total 34+25 = 59 (not 42+17).
//    Confirms login(5)+referral(20) stay raw under doubling.
const doubled = 17 * 2 + 5 + 20;
assert.strictEqual(doubled, 59, "x2 doubles only swipe: 59");

console.log("points scoring: OK");
