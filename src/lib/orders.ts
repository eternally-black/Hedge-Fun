// Real-order server core (plan §2.1): signed-order validation against the durable intent, and
// fill booking into the append-only ledger + the REAL Bet aggregate. SDK-free and pure where
// possible — the route wires the SDK; this module is what the tests pin.
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, OrderAttempt } from "@prisma/client";
import { SWIPE_CAP } from "./config";
import { feePerShareMicro } from "./quote";

// ------------------------------------------------------------------ signed-order validation
// The SignedOrder wire shape (0.6.0 typings): maker/signer/tokenId/side/signatureType/orderType/
// makerAmount/takerAmount/expiration/timestamp/builder/salt/signature/metadata. The envelope the
// client POSTs alongside it is NOT trusted — every relevant signed field is checked against the
// server-derived intent (S2 review: the signed order is the only authoritative object).
export interface SignedOrderWire {
  builder: string;
  expiration: number;
  maker: string;
  makerAmount: string;
  orderType: string;
  salt: string;
  side: string;
  signatureType: number;
  signer: string;
  takerAmount: string;
  timestamp: string;
  tokenId: string;
  signature: string;
  [k: string]: unknown;
}

export interface IntentParams {
  tokenId: string;
  side: "BUY" | "SELL";
  allInCapMicro: bigint; // the user's all-in debit cap — makerAmount must not exceed it (BUY)
  maxPriceBp: number; // marginal-ask bound, tick-rounded
}

export interface ExitIntentParams {
  tokenId: string;
  sharesMicro: bigint; // the position remainder the user is allowed to sell
  minPriceBp: number; // tick-rounded floor — a SELL below this is the harm
}

