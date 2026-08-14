// Deposit watcher core (plan §2.5) — pure server lib used by BOTH the poller and API routes;
// the balance reader is injected for testability.
// Never give up on user money — below-floor deposits park indefinitely and release on top-up
// (spec §6.2); cadence slows, observability never stops.
import {
  erc20BalanceOf,
  erc20IncomingSince,
  finalizedBlockNumber,
  PUSD_ADDRESS,
  USDCE_ADDRESS,
  type BalanceReader,
} from "./polygon";
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

// Injected like BalanceReader so tests stay RPC-free: the chain probe reads Transfer logs.
export type IncomingReader = (
  token: string,
  holder: string,
  fromBlock: bigint,
  toBlock: bigint,
) => Promise<{ totalMicro: bigint; transfers: number; lastTxHash: string | null }>;
export type ChainHead = () => Promise<bigint>;
export type ChainProbe = { head: ChainHead; incoming: IncomingReader };

// Free RPC endpoints reject wide eth_getLogs ranges, so a pass advances the cursor by at most this
// much and the next pass continues — the ACCUMULATED totals are the signal, not one wide scan.
const MAX_SCAN_BLOCKS = 9_000n;
// ~1h of Polygon blocks: a deposit sent just before the user declared must still be attributable,
// mirroring the existing min(live, previous FUNDED close) baseline rule (K3 S3 HIGH).
const INITIAL_LOOKBACK_BLOCKS = 2_000n;

// Check one funding attempt. Returns the transition taken.
// WITH a chain probe: transitions come from ATTRIBUTED Transfer logs — an outflow (a trade, a
// withdrawal) can no longer mask a deposit, and the transition names a real transaction (§2.5,
// the last piece of the run-scoped-convergence family).
// WITHOUT one: the original delta-vs-baseline behavior, which is the fallback for tests and for an
// RPC that cannot serve logs. Balances are read and persisted on every path either way — the WRAP
// amount pins to latestUsdceMicro.
export async function checkFundingAttempt(
  prisma: PrismaClient,
  attempt: {
    id: string;
    state: "AWAITING" | "DETECTED";
    declaredAt: Date;
    alertedAt: Date | null;
    baselineUsdceMicro: bigint;
    baselinePusdMicro: bigint;
    scanBlock: bigint | null;
    inUsdceMicro: bigint;
    inPusdMicro: bigint;
    lastDepositTx: string | null;
  },
  wallet: string,
  read: BalanceReader,
  now: Date,
  chain?: ChainProbe,
): Promise<"none" | "detected" | "funded"> {
  // Reader errors propagate — the caller counts them and NEVER transitions state on an error.
  const [usdce, pusd] = await Promise.all([read(USDCE_ADDRESS, wallet), read(PUSD_ADDRESS, wallet)]);

  let sawUsdce: boolean;
  let sawPusd: boolean;
  let cursorData: Record<string, unknown> = {};
  if (chain) {
    const head = await chain.head();
    const lookback = head > INITIAL_LOOKBACK_BLOCKS ? head - INITIAL_LOOKBACK_BLOCKS : 0n;
    const from = attempt.scanBlock === null ? lookback : attempt.scanBlock + 1n;
    const to = from + MAX_SCAN_BLOCKS < head ? from + MAX_SCAN_BLOCKS : head;
    let inUsdce = attempt.inUsdceMicro;
    let inPusd = attempt.inPusdMicro;
    let lastDepositTx = attempt.lastDepositTx;
    if (to >= from) {
      const [u, p] = await Promise.all([
        chain.incoming(USDCE_ADDRESS, wallet, from, to),
        chain.incoming(PUSD_ADDRESS, wallet, from, to),
      ]);
      inUsdce += u.totalMicro;
      inPusd += p.totalMicro;
      // Prefer the pUSD hash when both fired: it is the later leg of the same money.
      lastDepositTx = p.lastTxHash ?? u.lastTxHash ?? lastDepositTx;
    }
    // The cursor advances on EVERY outcome, in the same write as the transition — a second write
    // just to move it would be a window where a crash re-scans and double-counts.
    cursorData = {
      scanBlock: to >= from ? to : attempt.scanBlock,
      inUsdceMicro: inUsdce,
      inPusdMicro: inPusd,
      lastDepositTx,
    };
    sawUsdce = inUsdce > 0n;
    sawPusd = inPusd > 0n;
  } else {
    sawUsdce = usdce - attempt.baselineUsdceMicro > 0n;
    sawPusd = pusd - attempt.baselinePusdMicro > 0n;
  }

  const refresh = { latestUsdceMicro: usdce, latestPusdMicro: pusd, lastCheckedAt: now, ...cursorData };

  // pUSD arrived → FUNDED. pUSD is the only "spendable" signal — the CLOB counts 0 on raw USDC.e.
  if (sawPusd) {
    await prisma.fundingAttempt.update({
      where: { id: attempt.id },
      data: { ...refresh, state: "FUNDED", fundedAt: now },
    });
    return "funded";
  }
  // USDC.e arrived → DETECTED (wrap needed; §6.1 — our app owns the wrap step).
  if (sawUsdce && attempt.state === "AWAITING") {
    await prisma.fundingAttempt.update({ where: { id: attempt.id }, data: { ...refresh, state: "DETECTED" } });
    return "detected";
  }
  await prisma.fundingAttempt.update({ where: { id: attempt.id }, data: refresh });

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
  chain?: ChainProbe,
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
      const outcome = await checkFundingAttempt(prisma, attempt as never, wallet, read, now, chain);
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

// The real probe — the poller passes this, tests pass fakes.
export const rpcChain: ChainProbe = { head: finalizedBlockNumber, incoming: erc20IncomingSince };
