// POST /api/real/funding — declare "I sent a deposit": snapshot BASELINE balances now (delta
// detection starts from here; §6.2 — bridge /status is a hint at most, nowhere in this machine).
// GET /api/real/funding — the caller's active attempt, for the funding screen.
// Deltas = latest − baseline, BigInt, serialized as strings.
import { NextResponse } from "next/server";
import { Prisma, type FundingAttempt } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
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
  // Two chain reads per call — bounded so a loop cannot exhaust the shared RPC.
  if (!rateLimit(`real-funding:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
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
    select: { latestUsdceMicro: true, latestPusdMicro: true, scanBlock: true },
  });
  const baseUsdce = min(usdce, prev?.latestUsdceMicro ?? 0n);
  const basePusd = min(pusd, prev?.latestPusdMicro ?? 0n);

  // Deposit CURSOR, the log-branch twin of the baseline above. The watcher decides FUNDED from
  // ACCUMULATED Transfer logs and never consults baseline*Micro on that path, so the baseline rule
  // protects nothing there: a fresh attempt with a null cursor scans back INITIAL_LOOKBACK_BLOCKS,
  // and a deposit the PREVIOUS attempt already spent its FUNDED on is still inside that window — it
  // would fund this attempt too, with nothing new sent. Carrying the previous cursor forward is what
  // makes each Transfer log count exactly once.
  //
  // Carried forward and deliberately NOT floored to a recent block. Flooring at
  // `head - INITIAL_LOOKBACK_BLOCKS` looks like a kindness to a long-dormant account, but it skips
  // blocks nobody has scanned: money sent at block 5000, previous cursor at 1000, declared two hours
  // later, starts the scan at 5400 and the Transfer is never seen at all — and since the log path
  // ignores the balance baseline, nothing else catches it either. The deposit simply never arrives.
  // Catching up is bounded and self-healing instead: MAX_SCAN_BLOCKS per pass on a 60s cadence walks
  // roughly five hours of Polygon per minute, so even a months-idle account converges in a couple of
  // hours — and it can never step over a block it has not read.
  const scanBlock = prev?.scanBlock ?? null;

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
        scanBlock,
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

  const active = await prisma.fundingAttempt.findFirst({
    where: { userId: user.id, state: { not: "FUNDED" } },
    orderBy: { declaredAt: "desc" },
  });
  if (active) {
    // Re-arm on funding-screen open (plan §2.5): an old attempt may be hours into the slow sweep —
    // clearing lastCheckedAt makes the next poller tick (≤60s) check it regardless of tier.
    if (active.lastCheckedAt && Date.now() - active.lastCheckedAt.getTime() > 60_000) {
      await prisma.fundingAttempt.update({ where: { id: active.id }, data: { lastCheckedAt: null } });
    }
    return NextResponse.json(serializeAttempt(active));
  }

  // Nothing active: return the newest attempt whatever its state, WITHOUT re-arming (a FUNDED one
  // has nothing left to watch). Returning null here instead — as this route used to — made a
  // successful deposit read as "no deposit declared yet" on the console, which invites a second one.
  const newest = await prisma.fundingAttempt.findFirst({
    where: { userId: user.id },
    orderBy: { declaredAt: "desc" },
  });
  return NextResponse.json(newest ? serializeAttempt(newest) : { attempt: null });
}
