// POST /api/real/funding — declare "I sent a deposit": snapshot BASELINE balances now (delta
// detection starts from here; §6.2 — bridge /status is a hint at most, nowhere in this machine).
// GET /api/real/funding — the caller's active attempt, for the funding screen.
// Deltas = latest − baseline, BigInt, serialized as strings.
import { NextResponse } from "next/server";
import { Prisma, type FundingAttempt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible } from "@/lib/real";
import { erc20BalanceOf, PUSD_ADDRESS, USDCE_ADDRESS } from "@/lib/polygon";

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
  } catch {
    return NextResponse.json({ error: "chain_unavailable" }, { status: 503 });
  }

  const now = new Date();
  try {
    const attempt = await prisma.fundingAttempt.create({
      data: {
        userId: user.id,
        state: "AWAITING",
        baselineUsdceMicro: usdce,
        baselinePusdMicro: pusd,
        latestUsdceMicro: usdce,
        latestPusdMicro: pusd,
        declaredAt: now,
        lastCheckedAt: now,
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

  const attempt = await prisma.fundingAttempt.findFirst({
    where: { userId: user.id, state: { not: "FUNDED" } },
    orderBy: { declaredAt: "desc" },
  });
  if (!attempt) return NextResponse.json({ attempt: null });
  return NextResponse.json(serializeAttempt(attempt));
}