export function hashSignedOrder(signed: SignedOrderWire): string {
  const sorted = Object.fromEntries(Object.keys(signed).sort().map((k) => [k, signed[k]]));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// Shared checks across ENTRY and EXIT validators: maker/signer/signatureType/orderType/builder/
// freshness. Behavior-identical to the pre-refactor BUY-only path.
function validateCommon(
  signed: SignedOrderWire,
  ctx: { depositWallet: string; embeddedWallet: string; builderCode: string | null; nowMs?: number },
): string | null {
  const now = ctx.nowMs ?? Date.now();
  const lc = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
  if (lc(signed.maker) !== ctx.depositWallet) return "maker_mismatch";
  if (lc(signed.signer) !== ctx.embeddedWallet) return "signer_mismatch";
  if (signed.signatureType !== 3) return "bad_signature_type"; // POLY_1271, deposit wallet
  if (String(signed.orderType).toUpperCase() !== "FAK") return "bad_order_type";
  // builder is a SIGNED field — a client signing a different code redirects attribution (S1 review).
  if (ctx.builderCode && lc(signed.builder) !== ctx.builderCode.toLowerCase()) return "builder_mismatch";
  // Freshness (D9): a stale signature must not fill at a bound the card no longer shows.
  if (signed.expiration > 0 && signed.expiration * 1000 < now) return "expired";
  const ts = Number(signed.timestamp);
  if (Number.isFinite(ts) && ts > 0 && Math.abs(now - ts * 1000) > 10 * 60 * 1000) return "stale_signature";
  return null;
}

// Returns an error code, or null when the signed order matches the intent. Never reserializes the
// order (the caller forwards the original bytes); this only READS parsed fields.
export function validateSignedOrder(
  signed: SignedOrderWire,
  intent: IntentParams,
  ctx: { depositWallet: string; embeddedWallet: string; builderCode: string | null; nowMs?: number },
): string | null {
  const common = validateCommon(signed, ctx);
  if (common) return common;
  if (signed.tokenId !== intent.tokenId) return "token_mismatch";
  if (String(signed.side).toUpperCase() !== intent.side) return "side_mismatch";
  let makerAmount: bigint;
  let takerAmount: bigint;
  try {
    makerAmount = BigInt(signed.makerAmount);
    takerAmount = BigInt(signed.takerAmount);
  } catch {
    return "bad_amounts";
  }
  if (makerAmount <= 0n || takerAmount <= 0n) return "bad_amounts";
  if (intent.side === "BUY") {
    // makerAmount = collateral offered (micro-USD): the all-in cap is the ceiling. The implied
    // worst price makerAmount/takerAmount must respect the tick-rounded marginal-ask bound.
    if (makerAmount > intent.allInCapMicro) return "over_cap";
    if (makerAmount * 10_000n > takerAmount * BigInt(intent.maxPriceBp)) return "over_max_price";
  }
  return null;
}

// EXIT validator: the signed SELL order must not sell more than the position remainder, and the
// implied worst price (takerAmount/makerAmount = collateral per share) must be >= the floor.
// SELL amount semantics (CTF exchange): makerAmount = SHARES offered, takerAmount = collateral.
export function validateSignedSellOrder(
  signed: SignedOrderWire,
  intent: ExitIntentParams,
  ctx: { depositWallet: string; embeddedWallet: string; builderCode: string | null; nowMs?: number },
): string | null {
  const common = validateCommon(signed, ctx);
  if (common) return common;
  if (signed.tokenId !== intent.tokenId) return "token_mismatch";
  if (String(signed.side).toUpperCase() !== "SELL") return "side_mismatch";
  let makerAmount: bigint;
  let takerAmount: bigint;
  try {
    makerAmount = BigInt(signed.makerAmount);
    takerAmount = BigInt(signed.takerAmount);
  } catch {
    return "bad_amounts";
  }
  if (makerAmount <= 0n || takerAmount <= 0n) return "bad_amounts";
  // makerAmount = SHARES offered (micro-shares); cannot sell more than the position's remainder.
  if (makerAmount > intent.sharesMicro) return "over_position";
  // SELL protection: a LOWER price than the bound is the harm. Implied worst price =
  // takerAmount/makerAmount must be >= minPriceBp.
  if (takerAmount * 10_000n < makerAmount * BigInt(intent.minPriceBp)) return "below_min_price";
  return null;
}

// ------------------------------------------------------------------ fill booking
export interface NormalizedFill {
  externalFillId: string;
  sharesMicro: bigint;
  amountMicro: bigint; // notional spent (BUY) or proceeds (SELL)
  feeMicro: bigint;
  priceBp: number;
  ts: Date;
}

// The postOrder response classification. Verified 0.6.0 shape (bindings AcceptedOrderResponse):
// { ok: true, orderId, status: "live"|"matched"|"delayed", makingAmount, takingAmount,
//   tradeIds[], transactionsHashes[] } | { ok: false, code, message }.
// The S6 review's critical: a fills-array guess would classify a real MATCHED response as
// zero-fill and KILL an attempt whose money was spent. Classify first, book second.
export type PostOutcome =
  | { kind: "matched"; fills: NormalizedFill[] }
  | { kind: "rejected"; code: string }
  | { kind: "pending" } // live/delayed — FAK shouldn't rest, but never guess: reconcile later
  | { kind: "unknown" }; // unrecognized shape — attempt stays POSTED for reconciliation

export function classifyPostResponse(
  raw: unknown,
  dir: "ENTRY" | "EXIT",
  fallbackId: string,
  fee: { rateBp: number; expMilli: number } | null,
): PostOutcome {
  if (!raw || typeof raw !== "object") return { kind: "unknown" };
  const r = raw as Record<string, unknown>;
  if (r.ok === false) return { kind: "rejected", code: String(r.code ?? "rejected") };
  if (r.ok !== true) return { kind: "unknown" };
  const status = String(r.status ?? "");
  if (status === "live" || status === "delayed") return { kind: "pending" };
  if (status !== "matched") return { kind: "unknown" };

  // Amount semantics per side: maker = what WE give, taker = what we receive.
  // ENTRY (BUY): making = collateral spent, taking = shares. EXIT (SELL): making = shares,
  // taking = collateral received. DecimalStrings in whole units.
  const making = num(r.makingAmount);
  const taking = num(r.takingAmount);
  if (making === null || taking === null || making <= 0 || taking <= 0) return { kind: "unknown" };
  const shares = dir === "ENTRY" ? taking : making;
  const amount = dir === "ENTRY" ? making : taking;
  const price = amount / shares;
  if (!(price > 0) || !(price < 1)) return { kind: "unknown" };
  // The post response carries NO fee — the platform fee lives on the trade record. Estimate from
  // the intent's fee params (the measured formula) so costs are never silently zero; the trade-
  // record reconciliation at Gate-0 replaces the estimate with the charged number.
  const feeMicro = fee ? BigInt(Math.round((feePerShareMicro(Math.round(price * 10_000), fee.rateBp, fee.expMilli) * shares))) : 0n;
  const tradeIds = Array.isArray(r.tradeIds) ? (r.tradeIds as unknown[]).map(String) : [];
  return {
    kind: "matched",
    fills: [
      {
        externalFillId: tradeIds[0] ?? String(r.orderId ?? fallbackId),
        sharesMicro: BigInt(Math.round(shares * 1_000_000)),
        amountMicro: BigInt(Math.round(amount * 1_000_000)),
        feeMicro,
        priceBp: Math.round(price * 10_000),
        ts: new Date(),
      },
    ],
  };
}
function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Book fills for an ENTRY attempt: Fill rows (idempotent on externalFillId), the REAL Bet
// aggregate (created ON FILL — a zero-fill leaves no position and frees the slot, plan §2.1),
// and the paper-game participation per owner decision Q1 (point + swipe counter AT FILL TIME;
// VirtualBalance untouched). Returns the attempt's terminal state.
export async function bookEntryFills(
  prisma: PrismaClient,
  attempt: OrderAttempt & { userId: string; marketId: string },
  betSide: "YES" | "NO",
  requestedSharesMicro: bigint,
  fills: NormalizedFill[],
): Promise<"FILLED" | "PARTIAL" | "KILLED"> {
  if (fills.length === 0) {
    await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: { in: ["SUBMITTING", "POSTED"] } },
      data: { state: "KILLED" },
    });
    return "KILLED";
  }

  const utcDay = new Date().toISOString().slice(0, 10);
  let outcome: "FILLED" | "PARTIAL" | "KILLED" = "KILLED";

  await prisma.$transaction(async (tx) => {
    // Aggregate increments are driven ONLY by fills actually INSERTED this call — a replayed
    // receipt deduped by the unique fill id must not double-book the position (executor-test
    // finding). No skipDuplicates: a true concurrent replay hits the unique and aborts cleanly.
    const seen = new Set(
      (
        await tx.fill.findMany({
          where: { externalFillId: { in: fills.map((f) => f.externalFillId) } },
          select: { externalFillId: true },
        })
      ).map((e) => e.externalFillId),
    );
    const fresh = fills.filter((f) => !seen.has(f.externalFillId));
    if (fresh.length === 0) {
      const cur = await tx.orderAttempt.findUnique({ where: { id: attempt.id }, select: { state: true } });
      outcome = cur?.state === "PARTIAL" || cur?.state === "FILLED" ? cur.state : "KILLED";
      return; // full replay: nothing new to book
    }
    const totalShares = fresh.reduce((s, f) => s + f.sharesMicro, 0n);
    const totalSpend = fresh.reduce((s, f) => s + f.amountMicro, 0n);
    const totalFee = fresh.reduce((s, f) => s + f.feeMicro, 0n);
    const vwapBp = Number((totalSpend * 10_000n + totalShares - 1n) / totalShares); // ceil
    outcome = totalShares >= requestedSharesMicro ? "FILLED" : "PARTIAL";

    await tx.fill.createMany({
      data: fresh.map((f) => ({
        attemptId: attempt.id,
        externalFillId: f.externalFillId,
        sharesMicro: f.sharesMicro,
        amountMicro: f.amountMicro,
        feeMicro: f.feeMicro,
        priceBp: f.priceBp,
        ts: f.ts,
      })),
    });

    // The position aggregate — one REAL row per (user, market). stakeCents keeps the swiped
    // all-in INTENT; actuals live in the micro fields (PnL derives from these, never stakeCents).
    const bet = await tx.bet.upsert({
      where: { userId_marketId_mode: { userId: attempt.userId, marketId: attempt.marketId, mode: "REAL" } },
      create: {
        userId: attempt.userId,
        marketId: attempt.marketId,
        side: betSide,
        stakeCents: Number(attempt.allInCapMicro / 10_000n), // micro-USD → cents
        lockedPriceBp: vwapBp,
        utcDay,
        mode: "REAL",
        source: "DECK",
        filledSharesMicro: totalShares,
        spendMicro: totalSpend,
        feeMicro: totalFee,
        vwapBp,
      },
      update: {
        filledSharesMicro: { increment: totalShares },
        spendMicro: { increment: totalSpend },
        feeMicro: { increment: totalFee },
        vwapBp,
      },
    });

    await tx.orderAttempt.update({ where: { id: attempt.id }, data: { state: outcome, betId: bet.id } });

    // Q1 (owner, locked): real swipes fully participate — swipe counter + point book AT FILL,
    // idempotent via the PointsLedger betId unique. Over-cap fills (day rolled over between
    // intent and fill) record earnedPoint=false, like paper over-cap feed bets.
    const counter = await tx.dailyCounter.upsert({
      where: { userId_utcDay: { userId: attempt.userId, utcDay } },
      create: { userId: attempt.userId, utcDay, swipeCount: 1 },
      update: { swipeCount: { increment: 1 } },
    });
    if (counter.swipeCount <= SWIPE_CAP) {
      try {
        await tx.pointsLedger.create({
          data: { userId: attempt.userId, type: "SWIPE", amount: 1, utcDay, betId: bet.id },
        });
        await tx.bet.update({ where: { id: bet.id }, data: { earnedPoint: true } });
      } catch (e) {
        // betId unique — the point was already booked by an earlier partial receipt. Fine.
        if ((e as Prisma.PrismaClientKnownRequestError).code !== "P2002") throw e;
      }
    }
  });

  return outcome;
}

