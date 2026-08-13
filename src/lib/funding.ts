// Deposit watcher core (plan §2.5) — pure server lib used by BOTH the poller and API routes;
// the balance reader is injected for testability.
// Never give up on user money — below-floor deposits park indefinitely and release on top-up
// (spec §6.2); cadence slows, observability never stops.
import { erc20BalanceOf, PUSD_ADDRESS, USDCE_ADDRESS, type BalanceReader } from "./polygon";
import { sendOpsTelegram } from "./glitchtip";
import type { PrismaClient } from "@prisma/client";

// Tiered recheck cadence by deposit age (age = now - declaredAt):
// < 1h → 60s; < 24h → 5 min; < 7d → 30 min; else → 6h slow sweep.
export function fundingCheckDue(a: { declaredAt: Date; lastCheckedAt: Date | null }, now: Date): boolean {
  if (a.lastCheckedAt === null) return true;
  const ageMs = now.getTime() - a.declaredAt.getTime();
  let intervalMs: number;
  if (ageMs < 60 * 60 * 1000) intervalMs = 60 * 1000;
  else if (ageMs < 24 * 60 * 60 * 1000) intervalMs = 5 * 60 * 1000;
  else if (ageMs < 7 * 24 * 60 * 60 * 1000) intervalMs = 30 * 60 * 1000;
  else intervalMs = 6 * 60 * 60 * 1000;
  return now.getTime() - a.lastCheckedAt.getTime() >= intervalMs;
}

// Check one funding attempt against live balances. Returns the transition taken.
// DELTAS vs the declare-time baselines, never nonzero-balance — residual balances lie.
export async function checkFundingAttempt(
  prisma: PrismaClient,
  attempt: {
    id: string;
    state: "AWAITING" | "DETECTED";
    declaredAt: Date;
    alertedAt: Date | null;
    baselineUsdceMicro: bigint;
    baselinePusdMicro: bigint;
  },
  wallet: string,
  read: BalanceReader,
  now: Date,
): Promise<"none" | "detected" | "funded"> {
  // Reader errors propagate — the caller counts them and NEVER transitions state on an error.
  const [usdce, pusd] = await Promise.all([read(USDCE_ADDRESS, wallet), read(PUSD_ADDRESS, wallet)]);

  const usdceDelta = usdce - attempt.baselineUsdceMicro;
  const pusdDelta = pusd - attempt.baselinePusdMicro;

  // pUSD delta → FUNDED. pUSD is the only "spendable" signal — the CLOB counts 0 on raw USDC.e.
  if (pusdDelta > 0n) {
    await prisma.fundingAttempt.update({
      where: { id: attempt.id },
      data: { state: "FUNDED", fundedAt: now, latestUsdceMicro: usdce, latestPusdMicro: pusd, lastCheckedAt: now },
    });
    return "funded";
  }

  // USDC.e delta → DETECTED (wrap needed; §6.1 — our app owns the wrap step).
  if (usdceDelta > 0n && attempt.state === "AWAITING") {
    await prisma.fundingAttempt.update({
      where: { id: attempt.id },
      data: { state: "DETECTED", latestUsdceMicro: usdce, latestPusdMicro: pusd, lastCheckedAt: now },
    });
    return "detected";
  }

  await prisma.fundingAttempt.update({
    where: { id: attempt.id },
    data: { latestUsdceMicro: usdce, latestPusdMicro: pusd, lastCheckedAt: now },
  });

  // Parked-deposit ops alert, once: this is exactly the §6.2 below-floor scenario — to the user it
  // looks like theft, so ops hears about it while the UI shows "check amount (≥$5) and address".
  if (
    attempt.state === "AWAITING" &&
    now.getTime() - attempt.declaredAt.getTime() > 60 * 60 * 1000 &&
    attempt.alertedAt === null
  ) {
    try {
      await sendOpsTelegram(`[funding] parked deposit: attempt ${attempt.id} still AWAITING after 60m (wallet ${wallet})`);
      await prisma.fundingAttempt.update({ where: { id: attempt.id }, data: { alertedAt: now } });
    } catch {
      // Alert failure must not fail the check; retried next due cycle.
    }
  }

  return "none";
}

// Watch all non-FUNDED attempts. Sequential loop — the pending set is tiny at alpha scale;
// ponytail: multicall3 batching is the scale-up path when it isn't.
export async function watchFunding(
  prisma: PrismaClient,
  read: BalanceReader = erc20BalanceOf,
  now: Date = new Date(),
): Promise<{ checked: number; detected: number; funded: number; errors: number }> {
  const attempts = await prisma.fundingAttempt.findMany({
    where: { state: { not: "FUNDED" } },
    include: { user: { select: { depositWalletAddress: true } } },
  });

  const result = { checked: 0, detected: 0, funded: 0, errors: 0 };
  for (const attempt of attempts) {
    const wallet = attempt.user.depositWalletAddress;
    if (!wallet) continue;
    if (!fundingCheckDue(attempt, now)) continue;
    try {
      const outcome = await checkFundingAttempt(prisma, attempt as never, wallet, read, now);
      result.checked++;
      if (outcome === "detected") result.detected++;
      if (outcome === "funded") result.funded++;
    } catch {
      // RPC errors are not "no deposit" — count and move on, no state transition.
      result.errors++;
    }
  }
  return result;
}
