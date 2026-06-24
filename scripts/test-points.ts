// Self-check for the points scoring core. Run: npx tsx scripts/test-points.ts
// Asserts the ACTIVE one-time 7-day-window x2 (via scorePoints) AND the strategy unit
// behavior directly, so the meaning is pinned regardless of small refactors.
import assert from "node:assert";
import { scorePoints } from "../src/lib/points";
import {
  SevenDayWindowOneTime,
  type MultiplierContext,
} from "../src/lib/multiplier";

// --- helpers ----------------------------------------------------------------
// n consecutive swipe-days ending at `end` (inclusive), each worth `perDay` raw swipe.
function swipeWindow(end: string, n: number, perDay: number) {
  const out: { type: "SWIPE"; amount: number; utcDay: string }[] = [];
  const endMs = new Date(`${end}T00:00:00.000Z`).getTime();
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(endMs - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ type: "SWIPE", amount: perDay, utcDay: day });
  }
  return out;
}

// 1. ACTIVE strategy, level-6 streak (window NOT yet completed): no doubling.
{
  const rows = [
    ...swipeWindow("2026-06-24", 6, 3), // 6 days * 3 = 18 raw swipe
    { type: "LOGIN" as const, amount: 1, utcDay: "2026-06-24" },
    { type: "REFERRAL" as const, amount: 20, utcDay: "2026-06-24" },
  ];
  const r = scorePoints(rows, { currentLevel: 6, state: "ACTIVE" }, "u1");
  assert.strictEqual(r.breakdown.SWIPE, 18, "level6 raw swipe = 18");
  assert.strictEqual(r.bonusFromX2, 0, "level6: window not complete -> no x2");
  assert.strictEqual(r.total, 18 + 1 + 20, "level6 total = raw, login+referral raw");
}

// 2. ACTIVE strategy, level-7 streak: the just-completed 7-day window doubles, ONCE.
//    Only swipe doubles; login + referral stay raw.
{
  const rows = [
    ...swipeWindow("2026-06-24", 7, 3), // 7 days * 3 = 21 raw swipe
    { type: "LOGIN" as const, amount: 1, utcDay: "2026-06-24" },
    { type: "REFERRAL" as const, amount: 20, utcDay: "2026-06-24" },
  ];
  const r = scorePoints(rows, { currentLevel: 7, state: "ACTIVE" }, "u1");
  assert.strictEqual(r.breakdown.SWIPE, 21, "level7 raw swipe = 21");
  assert.strictEqual(r.bonusFromX2, 21, "level7: window doubled -> +21 bonus");
  // swipe 21->42, login 1 + referral 20 untouched.
  assert.strictEqual(r.total, 42 + 1 + 20, "level7 total = 63");
}

// 3. ACTIVE strategy, level-8 streak: still exactly ONE completed window (floor(8/7)=1).
//    Earliest 7 swipe-days double; day 8 stays raw -> not continuous.
{
  const rows = swipeWindow("2026-06-24", 8, 3); // 8 days * 3 = 24 raw
  const r = scorePoints(rows, { currentLevel: 8, state: "ACTIVE" }, "u1");
  assert.strictEqual(r.breakdown.SWIPE, 24, "level8 raw swipe = 24");
  // 7 days doubled (21->42) + 1 day raw (3) = 45; bonus = 45 - 24 = 21 (one window only).
  assert.strictEqual(r.bonusFromX2, 21, "level8: still one window -> +21, not continuous");
  assert.strictEqual(r.total, 45, "level8 total = 45");
}

// 4. ACTIVE strategy, level-14 streak: TWO completed windows -> 14 swipe-days double.
{
  const rows = swipeWindow("2026-06-24", 14, 3); // 14 * 3 = 42 raw
  const r = scorePoints(rows, { currentLevel: 14, state: "ACTIVE" }, "u1");
  assert.strictEqual(r.breakdown.SWIPE, 42, "level14 raw swipe = 42");
  assert.strictEqual(r.bonusFromX2, 42, "level14: two windows -> all 14 days double");
  assert.strictEqual(r.total, 84, "level14 total = 84");
}

// 5. Swipe points OUTSIDE the current streak span never double. A long-ago swipe-day
//    (older than currentLevel days) counts raw even when a window completes.
{
  const rows = [
    { type: "SWIPE" as const, amount: 5, utcDay: "2026-01-01" }, // ancient, outside streak
    ...swipeWindow("2026-06-24", 7, 3), // 21 raw in the just-completed window
  ];
  const r = scorePoints(rows, { currentLevel: 7, state: "ACTIVE" }, "u1");
  assert.strictEqual(r.breakdown.SWIPE, 26, "raw swipe = 5 + 21 = 26");
  assert.strictEqual(r.bonusFromX2, 21, "only the in-window 21 doubles; the ancient 5 stays raw");
  assert.strictEqual(r.total, 47, "level7+ancient total = (5) + (42) = 47");
}

// 6. Strategy unit check (pure, independent of scorePoints wiring):
//    earliest floor(L/7)*7 days double, login/referral are not even in scope here.
{
  const days = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      utcDay: `day${String(i).padStart(2, "0")}`,
      raw: 3,
    }));
  const mk = (level: number, n: number): MultiplierContext => ({
    userId: "u1",
    streakLevel: level,
    streakState: "ACTIVE",
    streakSwipeDays: days(n),
  });
  assert.strictEqual(SevenDayWindowOneTime.multipliedSwipePoints(mk(6, 6)), 18, "L6: 6*3 raw");
  assert.strictEqual(SevenDayWindowOneTime.multipliedSwipePoints(mk(7, 7)), 42, "L7: 7*3 doubled");
  assert.strictEqual(SevenDayWindowOneTime.multipliedSwipePoints(mk(8, 8)), 45, "L8: 7 doubled + 1 raw");
  assert.strictEqual(SevenDayWindowOneTime.multipliedSwipePoints(mk(0, 0)), 0, "L0: nothing");
}

console.log("points scoring: OK");
