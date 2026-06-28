// Self-check for the admin leaderboard: the allowlist gate, windowed scoring, and the pure
// filter/sort the table derives during render. Run: npx tsx scripts/test-admin.ts
import assert from "node:assert";
import { scorePoints } from "../src/lib/points";
import { deriveRows, pointsFor } from "../src/app/admin/leaderboard/AdminLeaderboardTable";
import type { AdminLeaderboardRow } from "../src/lib/api-types";

// --- isAdmin allowlist (env read at module load -> set BEFORE importing) --------------------
async function main() {
  process.env.ADMIN_EMAILS = "  Boss@Team.com , growth@team.com ";
  process.env.ADMIN_TWITTER = "  @BossHandle , growthX ";
  const { isAdmin } = await import("../src/lib/admin");
  assert.strictEqual(isAdmin({ email: "boss@team.com" }), true, "exact email match (lowercased)");
  assert.strictEqual(isAdmin({ email: "  BOSS@TEAM.COM " }), true, "case + whitespace insensitive");
  assert.strictEqual(isAdmin({ email: "growth@team.com" }), true, "second email entry matches");
  assert.strictEqual(isAdmin({ email: "rando@team.com" }), false, "non-listed email -> false");
  assert.strictEqual(isAdmin({ email: null, twitterHandle: null }), false, "no email, no handle -> false");
  // X handle path (admins with no email): match on handle, @ optional, case-insensitive.
  assert.strictEqual(isAdmin({ twitterHandle: "BossHandle" }), true, "exact handle (env had @, case-insensitive)");
  assert.strictEqual(isAdmin({ twitterHandle: "@growthX" }), true, "handle with leading @ matches");
  assert.strictEqual(isAdmin({ twitterHandle: "rando" }), false, "non-listed handle -> false");
  assert.strictEqual(isAdmin({ email: "rando@team.com", twitterHandle: "bosshandle" }), true, "either key grants");
}

// --- windowed scoring: filtering by utcDay then scorePoints is the route's contract -----------
{
  // 3 swipe-days: two old (outside the week), one today. all-time=3 raw; week+today narrower.
  const today = new Date().toISOString().slice(0, 10);
  const old1 = "2026-01-01";
  const old2 = "2026-01-02";
  const rows = [
    { type: "SWIPE" as const, amount: 1, utcDay: old1 },
    { type: "SWIPE" as const, amount: 1, utcDay: old2 },
    { type: "SWIPE" as const, amount: 1, utcDay: today },
  ];
  const ctx = { currentLevel: 0, state: "ACTIVE" as const }; // level 0 -> no x2, totals = raw sums
  assert.strictEqual(scorePoints(rows, ctx, "u1").total, 3, "all-time = 3");
  assert.strictEqual(scorePoints(rows.filter((r) => r.utcDay === today), ctx, "u1").total, 1, "today = 1");

  const weekCutoff = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  assert.strictEqual(
    scorePoints(rows.filter((r) => r.utcDay >= weekCutoff), ctx, "u1").total,
    1,
    "this week = 1 (old days excluded)",
  );
}

// --- pure filter / sort the table derives ----------------------------------------------------
{
  const mk = (id: string, h: string | null, all: number, week: number, day: number): AdminLeaderboardRow => ({
    userId: id,
    handle: h ?? `user_${id.slice(-6)}`,
    twitterHandle: h,
    hasTwitter: h != null,
    pointsAll: all,
    pointsWeek: week,
    pointsToday: day,
    streakLevel: 0,
    lastActive: null,
    rank: 0,
  });
  const rows = [mk("aaaaaa", "alice", 100, 10, 1), mk("bbbbbb", null, 50, 40, 5), mk("cccccc", "carol", 30, 30, 0)];
  const base = { window: "all" as const, sortKey: "points" as const, sortDir: "desc" as const, query: "", hasTwitterOnly: false, minPoints: 0 };

  // pointsFor picks the active window.
  assert.strictEqual(pointsFor(rows[1]!, "week"), 40, "pointsFor week");

  // Default: all-time desc -> alice(100), bob(50), carol(30).
  assert.deepStrictEqual(deriveRows(rows, base).map((r) => r.userId), ["aaaaaa", "bbbbbb", "cccccc"], "all-time desc");

  // Window switch reorders: week desc -> bob(40), carol(30), alice(10).
  assert.deepStrictEqual(deriveRows(rows, { ...base, window: "week" }).map((r) => r.userId), ["bbbbbb", "cccccc", "aaaaaa"], "week desc");

  // hasTwitter filter drops bob (no handle).
  assert.deepStrictEqual(deriveRows(rows, { ...base, hasTwitterOnly: true }).map((r) => r.userId), ["aaaaaa", "cccccc"], "hasTwitter filter");

  // minPoints (all-time) >= 50 drops carol.
  assert.deepStrictEqual(deriveRows(rows, { ...base, minPoints: 50 }).map((r) => r.userId), ["aaaaaa", "bbbbbb"], "minPoints filter");

  // search by handle.
  assert.deepStrictEqual(deriveRows(rows, { ...base, query: "carol" }).map((r) => r.userId), ["cccccc"], "search handle");

  // does not mutate the input array (toSorted).
  const before = rows.map((r) => r.userId).join(",");
  deriveRows(rows, { ...base, sortKey: "handle", sortDir: "asc" });
  assert.strictEqual(rows.map((r) => r.userId).join(","), before, "input not mutated");
}

main()
  .then(() => console.log("admin leaderboard: OK"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
