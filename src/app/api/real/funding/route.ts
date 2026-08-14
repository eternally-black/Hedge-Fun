// POST /api/real/funding — declare "I sent a deposit": snapshot BASELINE balances now (delta
// detection starts from here; §6.2 — bridge /status is a hint at most, nowhere in this machine).
// GET /api/real/funding — the caller's active attempt, for the funding screen.
// Deltas = latest − baseline, BigInt, serialized as strings.
import { NextResponse } from "next/server";
import { Prisma, type FundingAttempt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { erc20BalanceOf, PUSD_ADDRESS, USDCE_ADDRESS } from "@/lib/polygon";

const min = (a: bigint, b: bigint) => (a < b ? a : b);

function serializeAttempt(attempt: FundingAttempt) {
  return {
    attempt: {
      id: attempt.id,
      state: attempt.state,
      declaredAt: attempt.declaredAt.toISOString(),
      fundedAt: attempt.fundedAt ? attempt.fundedAt.toISOString() : null,
      usdceDeltaMicro: (attempt.latestUsdceMicro - attempt.baselineUsdceMicro).toString(),
      pusdDeltaMicro: (attempt.latestPusdMicro - attempt.baselinePusdMicro).toString(),
    },
  };
}

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isRealMoneyEligible(user)) {
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }
  if (!hasRealConsent(user)) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const wallet = user.depositWalletAddress;
  if (!wallet) {
    return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });
  }

  let usdce: bigint;
  let pusd: bigint;
  try {
    [usdce, pusd] = await Promise.all([
      erc20BalanceOf(USDCE_ADDRESS, wallet),
      erc20BalanceOf(PUSD_ADDRESS, wallet),
    ]);
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/funding", stage: "baseline-read" });
    return NextResponse.json({ error: "chain_unavailable" }, { status: 503 });
  }

  // Baseline = min(live, previous FUNDED attempt's closing balance, per token; 0 with no history).
  // A live-only baseline embeds a declare→delivery ordering the API can't enforce: a deposit that
  // LANDED before the user tapped "I've sent it" would be absorbed into baseline and never fire
  // (K3, S3 review — HIGH). min() keeps both properties: pre-declared arrivals count as THIS
  // attempt's delta, while residue already accounted by the previous attempt does not; and if
  // spending (S6+) drained the wallet below the old close, the baseline floors at live so future
  // top-ups count from reality.
  const prev = await prisma.fundingAttempt.findFirst({
    where: { userId: user.id, state: "FUNDED" },
    orderBy: { declaredAt: "desc" },
    select: { latestUsdceMicro: true, latestPusdMicro: true },
  });
  const baseUsdce = min(usdce, prev?.latestUsdceMicro ?? 0n);
  const basePusd = min(pusd, prev?.latestPusdMicro ?? 0n);

  const now = new Date();
  try {
    const attempt = await prisma.fundingAttempt.create({
      data: {
        userId: user.id,
        state: "AWAITING",
        baselineUsdceMicro: baseUsdce,
        baselinePusdMicro: basePusd,
        latestUsdceMicro: usdce,
        latestPusdMicro: pusd,
        declaredAt: now,
        // NOT now: with a pre-landed deposit the very next watcher tick must be allowed to fire.
        lastCheckedAt: null,
      },
    });
    return NextResponse.json(serializeAttempt(attempt));
  } catch (e) {
    // P2002 = funding_attempts_one_active partial unique — return the active attempt (idempotent).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.fundingAttempt.findFirst({
        where: { userId: user.id, state: { not: "FUNDED" } },
        orderBy: { declaredAt: "desc" },
      });
      if (existing) return NextResponse.json(serializeAttempt(existing));
    }
    throw e;
  }
}

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isRealMoneyEligible(user)) {
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }
  if (!hasRealConsent(user)) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }

  const attempt = await prisma.fundingAttempt.findFirst({
    where: { userId: user.id, state: { not: "FUNDED" } },
    orderBy: { declaredAt: "desc" },
  });
  if (!attempt) return NextResponse.json({ attempt: null });

  // Re-arm on funding-screen open (plan §2.5): an old attempt may be hours into the slow sweep —
  // clearing lastCheckedAt makes the next poller tick (≤60s) check it regardless of tier.
  if (attempt.lastCheckedAt && Date.now() - attempt.lastCheckedAt.getTime() > 60_000) {
    await prisma.fundingAttempt.update({ where: { id: attempt.id }, data: { lastCheckedAt: null } });
  }
  return NextResponse.json(serializeAttempt(attempt));
}
