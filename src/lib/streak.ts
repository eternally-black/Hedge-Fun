import type { Prisma, StreakState } from "@prisma/client";
import { prisma } from "./prisma";
import { utcDay, diffDays } from "./time";
import { RECOVERY_WINDOW_DAYS } from "./config";

type Db = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Pure transition core (DB-free, unit-testable). Given current streak state and
// the day being qualified, returns the next streak fields. This is the single
// source of truth for the F6/F7 state machine.
//
// Rules (canonical):
//  - qualify = login + deck-open both present for utcDay (caller checks; here we
//    assume the day qualifies).
//  - ACTIVE, gap==0 -> no-op (already counted today).
//  - ACTIVE, gap==1 -> level++ (consecutive day).
//  - ACTIVE, gap>=2 -> a day was missed: that's handled by evaluateBurn before a
//    new qualify; on qualify-after-gap from ACTIVE we treat it as a fresh start.
//  - BURNED_RECOVERABLE + qualify (no recovery) -> fresh start (level 1).
//  - LOST + qualify -> fresh start (level 1).
// ---------------------------------------------------------------------------
export interface StreakSnapshot {
  currentLevel: number;
  state: StreakState;
  lastQualifiedDay: string | null;
}

export function applyQualify(
  s: StreakSnapshot,
  day: string,
): StreakSnapshot {
  // Same day already qualified — idempotent no-op.
  if (s.lastQualifiedDay === day) return s;

  if (s.state === "ACTIVE" && s.lastQualifiedDay) {
    const gap = diffDays(day, s.lastQualifiedDay);
    if (gap === 1) {
      return { currentLevel: s.currentLevel + 1, state: "ACTIVE", lastQualifiedDay: day };
    }
    // gap >= 2 from an ACTIVE streak that wasn't burned yet -> fresh start.
    return { currentLevel: 1, state: "ACTIVE", lastQualifiedDay: day };
  }

  // First ever qualify, or restart after burn/lost without recovery.
  return { currentLevel: 1, state: "ACTIVE", lastQualifiedDay: day };
}

// Burn evaluation (DB-free). Given the streak and "today", decide burn/lost.
//  - ACTIVE + missed yesterday (today is >=2 days past lastQualifiedDay) -> BURNED_RECOVERABLE.
//  - BURNED_RECOVERABLE + now past recoverableUntil -> LOST.
export function evaluateBurn(
  s: { state: StreakState; lastQualifiedDay: string | null; recoverableUntil: Date | null },
  now: Date,
): { state: StreakState; burnedAt: Date | null; recoverableUntil: Date | null; currentLevelReset: boolean } {
  const today = utcDay(now);

  if (s.state === "ACTIVE" && s.lastQualifiedDay) {
    const gap = diffDays(today, s.lastQualifiedDay);
    if (gap >= 2) {
      // A full day was skipped. Burn, open the recovery window.
      const recoverableUntil = new Date(now.getTime() + RECOVERY_WINDOW_DAYS * 86_400_000);
      return { state: "BURNED_RECOVERABLE", burnedAt: now, recoverableUntil, currentLevelReset: false };
    }
  }

  if (s.state === "BURNED_RECOVERABLE" && s.recoverableUntil && now > s.recoverableUntil) {
    return { state: "LOST", burnedAt: null, recoverableUntil: null, currentLevelReset: true };
  }

  return { state: s.state, burnedAt: null, recoverableUntil: s.recoverableUntil, currentLevelReset: false };
}

// ---------------------------------------------------------------------------
// DB-backed operations.
// ---------------------------------------------------------------------------

