// Order reconciliation (plan §2.1 step 6 + pre-Gate-0 item 4): an OrderAttempt left in POSTED is
// an unresolved submission — the receipt was ambiguous, or it was matched but priced from an
// ESTIMATE. This module resolves it against the EXCHANGE's own records and books the truth.
// SDK-free by design: the caller supplies a `probe` callback (the same shape as workflow.ts's
// `runScoped` verdict), so the tests drive it with fakes and the poller never imports the SDK.
import type { PrismaClient, OrderAttempt } from "@prisma/client";
import { bookEntryFills, bookExitFills, receiptFillKey, trueUpAttemptFee, REPORTED_UNVERIFIED_PREFIX } from "./orders";
export { REPORTED_UNVERIFIED_PREFIX };
import { feePerShareMicro } from "./quote";
import { REAL_FEE_FALLBACK_RATE_BP } from "./config";
import { readSweepCursor, writeSweepCursor, type SweepCursorValue } from "./sweep-cursor";

const RECONCILE_CURSOR = "polymarket-order-reconcile-v1";

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
  const params = attempt.approvedParams as {
    betSide?: "YES" | "NO";
    sharesMicro?: string;
    feeRateBp?: number;
    feeExpMilli?: number;
  } | null;
  const betSide = params?.betSide === "NO" ? "NO" : "YES";

  // FILLED-vs-PARTIAL is judged against the size actually SIGNED, not the intent's PREDICTED
  // sharesMicro — the same rule /api/real/submit already follows, and for the same reason: the SDK
  // re-sizes and decimal-caps the order before signing, so the signed size sits a hair below the
  // prediction. A fully matched order came back one micro-share short of the prediction and was
  // labelled PARTIAL (live, 2026-08-17: 1.333332 signed, 1.333333 predicted). BUY: takerAmount is
  // the shares. SELL: makerAmount is. Falls back to the prediction for rows with no signed payload.
  const signed = attempt.signedOrder as unknown as { makerAmount?: string; takerAmount?: string } | null;
  const signedSize = signed ? (dir === "EXIT" ? signed.makerAmount : signed.takerAmount) : undefined;
  let requested = BigInt(params?.sharesMicro ?? "0");
  if (typeof signedSize === "string" && /^\d+$/.test(signedSize)) requested = BigInt(signedSize);

  // The PLATFORM fee rate is the MARKET's, and it does not come from the trade record. That field
  // (`feeRateBps` on a ClobTrade) read 0 on a fill the chain shows paid $0.012490 — it describes
  // the BUILDER's rate, which is zero for us, not the platform's. Reading it as the platform rate
  // booked every real fill at zero fee and understated the position's cost basis by exactly the
  // fee. The intent stored the rate it quoted with (fetchMarketInfo at intent time, 500bp on that
  // market), and that is both the honest number and the one the user's cap was built from.
  // Fallback RATE, not 0: a pre-params attempt reconciling at zero fee would hand trueUpAttemptFee
  // a zero total, which OVERWRITES an already-correct booked fee and overstates realized PnL by it.
  const rateBp = typeof params?.feeRateBp === "number" ? params.feeRateBp : REAL_FEE_FALLBACK_RATE_BP;
  const expMilli = typeof params?.feeExpMilli === "number" ? params.feeExpMilli : feeExpMilli;

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
  // Fee PER TRADE at that trade's own EXECUTION price, rounded up. The fee is convex in price, so
  // the exchange charges it per execution — this is what makes the reconciled number better than
  // the intent's estimate, which could only see the aggregate price. The rate is the market's (see
  // above); only the price varies per trade.
  const feeMicro = verdict.trades.reduce(
    (s, t) => s + (BigInt(feePerShareMicro(t.priceBp, rateBp, expMilli)) * t.sizeMicro + 999_999n) / 1_000_000n,
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
  // The exchange's terminal trade records are the final word, so they also stamp the attempt and
  // the sweep stops re-probing it. Both happen in ONE transaction under the position lock, and only
  // if this read covers everything already booked: a concurrent run that read the fill when it was
  // still partly indexed must neither shrink the fee to the partial fill's nor close the attempt.
  await trueUpAttemptFee(prisma, attempt, feeMicro, { observedSharesMicro: sharesMicro, stampReconciled: verdict.terminal });
  return "booked";
}

// ------------------------------------------------------------------ orphan discovery
// A browser that posts an order and dies before reporting its id leaves a LIVE order whose
// OrderAttempt row has externalOrderId = null. Every reconcile scan filters on that column being
// non-null, so the row is invisible to reconciliation, and the partial unique index (one in-flight
// attempt per user+market) wedges that market for that user forever. This is the path that closes
// it: ask the exchange whether the order exists, then adopt it or kill the attempt.
export type OrderDiscovery =
  // { orderId, order } = found it, verified; `order` is the record to persist verbatim
  | { orderId: string; order: unknown }
  // { orderId: null } = the exchange definitively has no such order (nothing was posted, or it
  // died with no match) — a licence to kill the attempt and give the market slot back
  | { orderId: null }
  // null = unknown / unreachable → never a state change
  | null;
