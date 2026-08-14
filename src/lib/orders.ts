// Real-order server core (plan §2.1): signed-order validation against the durable intent, and
// fill booking into the append-only ledger + the REAL Bet aggregate. SDK-free and pure where
// possible — the route wires the SDK; this module is what the tests pin.
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, OrderAttempt } from "@prisma/client";
import { SWIPE_CAP } from "./config";

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

export function hashSignedOrder(signed: SignedOrderWire): string {
  const sorted = Object.fromEntries(Object.keys(signed).sort().map((k) => [k, signed[k]]));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// Returns an error code, or null when the signed order matches the intent. Never reserializes the
// order (the caller forwards the original bytes); this only READS parsed fields.
export function validateSignedOrder(
  signed: SignedOrderWire,
  intent: IntentParams,
  ctx: { depositWallet: string; embeddedWallet: string; builderCode: string | null; nowMs?: number },
): string | null {
  const now = ctx.nowMs ?? Date.now();
  const lc = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
  if (lc(signed.maker) !== ctx.depositWallet) return "maker_mismatch";
  if (lc(signed.signer) !== ctx.embeddedWallet) return "signer_mismatch";
  if (signed.signatureType !== 3) return "bad_signature_type"; // POLY_1271, deposit wallet
  if (signed.tokenId !== intent.tokenId) return "token_mismatch";
  if (String(signed.side).toUpperCase() !== intent.side) return "side_mismatch";
  if (String(signed.orderType).toUpperCase() !== "FAK") return "bad_order_type";
  // builder is a SIGNED field — a client signing a different code redirects attribution (S1 review).
  if (ctx.builderCode && lc(signed.builder) !== ctx.builderCode.toLowerCase()) return "builder_mismatch";
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
  // Freshness (D9): a stale signature must not fill at a bound the card no longer shows.
  if (signed.expiration > 0 && signed.expiration * 1000 < now) return "expired";
  const ts = Number(signed.timestamp);
  if (Number.isFinite(ts) && ts > 0 && Math.abs(now - ts * 1000) > 10 * 60 * 1000) return "stale_signature";
  return null;
}

// ------------------------------------------------------------------ fill booking
export interface NormalizedFill {
  externalFillId: string;
  sharesMicro: bigint;
  amountMicro: bigint; // notional spent (BUY)
  feeMicro: bigint;
  priceBp: number;
  ts: Date;
}

// Best-effort parser over the (Gate-0-unverified) post/fill response shapes. Tolerant by design:
// unknown shape → [] and the attempt stays POSTED for reconciliation, never a crash.
export function parseFills(raw: unknown, fallbackId: string): NormalizedFill[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const arr = (r.fills ?? r.trades ?? r.matches) as unknown;
  const list = Array.isArray(arr) ? arr : [];
  const out: NormalizedFill[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i] as Record<string, unknown>;
    const shares = num(f.size ?? f.shares ?? f.matchedAmount);
    const price = num(f.price ?? f.avgPrice);
    if (shares === null || price === null || shares <= 0 || price <= 0 || price >= 1) continue;
    const fee = num(f.feeUsdc ?? f.fee) ?? 0;
    out.push({
      externalFillId: String(f.id ?? f.tradeId ?? f.fillId ?? `${fallbackId}:${i}`),
      sharesMicro: BigInt(Math.round(shares * 1_000_000)),
      amountMicro: BigInt(Math.round(shares * price * 1_000_000)),
      feeMicro: BigInt(Math.round(fee * 1_000_000)),
      priceBp: Math.round(price * 10_000),
      ts: new Date(),
    });
  }
  return out;
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

  const totalShares = fills.reduce((s, f) => s + f.sharesMicro, 0n);
  const totalSpend = fills.reduce((s, f) => s + f.amountMicro, 0n);
  const totalFee = fills.reduce((s, f) => s + f.feeMicro, 0n);
  const vwapBp = Number((totalSpend * 10_000n + totalShares - 1n) / totalShares); // ceil
  const state = totalShares >= requestedSharesMicro ? "FILLED" : "PARTIAL";
  const utcDay = new Date().toISOString().slice(0, 10);

  await prisma.$transaction(async (tx) => {
    await tx.fill.createMany({
      data: fills.map((f) => ({
        attemptId: attempt.id,
        externalFillId: f.externalFillId,
        sharesMicro: f.sharesMicro,
        amountMicro: f.amountMicro,
        feeMicro: f.feeMicro,
        priceBp: f.priceBp,
        ts: f.ts,
      })),
      skipDuplicates: true, // replayed receipts must not double-book
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

    await tx.orderAttempt.update({ where: { id: attempt.id }, data: { state, betId: bet.id } });

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

  return state;
}
