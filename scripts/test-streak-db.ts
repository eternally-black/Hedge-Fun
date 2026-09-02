// (6) Streak DB transitions. /api/me runs evaluateStreak on EVERY read (defensive sweep), so the
// DB state machine — not just the pure evaluateBurn (already unit-tested) — must move ACTIVE ->
// BURNED_RECOVERABLE -> LOST correctly, and recoverStreak must spend an artifact to resume at n+1
// only inside the window. These are the streak guarantees Android reads back through /me and /recover.
// Time is driven via the `at` param (no real clock) so the transitions are deterministic.
// Run: npx tsx scripts/test-streak-db.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { qualifyDay, evaluateStreak, recoverStreak } from "../src/lib/streak";
import { writePoints, effectivePoints } from "../src/lib/points";
import { RECOVERY_WINDOW_DAYS } from "../src/lib/config";

const D = (s: string) => new Date(`${s}T12:00:00.000Z`); // noon UTC so utcDay() is unambiguous

async function main() {
  const tag = `streaktest-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } },
      collectibleBalance: { create: { artifacts: 1 } }, // one artifact to spend on recovery
      streak: { create: {} } },
  });

  // Build an ACTIVE level-2 streak: qualify two consecutive days.
  const q1 = await qualifyDay(user.id, D("2026-06-01"));
  assert.strictEqual(q1.currentLevel, 1, "day 1 -> level 1");
  const q2 = await qualifyDay(user.id, D("2026-06-02"));
  assert.strictEqual(q2.currentLevel, 2, "consecutive day 2 -> level 2");
  assert.strictEqual(q2.state, "ACTIVE", "still ACTIVE");

  // Same-day re-qualify is a no-op (idempotent GM tap).
  const q2b = await qualifyDay(user.id, D("2026-06-02"));
  assert.strictEqual(q2b.qualifiedToday, false, "re-qualify same day = no-op");
  assert.strictEqual(q2b.currentLevel, 2, "level unchanged on same-day re-tap");

  // ACTIVE -> BURNED_RECOVERABLE: a full day is skipped (last qualified 06-02, now 06-04 = gap 2).
  const burned = await evaluateStreak(user.id, D("2026-06-04"));
  assert.strictEqual(burned!.state, "BURNED_RECOVERABLE", "gap of 2 days burns the streak");
  assert.ok(burned!.recoverableUntil, "recovery window opened");
  assert.strictEqual(burned!.currentLevel, 2, "level preserved while recoverable (not yet reset)");

  // Idempotent: a second sweep on the same day doesn't change anything.
  const burned2 = await evaluateStreak(user.id, D("2026-06-04"));
  assert.strictEqual(burned2!.state, "BURNED_RECOVERABLE", "burn sweep is idempotent");

  // RECOVER within the window: spend the 1 artifact, resume at n+1 = 3, back to ACTIVE.
  const rec = await recoverStreak(user.id, D("2026-06-05"));
  assert.strictEqual(rec.recovered, true, "recovered within window");
  assert.strictEqual(rec.currentLevel, 3, "resume at n+1 = 3");
  const collAfter = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(collAfter.artifacts, 0, "recovery spent exactly 1 artifact");

  // A second recovery with no artifact left is rejected (and ACTIVE isn't recoverable anyway).
  const recFail = await recoverStreak(user.id, D("2026-06-05"));
  assert.strictEqual(recFail.recovered, false, "no second recovery");
  assert.ok(recFail.reason === "not_recoverable" || recFail.reason === "no_artifact", "rejected reason");

  // ---- Window EXPIRY: BURNED_RECOVERABLE -> LOST once past recoverableUntil ----
  // Fresh user: burn, then sweep past the recovery window. Level resets to 0 on LOST.
  const tag2 = `${tag}-lost`;
  const u2 = await prisma.user.create({
    data: { privyId: `did:privy:${tag2}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} },
      streak: { create: {} } },
  });
  await qualifyDay(u2.id, D("2026-06-01"));
  await qualifyDay(u2.id, D("2026-06-02"));
  const b = await evaluateStreak(u2.id, D("2026-06-04")); // burn
  assert.strictEqual(b!.state, "BURNED_RECOVERABLE", "u2 burned");
  // Sweep just past recoverableUntil (burnedAt 06-04 + RECOVERY_WINDOW_DAYS).
  const pastWindow = new Date(b!.recoverableUntil!.getTime() + 86_400_000);
  const lost = await evaluateStreak(u2.id, pastWindow);
  assert.strictEqual(lost!.state, "LOST", `past ${RECOVERY_WINDOW_DAYS}-day window -> LOST`);
  assert.strictEqual(lost!.currentLevel, 0, "LOST resets level to 0");

  // recoverStreak on a LOST streak is rejected (window gone).
  const lostRec = await recoverStreak(u2.id, new Date(pastWindow.getTime() + 86_400_000));
  assert.strictEqual(lostRec.recovered, false, "cannot recover a LOST streak");
  assert.strictEqual(lostRec.reason, "not_recoverable", "LOST is not recoverable");

  // ---- x2 bonus materialisation: a completed 7-day window writes a STREAK_X2 row, and a later
  // LOST streak does NOT take it back ----
  const tag4 = `${tag}-x2`;
  const u4 = await prisma.user.create({
    data: { privyId: `did:privy:${tag4}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } }, collectibleBalance: { create: {} },
      streak: { create: {} } },
  });
  // Seven consecutive days, one SWIPE point written before each tap.
  for (let i = 1; i <= 7; i++) {
    const day = `2026-07-0${i}`;
    await writePoints(prisma, { userId: u4.id, type: "SWIPE", amount: 1, utcDay: day });
    const q = await qualifyDay(u4.id, D(day));
    assert.strictEqual(q.currentLevel, i, `day ${i} -> level ${i}`);
  }
  // After the 7th tap, a STREAK_X2 row with amount 7 exists.
  const x2row = await prisma.pointsLedger.findFirst({ where: { userId: u4.id, type: "STREAK_X2" } });
  assert.ok(x2row, "STREAK_X2 row written at level 7");
  assert.strictEqual(x2row!.amount, 7, "STREAK_X2 amount = 7 (one point per swipe-day)");

  // Force the streak to LOST (burn, then sweep past the recovery window).
  const b4 = await evaluateStreak(u4.id, D("2026-07-09")); // gap 2 -> burn
  assert.strictEqual(b4!.state, "BURNED_RECOVERABLE", "u4 burned");
  const pastWindow4 = new Date(b4!.recoverableUntil!.getTime() + 86_400_000);
  const lost4 = await evaluateStreak(u4.id, pastWindow4);
  assert.strictEqual(lost4!.state, "LOST", "u4 lost");
  assert.strictEqual(lost4!.currentLevel, 0, "LOST resets level to 0");

  // The STREAK_X2 row still exists and effectivePoints still includes it.
  const x2after = await prisma.pointsLedger.findFirst({ where: { userId: u4.id, type: "STREAK_X2" } });
  assert.ok(x2after, "STREAK_X2 row survives a LOST streak");
  const ep4 = await effectivePoints(prisma, u4.id);
  assert.strictEqual(ep4.bonusFromX2, 7, "bonus still counted after LOST");
  assert.strictEqual(ep4.total, 14, "total = 7 swipe + 7 bonus after LOST");

  // ---- REGRESSION (F7/P-10): GM tap after a missed day must BURN, not silently restart at 1 ----
  // The bug: qualifyDay ran applyQualify with no preceding evaluateStreak, so an ACTIVE streak with
  // a gap>=2 (user missed exactly one day and taps GM before the /me or poller burn-sweep) reset to
  // a fresh level-1 ACTIVE streak — never entering BURNED_RECOVERABLE, permanently killing the
  // artifact recovery. The fix runs the burn sweep inside qualifyDay's transaction first.
  const tag3 = `${tag}-recover`;
  const u3 = await prisma.user.create({
    data: { privyId: `did:privy:${tag3}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: 100000 } },
      collectibleBalance: { create: { artifacts: 1 } }, // one artifact to spend on recovery
      streak: { create: {} } },
  });
  // Build a level-3 streak, then qualify day N+2 (a missed day) with NO evaluateStreak between.
  await qualifyDay(u3.id, D("2026-06-01"));
  await qualifyDay(u3.id, D("2026-06-02"));
  const q3 = await qualifyDay(u3.id, D("2026-06-03"));
  assert.strictEqual(q3.currentLevel, 3, "level 3 after three consecutive days");
  // Missed 06-04. Tap GM on 06-05 (gap 2) directly — this is the swept-by-no-one GM path.
  const gap = await qualifyDay(u3.id, D("2026-06-05"));
  assert.strictEqual(gap.state, "BURNED_RECOVERABLE", "missed-day GM tap burns (does NOT restart at 1)");
  assert.strictEqual(gap.currentLevel, 3, "level preserved through the burn (NOT reset to 1)");
  assert.strictEqual(gap.qualifiedToday, false, "burned tap does not award a streak day");
  // The streak row itself reflects BURNED_RECOVERABLE with the window open and level intact.
  const u3streak = await prisma.streak.findUniqueOrThrow({ where: { userId: u3.id } });
  assert.strictEqual(u3streak.state, "BURNED_RECOVERABLE", "DB row burned, recovery window open");
  assert.strictEqual(u3streak.currentLevel, 3, "DB level preserved for recovery");
  assert.ok(u3streak.recoverableUntil, "recovery window opened by the in-tx burn");
  // Artifact recovery is STILL available afterward (the whole point of the fix): resume at n+1 = 4.
  const u3rec = await recoverStreak(u3.id, D("2026-06-06"));
  assert.strictEqual(u3rec.recovered, true, "artifact recovery still available after missed-day GM tap");
  assert.strictEqual(u3rec.currentLevel, 4, "recovery resumes at n+1 = 4 (level was preserved)");

  // cleanup
  for (const id of [user.id, u2.id, u3.id, u4.id]) {
    await prisma.streakEvent.deleteMany({ where: { userId: id } });
    await prisma.streak.deleteMany({ where: { userId: id } });
    await prisma.collectibleBalance.deleteMany({ where: { userId: id } });
    await prisma.virtualBalance.deleteMany({ where: { userId: id } });
    await prisma.pointsLedger.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [user.id, u2.id, u3.id, u4.id] } } });

  console.log("OK: ACTIVE->BURN->LOST transitions + recovery (spend artifact, resume n+1, window-gated); missed-day GM tap burns + stays recoverable; x2 materialised + survives LOST");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