export type OrphanDiscover = (attempt: ReconcilableAttempt) => Promise<OrderDiscovery>;
export type OrphanOutcome = "unknown" | "adopted" | "killed";

export async function resolveOrphanAttempt(
  prisma: PrismaClient,
  attempt: ReconcilableAttempt,
  discover: OrphanDiscover,
  probe: OrderProbe,
  feeExpMilli: number,
): Promise<OrphanOutcome> {
  if (attempt.externalOrderId) return "unknown"; // not an orphan — the ordinary reconcile path owns it
  const found = await discover(attempt);
  if (!found) return "unknown"; // an unreachable exchange must never mutate money state

  if (found.orderId === null) {
    // Nothing exists at the exchange, so no money moved. Booking zero fills is the existing
    // terminal path: SUBMITTING → KILLED plus the reserved daily-cap slot handed back.
    // This snapshot was read before discovery, and the row may have been adopted since (the
    // reported-id fast pass, or a re-report): the kill matches only a row that is STILL unbound
    // and SUBMITTING, in the same statement, and the outcome is read back rather than assumed.
    const params = attempt.approvedParams as { betSide?: "YES" | "NO"; sharesMicro?: string } | null;
    const requested = BigInt(params?.sharesMicro ?? "0");
    if (attempt.dir === "EXIT") await bookExitFills(prisma, attempt, requested, [], { killOnlyUnbound: true });
    else await bookEntryFills(prisma, attempt, params?.betSide === "NO" ? "NO" : "YES", requested, [], { killOnlyUnbound: true });
    const after = await prisma.orderAttempt.findUnique({ where: { id: attempt.id }, select: { state: true } });
    return after?.state === "KILLED" ? "killed" : "unknown";
  }

  // Adopt it. The CAS gates on the row still being an unbound SUBMITTING one, and the unique index
  // on externalOrderId is the backstop: binding one exchange order to two attempts would book the
  // same fills twice, so a P2002 backs off instead of throwing.
  try {
    const cas = await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: "SUBMITTING", externalOrderId: null },
      data: { state: "POSTED", externalOrderId: found.orderId, postResponse: found.order as never, error: null },
    });
    if (cas.count === 0) return "unknown"; // someone else moved the row
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return "unknown";
    throw e;
  }

  // Book from the exchange's own records. The adoption is what this function reports — whatever
  // reconciliation answers now, the ordinary POSTED sweep owns it from here.
  await reconcileAttempt(prisma, { ...attempt, state: "POSTED", externalOrderId: found.orderId }, probe, feeExpMilli);
  return "adopted";
}

// Sweep the orphans. The age floor is load-bearing: a browser that posted seconds ago may simply
// not have reported yet, and the exchange's trade records lag a match a little, so concluding
// "nothing exists" too early would KILL an attempt whose money was spent. Deliberately NO upper
// bound: each of these rows wedges a market slot until it resolves, so an old one must keep being
// retried rather than aging out of sight.
export async function discoverOrphanAttempts(
  prisma: PrismaClient,
  discover: OrphanDiscover,
  probe: OrderProbe,
  opts: { now?: Date; minAgeMs?: number; limit?: number; feeExpMilli?: number } = {},
): Promise<Record<OrphanOutcome, number> & { scanned: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.minAgeMs ?? 15 * 60_000));
  // A progressing cursor, not "oldest first": an orphan that keeps answering "unknown" is never
  // written, so it would sit at the head of an updatedAt-ordered batch forever and starve every
  // later attempt (a filled order among them). The cursor walks the set and wraps at the end.
  const attempts = await cursorBatch(prisma, ORPHAN_CURSOR, opts.limit ?? 10, (after) =>
    prisma.orderAttempt.findMany({
      where: { state: "SUBMITTING", externalOrderId: null, updatedAt: { lt: cutoff }, ...afterCursor(after) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: opts.limit ?? 10,
    }),
  );

  const counts: Record<OrphanOutcome, number> = { unknown: 0, adopted: 0, killed: 0 };
  for (const attempt of attempts) {
    try {
      const market = await prisma.market.findUnique({
        where: { id: attempt.marketId },
        select: { feeExpMilli: true },
      });
      counts[
        await resolveOrphanAttempt(prisma, attempt, discover, probe, market?.feeExpMilli ?? opts.feeExpMilli ?? 1000)
      ]++;
    } catch {
      counts.unknown++; // one attempt's failure must not abort the sweep
    }
  }
  return { ...counts, scanned: attempts.length };
}

