// Self-checks for the GM week grid (DB-free). Covers the date helpers and the pure
// buildGmWeek cell logic — the per-user window cutoff + live "today" column.
// Run: npx tsx scripts/test-gm-week.ts
import assert from "node:assert";
import { weekdayMon0, streakWindowStartDay } from "../src/lib/time";
import { buildGmWeek } from "../src/app/screens/GmScreen";

// ---- weekdayMon0: Mon=0..Sun=6 ----
assert.strictEqual(weekdayMon0("2026-06-25"), 3, "2026-06-25 is Thursday -> 3");
assert.strictEqual(weekdayMon0("2026-06-22"), 0, "2026-06-22 is Monday -> 0");
assert.strictEqual(weekdayMon0("2026-06-28"), 6, "2026-06-28 is Sunday -> 6");

// ---- streakWindowStartDay: where the user's current 7-day window began ----
// Level 0 / fresh -> today (window starts now).
assert.strictEqual(streakWindowStartDay(0, null, "2026-06-25"), "2026-06-25", "fresh -> today");
// Level 1 qualified today -> window started today.
assert.strictEqual(streakWindowStartDay(1, "2026-06-25", "2026-06-25"), "2026-06-25", "L1 -> start today");
// Level 3, last qualified Thu -> started 2 days earlier (Tue).
assert.strictEqual(streakWindowStartDay(3, "2026-06-25", "2026-06-25"), "2026-06-23", "L3 Thu -> Tue start");
// Level 8 wraps: position (8-1)%7 = 0 -> window restarted on lastQualifiedDay.
assert.strictEqual(streakWindowStartDay(8, "2026-06-25", "2026-06-25"), "2026-06-25", "L8 wraps to a fresh window");

// ---- buildGmWeek: today column + window-start cutoff + done fills ----
// New user, Thursday, just checked in (level 1, done). Window starts Thursday (col 3).
const w = buildGmWeek(/*today*/ 3, /*winStart*/ 3, /*level*/ 1, /*done*/ true);
assert.strictEqual(w.length, 7, "seven cells");
assert.ok(w[3].isToday, "Thursday is today");
assert.ok(w[3].isWindowStart, "window starts Thursday");
assert.ok(w[3].isDone, "today is done after check-in");
assert.ok(!w[2].isDone && !w[4].isDone, "no other day filled for a 1-day streak");
assert.strictEqual(w.filter((d) => d.isWindowStart).length, 1, "exactly one window-start column");

// Mid-week streak: started Tue (col 1), today Thu (col 3), level 3, done.
const w2 = buildGmWeek(3, 1, 3, true);
assert.ok(w2[1].isWindowStart, "window starts Tuesday");
assert.ok(w2[1].isDone && w2[2].isDone && w2[3].isDone, "Tue/Wed/Thu filled");
assert.ok(!w2[0].isDone && !w2[4].isDone, "Mon and Fri not filled");

// Not yet checked in today: today shows the sun, not done.
const w3 = buildGmWeek(3, 3, 0, false);
assert.ok(w3[3].isToday && !w3[3].isDone, "today not done before check-in");

console.log("OK: GM week grid — weekday math, window start, cutoff, today column");