// Book fills for an EXIT attempt: Fill rows (idempotent on externalFillId), the REAL Bet
// aggregate (must already exist — the intent route guarantees it), and realized PnL for the
// closed slice. Returns the attempt's terminal state.
export async function bookExitFills(
  prisma: PrismaClient,
  attempt: OrderAttempt & { userId: string; marketId: string },
  requestedSharesMicro: bigint,
  fills: NormalizedFill[],
): Promise<"FILLED" | "PARTIAL" | "KILLED"> {
  if (fills.length === 0) {
    await prisma.orderAttempt.updateMany({
      where: { id: attempt.id, state: { in: ["SUBMITTING", "POSTED"] } },
      data: { state: "KILLED" },
    });
    return "KILLED";
  }

  // The tx callback owns the outcome — it may downgrade (missing position / no remainder /
  // full replay); the route must report what actually got booked (executor-review fix).
  let outcome: "FILLED" | "PARTIAL" | "KILLED" = "KILLED";

  await prisma.$transaction(async (tx) => {
    // Aggregate increments are driven ONLY by fills actually INSERTED this call (same replay
    // discipline as the entry booker — the executor's own test surfaced the double-book).
    const seen = new Set(
      (
        await tx.fill.findMany({
          where: { externalFillId: { in: fills.map((f) => f.externalFillId) } },
          select: { externalFillId: true },
        })
      ).map((e) => e.externalFillId),
    );
    const fresh = fills.filter((f) => !seen.has(f.externalFillId));
    if (fresh.length === 0) {
      const cur = await tx.orderAttempt.findUnique({ where: { id: attempt.id }, select: { state: true } });
      outcome = cur?.state === "PARTIAL" || cur?.state === "FILLED" ? cur.state : "KILLED";
      return; // full replay: nothing new to book
    }
    const totalShares = fresh.reduce((s, f) => s + f.sharesMicro, 0n);
    const totalProceeds = fresh.reduce((s, f) => s + f.amountMicro, 0n); // amountMicro = proceeds for SELL
    const totalFee = fresh.reduce((s, f) => s + f.feeMicro, 0n);
    outcome = totalShares >= requestedSharesMicro ? "FILLED" : "PARTIAL";

    await tx.fill.createMany({
      data: fresh.map((f) => ({
        attemptId: attempt.id,
        externalFillId: f.externalFillId,
        sharesMicro: f.sharesMicro,
        amountMicro: f.amountMicro,
        feeMicro: f.feeMicro,
        priceBp: f.priceBp,
        ts: f.ts,
      })),
    });

    // The REAL Bet must exist — the intent route guarantees one, but be defensive: a missing
    // position means the close is invalid, so fail the attempt rather than fabricate a row.
    const bet = attempt.betId
      ? await tx.bet.findUnique({ where: { id: attempt.betId } })
      : await tx.bet.findUnique({
          where: { userId_marketId_mode: { userId: attempt.userId, marketId: attempt.marketId, mode: "REAL" } },
        });
    if (!bet) {
      await tx.orderAttempt.update({
        where: { id: attempt.id },
        data: { state: "FAILED", error: "no_position" },
      });
      outcome = "KILLED";
      return;
    }

    // Clamp to the position remainder — the CHECK constraint closedSharesMicro <= filledSharesMicro
    // must never trip on a double receipt (createMany dedup already guards, but belt-and-braces).
    const filledShares = bet.filledSharesMicro ?? 0n;
    const closedShares = bet.closedSharesMicro ?? 0n;
    const remainder = filledShares - closedShares;
    const sharesToBook = totalShares > remainder ? remainder : totalShares;
    if (sharesToBook <= 0n) {
      await tx.orderAttempt.update({
        where: { id: attempt.id },
        data: { state: "KILLED", error: "no_remainder" },
      });
      outcome = "KILLED";
      return;
    }

    // Prorate proceeds/fee if we're closing less than the fill total (clamp fired).
    const prorate = sharesToBook < totalShares;
    const proceedsBooked = prorate ? (totalProceeds * sharesToBook) / totalShares : totalProceeds;
    const closeFeeBooked = prorate ? (totalFee * sharesToBook) / totalShares : totalFee;

    // Realized PnL for the closed slice: proceeds − close fee − prorated cost basis, where the
    // basis includes the prorated ENTRY fee — fee-inclusive economics end to end (S6/S7 review:
    // omitting it overstated user PnL by the entry fee).
    const spend = (bet.spendMicro ?? 0n) + (bet.feeMicro ?? 0n);
    const costBasis = filledShares > 0n ? (spend * sharesToBook) / filledShares : 0n;
    const realizedDelta = proceedsBooked - closeFeeBooked - costBasis;

    // Explicit SET, not { increment }: these columns are NULL on an entry-created row, and SQL
    // NULL + x = NULL — an increment would silently book nothing (caught by the close test).
    // Safe because the row was read in THIS transaction.
    await tx.bet.update({
      where: { id: bet.id },
      data: {
        closedSharesMicro: closedShares + sharesToBook,
        proceedsMicro: (bet.proceedsMicro ?? 0n) + proceedsBooked,
        closeFeeMicro: (bet.closeFeeMicro ?? 0n) + closeFeeBooked,
        realizedPnlMicro: (bet.realizedPnlMicro ?? 0n) + realizedDelta, // can be negative — schema allows it
      },
    });

    await tx.orderAttempt.update({ where: { id: attempt.id }, data: { state: outcome, betId: bet.id } });
  });

  return outcome;
}