// ── Progressing batches ──
// The orphan sweep and the fast pass both select rows they may leave untouched ("unknown",
// "pending"), so a plain ordered LIMIT would hand them the same head rows every pass. They walk the
// set with a stored (createdAt, id) cursor instead, and wrap to the start after a short batch.
const ORPHAN_CURSOR = "polymarket-orphan-sweep-v1";
const REPORTED_CURSOR = "polymarket-reported-fast-v1";
function afterCursor(after: SweepCursorValue | null) {
  return after
    ? { AND: [{ OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }] }
    : {};
}
async function cursorBatch<T extends { createdAt: Date; id: string }>(
  prisma: PrismaClient,
  name: string,
  limit: number,
  find: (after: SweepCursorValue | null) => Promise<T[]>,
): Promise<T[]> {
  let after: SweepCursorValue | null = null;
  try { after = await readSweepCursor(prisma, name); } catch { after = null; }
  let rows = await find(after);
  if (rows.length === 0 && after) rows = await find(null); // wrapped: start over from the beginning
  const last = rows[rows.length - 1];
  try {
    await writeSweepCursor(prisma, name, rows.length >= limit && last ? { createdAt: last.createdAt, id: last.id } : null);
  } catch { /* bookkeeping only — never a reason to skip the money pass */ }
  return rows;
}

// ── Reported-but-unverified attempts (the fast pass) ──
// /api/real/posted got an order id from the browser but could not prove it yet (a FAK order that
// filled at once is not readable as an order, and its trade record lags the match). The route
// leaves the attempt SUBMITTING and writes the reported id into `error` under this prefix. The
// orphan sweep above would find it too — but only after 15 minutes, because that sweep may KILL,
// and killing too early would strand money. This pass can only ADOPT: it proves the reported id
// with exchange evidence and books it, or leaves the row exactly as it was. So it is safe to run
// every poller tick, and the position shows up in a minute instead of a quarter of an hour.
export type ReportedConfirm = (
  attempt: ReconcilableAttempt,
  orderId: string,
) => Promise<
  | { ok: true; order: unknown }
  | { ok: false; reason: "mismatch"; detail: string }
  | { ok: false; reason: "unverifiable" }
  // null = not configured / no credentials → nothing to say, never a state change
  | null
>;
export type ReportedOutcome = "confirmed" | "pending" | "mismatch";

