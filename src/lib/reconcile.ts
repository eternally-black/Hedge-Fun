// Order reconciliation (plan §2.1 step 6 + pre-Gate-0 item 4): an OrderAttempt left in POSTED is
// an unresolved submission — the receipt was ambiguous, or it was matched but priced from an
// ESTIMATE. This module resolves it against the EXCHANGE's own records and books the truth.
// SDK-free by design: the caller supplies a `probe` callback (the same shape as workflow.ts's
// `runScoped` verdict), so the tests drive it with fakes and the poller never imports the SDK.
import type { PrismaClient, OrderAttempt } from "@prisma/client";
import { bookEntryFills, bookExitFills, receiptFillKey, trueUpAttemptFee } from "./orders";
import { feePerShareMicro } from "./quote";

export interface TradeRecord {
  id: string; // exchange trade id
  priceBp: number; // execution price, basis points
  sizeMicro: bigint; // shares, micro
  feeRateBp: number; // the fee RATE the exchange applied to THIS trade, basis points
  ts: Date;
}

export interface OrderVerdict {
  terminal: boolean; // the exchange says this order can no longer match
  matchedSharesMicro: bigint; // cumulative matched size per the exchange
  trades: TradeRecord[]; // the trade records for THIS order (may be empty)
}

export type ReconcilableAttempt = OrderAttempt & { userId: string; marketId: string };
// null = unknown / unreachable — never a state change.
export type OrderProbe = (attempt: ReconcilableAttempt) => Promise<OrderVerdict | null>;
export type ReconcileOutcome = "unknown" | "pending" | "killed" | "booked";

export async function reconcileAttempt(
  prisma: PrismaClient,
  attempt: ReconcilableAttempt,
  probe: OrderProbe,
  feeExpMilli: number,
): Promise<ReconcileOutcome> {
  const verdict = await probe(attempt);
  if (!verdict) return "unknown"; // an unreachable exchange must never mutate money state

  const dir = attempt.dir === "EXIT" ? "EXIT" : "ENTRY";
  // Requested size lives in the approved params, read exactly as the submit route reads it.
  const params = attempt.approvedParams as { betSide?: "YES" | "NO"; sharesMicro?: string } | null;
  const requested = BigInt(params?.sharesMicro ?? "0");
  const betSide = params?.betSide === "NO" ? "NO" : "YES";

  if (verdict.matchedSharesMicro === 0n) {
    if (!verdict.terminal) return "pending"; // still matchable — only a terminal verdict kills
    if (dir === "EXIT") await bookExitFills(prisma, attempt, requested, []);
    else await bookEntryFills(prisma, attempt, betSide, requested, []);
    return "killed";
  }

  // Matched, but no trade records came back: we cannot price the fill honestly, and a guessed
  // price on a money ledger is worse than a slow one. Leave it POSTED for the next pass.
  if (verdict.trades.length === 0) return "unknown";

  const sharesMicro = verdict.trades.reduce((s, t) => s + t.sizeMicro, 0n);
  // Notional per trade, BigInt only — ENTRY rounds cost UP, EXIT rounds proceeds DOWN.
  const amountMicro = verdict.trades.reduce(
    (s, t) =>
      s +
      (dir === "ENTRY"
        ? (t.sizeMicro * BigInt(t.priceBp) + 9_999n) / 10_000n
        : (t.sizeMicro * BigInt(t.priceBp)) / 10_000n),
    0n,
  );
  // Fee PER TRADE at that trade's own price and rate, rounded up. The fee is convex in price, so
  // the exchange charges it per execution — this is the authoritative number that replaces the
  // intent-time estimate (which could only see the aggregate price).
  const feeMicro = verdict.trades.reduce(
    (s, t) => s + (BigInt(feePerShareMicro(t.priceBp, t.feeRateBp, feeExpMilli)) * t.sizeMicro + 999_999n) / 1_000_000n,
    0n,
  );
  const priceBp =
    dir === "ENTRY"
      ? Number((amountMicro * 10_000n + sharesMicro - 1n) / sharesMicro)
      : Number((amountMicro * 10_000n) / sharesMicro);

  const fill = {
    // The same keying the receipt path uses: a receipt row and a reconciliation row covering the
    // same trade set dedup against each other instead of double-booking.
    externalFillId: receiptFillKey(
      verdict.trades.map((t) => t.id),
      attempt.externalOrderId ?? attempt.id,
      sharesMicro,
    ),
    sharesMicro,
    amountMicro,
    feeMicro,
    priceBp,
    ts: verdict.trades.reduce((latest, t) => (t.ts > latest ? t.ts : latest), verdict.trades[0].ts),
  };

  // Cumulative: these are the ORDER's totals, so the booker writes only what is missing.
  if (dir === "EXIT") await bookExitFills(prisma, attempt, requested, [fill], { cumulative: true });
  else await bookEntryFills(prisma, attempt, betSide, requested, [fill], { cumulative: true });

  // The estimate dies here: whatever the receipt guessed, the charged total is now on the ledger.
  await trueUpAttemptFee(prisma, attempt, feeMicro);
  return "booked";
}

// Sweep the unresolved attempts. Sequential on purpose — this is the money path at alpha volume,
// and one attempt's failure must not abort the others (it counts as unknown and the next pass
// retries it).
export async function reconcileStuckAttempts(
  prisma: PrismaClient,
  probe: OrderProbe,
  opts: { now?: Date; minAgeMs?: number; limit?: number; feeExpMilli?: number } = {},
): Promise<Record<ReconcileOutcome, number> & { scanned: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.minAgeMs ?? 10 * 60_000));
  const attempts = await prisma.orderAttempt.findMany({
    // POSTED = the ambiguous case still awaiting a verdict. FILLED/PARTIAL are already booked and
    // are revisited for ONE reason: their fee is the formula ESTIMATE until the exchange's own
    // trade records replace it (the booking is order-cumulative, so a re-run books a zero delta,
    // and the true-up is idempotent once the ledger carries the charged amount). A SUBMITTING
    // attempt has no order id to ask about. The 48-hour floor stops settled history from being
    // rescanned forever.
    where: {
      state: { in: ["POSTED", "FILLED", "PARTIAL"] },
      externalOrderId: { not: null },
      updatedAt: { lt: cutoff, gt: new Date(now.getTime() - 48 * 60 * 60_000) },
    },
    orderBy: { updatedAt: "asc" },
    take: opts.limit ?? 20,
  });

  const counts: Record<ReconcileOutcome, number> = { unknown: 0, pending: 0, killed: 0, booked: 0 };
  for (const attempt of attempts) {
    try {
      // The fee exponent is per market (fees.ts cache); the fallback keeps a market that was never
      // refreshed from blocking reconciliation.
      const market = await prisma.market.findUnique({
        where: { id: attempt.marketId },
        select: { feeExpMilli: true },
      });
      counts[await reconcileAttempt(prisma, attempt, probe, market?.feeExpMilli ?? opts.feeExpMilli ?? 1000)]++;
    } catch {
      counts.unknown++;
    }
  }
  return { ...counts, scanned: attempts.length };
}
