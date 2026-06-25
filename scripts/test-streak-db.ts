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

  // cleanup
  for (const id of [user.id, u2.id]) {
    await prisma.streakEvent.deleteMany({ where: { userId: id } });
    await prisma.streak.deleteMany({ where: { userId: id } });
    await prisma.collectibleBalance.deleteMany({ where: { userId: id } });
    await prisma.virtualBalance.deleteMany({ where: { userId: id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [user.id, u2.id] } } });

  console.log("OK: ACTIVE->BURN->LOST transitions + recovery (spend artifact, resume n+1, window-gated)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
