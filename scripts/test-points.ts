// Self-check for the points scoring core. Run: npx tsx scripts/test-points.ts
// Asserts the materialised STREAK_X2 bonus is summed like any other row, so the meaning is
// pinned regardless of small refactors.
import assert from "node:assert";
import { scorePoints } from "../src/lib/points";

// 1. Rows with SWIPE + STREAK_X2 + LOGIN: total = every row summed, bonusFromX2 = STREAK_X2.
{
  const rows = [
    { type: "SWIPE" as const, amount: 10, utcDay: "2026-06-24" },
    { type: "STREAK_X2" as const, amount: 7, utcDay: "2026-06-24" },
    { type: "LOGIN" as const, amount: 1, utcDay: "2026-06-24" },
  ];
  const r = scorePoints(rows);
  assert.strictEqual(r.breakdown.SWIPE, 10, "raw swipe = 10");
  assert.strictEqual(r.breakdown.STREAK_X2, 7, "STREAK_X2 = 7");
  assert.strictEqual(r.bonusFromX2, 7, "bonusFromX2 = STREAK_X2 rows");
  assert.strictEqual(r.rawSwipe, 10, "rawSwipe = SWIPE rows");
  assert.strictEqual(r.total, 10 + 7 + 1, "total = 18 (all rows summed)");
}

// 2. Rows with no STREAK_X2: bonusFromX2 = 0.
{
  const rows = [
    { type: "SWIPE" as const, amount: 10, utcDay: "2026-06-24" },
    { type: "LOGIN" as const, amount: 1, utcDay: "2026-06-24" },
    { type: "REFERRAL" as const, amount: 20, utcDay: "2026-06-24" },
  ];
  const r = scorePoints(rows);
  assert.strictEqual(r.bonusFromX2, 0, "no STREAK_X2 rows -> bonus 0");
  assert.strictEqual(r.total, 10 + 1 + 20, "total = raw sums");
}

// 3. TOPUP_SPEND rows are negative and net out; nothing is ever multiplied.
{
  const rows = [
    { type: "SWIPE" as const, amount: 10, utcDay: "2026-06-24" },
    { type: "TOPUP_SPEND" as const, amount: -4, utcDay: "2026-06-24" },
  ];
  const r = scorePoints(rows);
  assert.strictEqual(r.total, 6, "negative TOPUP_SPEND subtracts");
}

console.log("points scoring: OK");