// Qualify today for the streak. The day = the GM tap (login + opening the app are one
// action in the MVP — see H1: the separate deck-open leg was dead, so it's collapsed).
// Idempotent: same day re-qualifies to a no-op via applyQualify.
export async function qualifyDay(
  userId: string,
  at?: Date,
): Promise<{ qualifiedToday: boolean; state: StreakState; currentLevel: number }> {
  const day = utcDay(at);

  return prisma.$transaction(async (tx) => {
    const streak = await tx.streak.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    const next = applyQualify(
      { currentLevel: streak.currentLevel, state: streak.state, lastQualifiedDay: streak.lastQualifiedDay },
      day,
    );
    const qualifiedToday = next.lastQualifiedDay === day && streak.lastQualifiedDay !== day;

    if (qualifiedToday) {
      await tx.streak.update({
        where: { userId },
        data: {
          currentLevel: next.currentLevel,
          state: next.state,
          lastQualifiedDay: day,
          burnedAt: null,
          recoverableUntil: null,
        },
      });
      await tx.streakEvent.upsert({
        where: { userId_utcDay_type: { userId, utcDay: day, type: "QUALIFIED" } },
        create: {
          userId,
          utcDay: day,
          type: "QUALIFIED",
          levelBefore: streak.currentLevel,
          levelAfter: next.currentLevel,
        },
        update: {},
      });
    }

    return { qualifiedToday, state: next.state, currentLevel: next.currentLevel };
  });
}

// Idempotent burn/lost sweep. Safe to run on every poll tick and on read.
export async function evaluateStreak(userId: string, at: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const streak = await tx.streak.findUnique({ where: { userId } });
    if (!streak) return null;

    const v = evaluateBurn(streak, at);
    if (v.state === streak.state) return streak;

    const updated = await tx.streak.update({
      where: { userId },
      data: {
        state: v.state,
        burnedAt: v.burnedAt ?? streak.burnedAt,
        recoverableUntil: v.recoverableUntil,
        currentLevel: v.currentLevelReset ? 0 : streak.currentLevel,
      },
    });
    await tx.streakEvent.upsert({
      where: { userId_utcDay_type: { userId, utcDay: utcDay(at), type: v.state === "LOST" ? "LOST" : "BURNED" } },
      create: {
        userId,
        utcDay: utcDay(at),
        type: v.state === "LOST" ? "LOST" : "BURNED",
        levelBefore: streak.currentLevel,
        levelAfter: updated.currentLevel,
      },
      update: {},
    });
    return updated;
  });
}

// Recover a burned streak: spend 1 artifact, resume at n+1 (n = level before burn).
// Fixes ONE gap; only valid in BURNED_RECOVERABLE within the window. One artifact per recovery.
export async function recoverStreak(
  userId: string,
  at: Date = new Date(),
): Promise<{ recovered: boolean; reason?: string; currentLevel: number }> {
  return prisma.$transaction(async (tx) => {
    const streak = await tx.streak.findUnique({ where: { userId } });
    if (!streak) return { recovered: false, reason: "no_streak", currentLevel: 0 };
    if (streak.state !== "BURNED_RECOVERABLE")
      return { recovered: false, reason: "not_recoverable", currentLevel: streak.currentLevel };
    if (streak.recoverableUntil && at > streak.recoverableUntil)
      return { recovered: false, reason: "window_expired", currentLevel: streak.currentLevel };

    const bal = await tx.collectibleBalance.findUnique({ where: { userId } });
    if (!bal || bal.artifacts < 1)
      return { recovered: false, reason: "no_artifact", currentLevel: streak.currentLevel };

    await tx.collectibleBalance.update({
      where: { userId },
      data: { artifacts: { decrement: 1 } },
    });

    const newLevel = streak.currentLevel + 1; // resume at n+1
    const day = utcDay(at);
    await tx.streak.update({
      where: { userId },
      data: {
        state: "ACTIVE",
        currentLevel: newLevel,
        lastQualifiedDay: day,
        burnedAt: null,
        recoverableUntil: null,
        recoveredCount: { increment: 1 },
      },
    });
    await tx.streakEvent.upsert({
      where: { userId_utcDay_type: { userId, utcDay: day, type: "RECOVERED" } },
      create: {
        userId,
        utcDay: day,
        type: "RECOVERED",
        levelBefore: streak.currentLevel,
        levelAfter: newLevel,
        artifactUsed: true,
      },
      update: {},
    });
    return { recovered: true, currentLevel: newLevel };
  });
}
