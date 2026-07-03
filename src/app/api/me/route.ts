import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { effectivePoints } from "@/lib/points";
import { evaluateStreak } from "@/lib/streak";
import { getReferralStats } from "@/lib/referral";
import { utcDay, weekdayMon0, streakWindowStartDay } from "@/lib/time";
import {
  SWIPE_CAP,
  SHARDS_PER_ARTIFACT,
  STAKE_CENTS,
  TOPUP_GRANT_CENTS,
  FREE_TOPUP_CASH_GATE_CENTS,
  TOPUP_ARTIFACT_COST,
  ARTIFACT_TOPUP_CASH_GATE_CENTS,
} from "@/lib/config";
import { isDevUser } from "@/lib/dev";
import type { MeResponse } from "@/lib/api-types";

// Account snapshot: balance, points (multiplier-applied), today's swipe count, shards,
// artifacts, streak, login state. Shape pinned by MeResponse (src/lib/api-types.ts).
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const dev = isDevUser(user.email);
  const day = utcDay();
  // Defensive streak sweep on read (idempotent), then fan out the reads in parallel.
  await evaluateStreak(user.id);
  const [points, balance, collectibles, streak, counter, loginMark, unreadResults, referrals] = await Promise.all([
    effectivePoints(prisma, user.id),
    prisma.virtualBalance.findUnique({ where: { userId: user.id } }),
    prisma.collectibleBalance.findUnique({ where: { userId: user.id } }),
    prisma.streak.findUnique({ where: { userId: user.id } }),
    prisma.dailyCounter.findUnique({ where: { userId_utcDay: { userId: user.id, utcDay: day } } }),
    prisma.loginMark.findUnique({ where: { userId_utcDay: { userId: user.id, utcDay: day } } }),
    prisma.bet.count({
      where: { userId: user.id, settlementStatus: { in: ["SETTLED", "VOID"] }, seenAt: null },
    }),
    getReferralStats(user.id),
  ]);

  // Cash/Locked split. balanceCents is the stored total; lockedCents is the held sum (maintained
  // atomically by recordSwipe/settle); Cash is what's spendable right now.
  const balanceCents = balance?.balanceCents ?? 0;
  const lockedCents = balance?.lockedCents ?? 0;
  const cashCents = balanceCents - lockedCents;
  // Free top-up: never used AND Cash < $30 AND Cash can't charge the rest of today's deck.
  const remainingSwipes = Math.max(0, SWIPE_CAP - (counter?.swipeCount ?? 0));
  const freeTopupUsed = balance?.freeTopupUsed ?? false;
  const freeTopupAvailable =
    !freeTopupUsed && cashCents < FREE_TOPUP_CASH_GATE_CENTS && cashCents < remainingSwipes * STAKE_CENTS;

  const body: MeResponse = {
    user: { id: user.id, email: user.email, twitter: user.twitterHandle, authProvider: user.authProvider, referralCode: user.referralCode },
    balanceCents, // total = Cash + Locked
    cashCents, // spendable now
    lockedCents, // Σ pending stakes
    stakeCents: STAKE_CENTS, // client gates "cash >= stake" without hardcoding
    topup: {
      freeTopupUsed,
      freeTopupAvailable,
      // Artifact top-up: holds >=1 artifact AND Cash below the $50 gate (a top-up bails out a low
      // balance, not a full one). Server-authoritative — topUp() re-derives the same gate.
      artifactTopupAvailable:
        (collectibles?.artifacts ?? 0) >= TOPUP_ARTIFACT_COST && cashCents < ARTIFACT_TOPUP_CASH_GATE_CENTS,
      grantCents: TOPUP_GRANT_CENTS,
      artifactCost: TOPUP_ARTIFACT_COST,
      artifactCashGateCents: ARTIFACT_TOPUP_CASH_GATE_CENTS,
    },
    points: { total: points.total, breakdown: points.breakdown, bonusFromX2: points.bonusFromX2 },
    swipes: { used: counter?.swipeCount ?? 0, cap: SWIPE_CAP },
    skips: {
      usedToday: counter?.skipCount ?? 0,
      // Skips are now always free + unlimited (no shard cost) — the client never blocks them.
      nextIsFree: true,
      shardCost: 0,
    },
    dev,
    shards: collectibles?.shards ?? 0,
    artifacts: collectibles?.artifacts ?? 0,
    shardsPerArtifact: SHARDS_PER_ARTIFACT, // so clients render the "/N" denominator from the server, not a hardcode
    // Cosmetics. Coalesce when the row is absent (lazily created on first shard) — a brand-new user
    // still owns + has equipped the free Classic skin.
    skins: { owned: collectibles?.ownedSkins ?? ["classic"], equipped: collectibles?.equippedSkin ?? "classic" },
    streak: {
      level: streak?.currentLevel ?? 0,
      state: streak?.state ?? "ACTIVE",
      recoverableUntil: streak?.recoverableUntil?.toISOString() ?? null,
      // GM grid renders a fixed Mon→Sun week; these locate the user on it:
      //  - todayWeekday: which column is "today"
      //  - windowStartWeekday: where this user's personal 7-day window begins (the cutoff)
      todayWeekday: weekdayMon0(day),
      windowStartWeekday: weekdayMon0(
        streakWindowStartDay(streak?.currentLevel ?? 0, streak?.lastQualifiedDay ?? null, day),
      ),
    },
    loginMarkedToday: !!loginMark,
    unreadResults,
    referrals,
    // Brand-new account: streak never started AND no GM today → skip the open ritual (deck first).
    isNewUser: (streak?.currentLevel ?? 0) === 0 && !loginMark,
  };
  return NextResponse.json(body);
}