export async function confirmReportedAttempts(
  prisma: PrismaClient,
  confirm: ReportedConfirm,
  probe: OrderProbe,
  // minAgeMs: the posted route itself just spent a few seconds trying, so a row younger than this
  // is still in that request's hands. maxAgeMs: past it the orphan sweep (15 min floor) owns the
  // row — a reported id that never proves (a made-up id, broken credentials) must not hold this
  // pass's queue, or spend that user's exchange quota, forever.
  opts: { now?: Date; minAgeMs?: number; maxAgeMs?: number; limit?: number; feeExpMilli?: number } = {},
): Promise<Record<ReportedOutcome, number> & { scanned: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.minAgeMs ?? 30_000));
  const oldest = new Date(now.getTime() - (opts.maxAgeMs ?? 20 * 60_000));
  // A progressing cursor (see the orphan sweep): rows that keep failing to prove are never written,
  // so any fixed ordering would let them hold the head of the queue for their whole window.
  const attempts = await cursorBatch(prisma, REPORTED_CURSOR, opts.limit ?? 25, (after) =>
    prisma.orderAttempt.findMany({
      where: {
        state: "SUBMITTING",
        externalOrderId: null,
        error: { startsWith: REPORTED_UNVERIFIED_PREFIX },
        updatedAt: { lt: cutoff, gte: oldest },
        ...afterCursor(after),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: opts.limit ?? 25,
    }),
  );

  const counts: Record<ReportedOutcome, number> = { confirmed: 0, pending: 0, mismatch: 0 };
  for (const attempt of attempts) {
    try {
      const orderId = (attempt.error ?? "").slice(REPORTED_UNVERIFIED_PREFIX.length);
      if (!orderId) { counts.pending++; continue; }
      const verdict = await confirm(attempt, orderId);
      if (!verdict || (!verdict.ok && verdict.reason === "unverifiable")) { counts.pending++; continue; }
      if (!verdict.ok) {
        // Same as the route: a wrong id proves nothing about the real order, so record it and stop
        // fast-tracking this row. The orphan sweep (discovery by token) still owns its outcome.
        // Only if the marker is still the one this pass read: a newer report may have replaced it.
        await prisma.orderAttempt.updateMany({
          where: { id: attempt.id, state: "SUBMITTING", externalOrderId: null, error: attempt.error },
          data: { error: `order_mismatch: ${verdict.detail}` },
        });
        counts.mismatch++;
        continue;
      }
      // Adopt exactly as /api/real/posted does: CAS on an unbound SUBMITTING row; the unique index
      // on externalOrderId is the backstop against binding one exchange order to two attempts.
      let cas;
      try {
        cas = await prisma.orderAttempt.updateMany({
          where: { id: attempt.id, state: "SUBMITTING", externalOrderId: null, error: attempt.error },
          data: { state: "POSTED", externalOrderId: orderId, postResponse: verdict.order as never, error: null },
        });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") { counts.pending++; continue; }
        throw e;
      }
      if (cas.count === 0) { counts.pending++; continue; } // someone else moved the row
      const market = await prisma.market.findUnique({ where: { id: attempt.marketId }, select: { feeExpMilli: true } });
      // Booking failures are fine to leave: the row is POSTED with its id now, which the ordinary
      // reconcile sweep owns.
      await reconcileAttempt(
        prisma,
        { ...attempt, state: "POSTED", externalOrderId: orderId },
        probe,
        market?.feeExpMilli ?? opts.feeExpMilli ?? 1000,
      ).catch(() => "unknown");
      counts.confirmed++;
    } catch {
      counts.pending++; // one attempt's failure must not abort the pass
    }
  }
  return { ...counts, scanned: attempts.length };
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
  const minAgeMs = opts.minAgeMs ?? 10 * 60_000;
  const cutoff = new Date(now.getTime() - minAgeMs);

  // The cursor row doubles as the durable job clock. This enforces a minimum retry interval without
  // touching OrderAttempt.updatedAt: ops deliberately uses that field to measure how long an
  // ambiguous POSTED attempt has been stuck, so refreshing it here would hide the incident.
  let after: SweepCursorValue | null = null;
  try {
    const [cursor, clock] = await Promise.all([
      readSweepCursor(prisma, RECONCILE_CURSOR),
      prisma.sweepCursor.findUnique({ where: { name: RECONCILE_CURSOR }, select: { updatedAt: true } }),
    ]);
    after = cursor;
    // A null cursor is the between-cycles cooldown marker. Non-null means a cycle is in progress,
    // so keep draining later batches immediately instead of reducing throughput to 20 rows/10m.
    if (!cursor && clock && clock.updatedAt.getTime() > now.getTime() - minAgeMs) {
      return { unknown: 0, pending: 0, killed: 0, booked: 0, scanned: 0 };
    }
  } catch {
    // Cursor storage is operational bookkeeping, not permission to stop money reconciliation.
    after = null;
  }

  const findBatch = (cursor: SweepCursorValue | null) => prisma.orderAttempt.findMany({
    // POSTED = the ambiguous case still awaiting a verdict. FILLED/PARTIAL are already booked and
    // are revisited for ONE reason: their fee is the formula ESTIMATE until the exchange's own
    // trade records replace it (the booking is order-cumulative, so a re-run books a zero delta,
    // and the true-up is idempotent once the ledger carries the charged amount). A SUBMITTING
    // attempt has no order id to ask about. A booked attempt is revisited only until the exchange's
    // terminal records replaced the estimate (reconciledAt). There is deliberately no upper age
    // bound: an unresolved order remains money state even when it is 49 days old.
    where: {
      OR: [{ state: "POSTED" }, { state: { in: ["FILLED", "PARTIAL"] }, reconciledAt: null }],
      externalOrderId: { not: null },
      updatedAt: { lt: cutoff },
      ...(cursor
        ? { AND: [{ OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] }] }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: opts.limit ?? 20,
  });

  const attempts = await findBatch(after);
  if (attempts.length === 0 && after) {
    // End of the keyspace: persist a null wrap marker and start the retry cooldown. The next cycle
    // begins at the head after minAgeMs. This paces retries per completed traversal without slowing
    // a large backlog to one batch per cooldown.
    try {
      await writeSweepCursor(prisma, RECONCILE_CURSOR, null);
    } catch {
      // best-effort scheduling metadata
    }
    return { unknown: 0, pending: 0, killed: 0, booked: 0, scanned: 0 };
  }

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
  // Advance past every inspected row, including pending, unknown and thrown probes. A poisoned old
  // row therefore cannot pin the head and starve a later fill. Failure to checkpoint is safe: the
  // cumulative bookers and fill keys make replay idempotent, so do not fail completed business work.
  const last = attempts[attempts.length - 1];
  try {
    await writeSweepCursor(prisma, RECONCILE_CURSOR, last ? { createdAt: last.createdAt, id: last.id } : null);
  } catch {
    // best-effort scheduling metadata
  }
  return { ...counts, scanned: attempts.length };
}
