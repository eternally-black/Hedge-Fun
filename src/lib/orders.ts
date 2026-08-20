// Real-order server core (plan §2.1): signed-order validation against the durable intent, and
// fill booking into the append-only ledger + the REAL Bet aggregate. SDK-free and pure where
// possible — the route wires the SDK; this module is what the tests pin.
import { createHash } from "node:crypto";
import type { PrismaClient, OrderAttempt } from "@prisma/client";
import { centsFromMicro, costBasisMicro, feePerShareMicro } from "./quote";
import { SHARE_TICK_MICRO } from "./config";
import { awardShard } from "./shards";
// Aliased: `utcDay` is also a LOCAL const inside the bookers, and the zero-fill release below runs
// before that declaration — an unaliased import would resolve into its temporal dead zone.
import { utcDay as utcDayOf } from "./time";

// Give back a reserved daily-cap slot. /api/real/submit reserves one inside the CAS-claim
// transaction, so every terminal path that ends with NO position must return it. The counter is
// SHARED with the paper economy (swipe.ts), so the guard floors it at zero rather than letting a
// double release borrow from a paper swipe.
export async function releaseSwipeSlot(
  // Accepts a transaction client too, so a caller can make the release atomic with its own write.
  prisma: Pick<PrismaClient, "dailyCounter">,
  userId: string,
  utcDay: string,
): Promise<void> {
  await prisma.dailyCounter.updateMany({
    where: { userId, utcDay, swipeCount: { gt: 0 } },
    data: { swipeCount: { decrement: 1 } },
  });
}

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
  // The ceiling on makerAmount, i.e. on the ORDER's own collateral. Under the fee-on-top rule
  // (owner, 2026-08-17) that is the quoted amount, NOT the debit cap — the cap carries the fee too,
  // and validating against it would let a signed order spend the fee headroom on notional and then
  // be charged the fee on top of that, past what the user approved.
  allInCapMicro: bigint;
  maxPriceBp: number; // marginal-ask bound, tick-rounded
}

export interface ExitIntentParams {
  tokenId: string;
  sharesMicro: bigint; // the position remainder the user is allowed to sell
  minPriceBp: number; // tick-rounded floor — a SELL below this is the harm
}

export function hashSignedOrder(signed: SignedOrderWire): string {
  // A canonical tuple of the VALIDATED fields, not the whole wire object. Hashing every key the
  // client happened to send made the replay guard defeatable by a key the exchange ignores: the
  // same order carrying an extra `"junk": 1`, or `expiration` as the string "0" instead of 0,
  // hashes differently and slips past the signedOrderHash unique — the wire type admits arbitrary
  // keys (`[k: string]: unknown` above). The exchange's order dedup and the Fill unique are the
  // real backstops, so nothing double-booked, but a guard any extra key defeats is not a guard.
  // Changing the shape is safe: the hash is only ever compared against other hashes we compute.
  const canonical = [
    String(signed.maker).toLowerCase(),
    String(signed.signer).toLowerCase(),
    String(signed.tokenId),
    String(signed.side).toUpperCase(),
    String(signed.makerAmount),
    String(signed.takerAmount),
    String(signed.salt),
    String(signed.signature).toLowerCase(),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}


// Shared checks across ENTRY and EXIT validators: maker/signer/signatureType/orderType/builder/
// freshness. Three of these encode SDK 0.6.0 facts that an earlier version of this file got wrong
// and that would have rejected every real order: POLY_1271 signs as the deposit wallet, the
// signature arrives ERC-1271-wrapped, and the timestamp is in milliseconds.
function validateCommon(
  signed: SignedOrderWire,
  ctx: { depositWallet: string; embeddedWallet: string; builderCode: string | null; nowMs?: number },
): string | null {
  const now = ctx.nowMs ?? Date.now();
  const lc = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
  if (lc(signed.maker) !== ctx.depositWallet) return "maker_mismatch";
  if (signed.signatureType !== 3) return "bad_signature_type"; // POLY_1271, deposit wallet
  // POLY_1271 orders are signed BY THE CONTRACT: resolveOrderIdentity sets signer = wallet, and the
  // exchange calls isValidSignature on it, which verifies the owner's signature internally. Reading
  // the embedded EOA here (as this file once did) rejects every order the SDK can produce.
  if (lc(signed.signer) !== ctx.depositWallet) return "signer_mismatch";
  // SHAPE only, and deliberately loose: a POLY_1271 signature is the 65-byte EOA signature followed
  // by the domain separator, the contents hash, the order-type string and a 2-byte length, so the
  // honest bound is "even-length hex, at least 131 bytes". Its job is to stop garbage from burning
  // the intent's CAS claim or a post round-trip — the real verification is the exchange's own
  // ERC-1271 call, and a tighter hand-rolled length would false-reject valid orders on the money path.
  if (typeof signed.signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){131,}$/.test(signed.signature)) {
    return "bad_signature_shape";
  }
  if (String(signed.orderType).toUpperCase() !== "FAK") return "bad_order_type";
  // builder is a SIGNED field — a client signing a different code redirects attribution (S1 review).
  if (ctx.builderCode && lc(signed.builder) !== ctx.builderCode.toLowerCase()) return "builder_mismatch";
  // Freshness (D9): a stale signature must not fill at a bound the card no longer shows. expiration
  // IS in seconds (market orders set it to 0); timestamp is Date.now() MILLISECONDS — reading it as
  // seconds made every real order stale by tens of thousands of years.
  if (signed.expiration > 0 && signed.expiration * 1000 < now) return "expired";
  const ts = Number(signed.timestamp);
  const tsMs = Number.isFinite(ts) && ts > 0 ? (ts > 1e12 ? ts : ts * 1000) : 0;
  if (tsMs > 0 && Math.abs(now - tsMs) > 10 * 60 * 1000) return "stale_signature";
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

// ------------------------------------------------------------------ exchange-order identity
// The CLOB's own view of an order, read back server-side. It exists because the order is now
// POSTED BY THE BROWSER (Polymarket geoblocks our host's IP, and that check is about the trader,
// not our datacentre), so the only thing the client is allowed to report is an order id: the
// server fetches that order itself and proves it is the one this attempt signed before booking a
// cent. Field names are the SDK's camelCase OpenOrder, normalized to strings by the caller.
export interface ExchangeOrderView {
  id: string;
  tokenId: string;
  makerAddress: string;
  side: string;
  originalSize: string; // decimal SHARES as the CLOB reports them, e.g. "18.5962"
  price: string; // decimal limit price, e.g. "0.52"
  status: string;
  sizeMatched: string;
  createdAt: string; // ISO 8601
}

// Returns null when the fetched order IS this attempt's order, else a short error code. Pure, so
// both the report route and the orphan-discovery sweep can ask the same question the same way.
export function matchesExchangeOrder(
  order: ExchangeOrderView,
  expect: { signed: SignedOrderWire; dir: "ENTRY" | "EXIT"; depositWallet: string; notBefore: Date; skewMs?: number },
): string | null {
  // The token is the strongest pin: it is a signed field and the exchange echoes it verbatim.
  if (order.tokenId !== expect.signed.tokenId) return "token_mismatch";
  // A flipped side is a different trade entirely — booking a SELL against an ENTRY attempt would
  // credit shares the user never bought.
  if (order.side.toUpperCase() !== (expect.dir === "EXIT" ? "SELL" : "BUY")) return "side_mismatch";
  // Ownership. fetchOrder already runs under this user's own L2 credentials, so the exchange will
  // only ever hand back their own orders; this check is the second lock, and it is what stops a
  // reported id from binding an attempt to an order made by some other wallet of theirs.
  if (order.makerAddress.toLowerCase() !== expect.depositWallet.toLowerCase()) return "maker_mismatch";
  // Shape guards before any comparison: garbage in any of these means the identity test below
  // would be comparing noise, and on the money path that must read as "cannot prove it".
  const sizeNum = Number(order.originalSize);
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) return "bad_order_shape";
  let signedMaker: bigint;
  let signedTaker: bigint;
  try {
    signedMaker = BigInt(expect.signed.makerAmount);
    signedTaker = BigInt(expect.signed.takerAmount);
  } catch {
    return "bad_order_shape";
  }
  const createdMs = new Date(order.createdAt).getTime();
  if (!Number.isFinite(createdMs)) return "bad_order_shape";
  // Size identity: the exchange reports shares as a decimal, we signed micro-shares. BUY's
  // takerAmount is the shares; SELL's makerAmount is. One micro-share of tolerance absorbs the
  // decimal round-trip and nothing more — the SDK's own resize makes this number distinctive
  // enough that an accidental collision with another order of the user's is not a real scenario.
  // ponytail: exact to one micro-share, on the assumption the CLOB echoes the full 6-decimal size.
  // Gate-0 confirms it against a real order; if it ever reports fewer decimals, widen the tolerance
  // here rather than anywhere else. Both consumers already degrade safely on a false reject — the
  // report route 422s and the discovery sweep treats an unattributed order of ours as ambiguity.
  const signedSizeMicro = expect.dir === "ENTRY" ? signedTaker : signedMaker;
  const orderSizeMicro = BigInt(Math.round(sizeNum * 1e6));
  const diff = orderSizeMicro > signedSizeMicro ? orderSizeMicro - signedSizeMicro : signedSizeMicro - orderSizeMicro;
  if (diff > 1n) return "size_mismatch";
  // An order that existed before the intent did cannot be this attempt's order. The exchange's
  // clock is not ours, so a couple of minutes of skew is allowed rather than false-rejecting a
  // perfectly good order on the money path.
  if (createdMs < expect.notBefore.getTime() - (expect.skewMs ?? 120_000)) return "too_early";
  // The PRICE is deliberately not compared. It is derived from the two signed amounts with the
  // exchange's own rounding, so re-deriving it here buys nothing the size check has not already
  // pinned and risks false-rejecting a valid order — the expensive failure direction here.
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
  // `cumulative`: the post response reports the ORDER's cumulative matched totals, not one
  // increment — the booker books the DELTA against what this attempt already holds.
  | { kind: "matched"; fills: NormalizedFill[]; cumulative: true }
  | { kind: "rejected"; code: string }
  | { kind: "pending" } // live/delayed — FAK shouldn't rest, but never guess: reconcile later
  | { kind: "unknown" }; // unrecognized shape — attempt stays POSTED for reconciliation

// The WHOLE trade set keys the receipt row: a FAK order can match several trades, so keying by
// tradeIds[0] would let a later receipt covering a different set dedup silently and lose fills.
// A single-trade receipt still keys by the real trade id, so a per-trade reconciliation dedups
// against this very row; with no trade ids the cumulative size disambiguates a larger receipt.
export function receiptFillKey(tradeIds: string[], orderId: string, sharesMicro: bigint): string {
  const ids = [...tradeIds].filter(Boolean).sort();
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) return "trades:" + createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 32);
  return `${orderId}:${sharesMicro.toString()}`;
}

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
  const orderId = typeof r.orderId === "string" && r.orderId ? r.orderId : fallbackId;
  const sharesMicro = BigInt(Math.round(shares * 1_000_000));
  return {
    kind: "matched",
    cumulative: true,
    fills: [
      {
        externalFillId: receiptFillKey(tradeIds, orderId, sharesMicro),
        sharesMicro,
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

// Order-cumulative receipts: the CLOB response reports the ORDER's running totals, so a second
// receipt for the same order (reconciliation, delayed match) must be booked as the DELTA against
// what this attempt already holds — keying by trade id alone either double-books the overlap or
// silently drops the new trades (pre-Gate-0 items 2+3). Rounding follows the repo convention:
// cost up (ENTRY), proceeds down (EXIT). null = the receipt adds nothing new.
function receiptDelta(
  receipt: NormalizedFill,
  booked: { shares: bigint; amount: bigint; fee: bigint },
  dir: "ENTRY" | "EXIT",
): NormalizedFill | null {
  const sharesMicro = receipt.sharesMicro - booked.shares;
  if (sharesMicro <= 0n) return null;
  const clamp = (x: bigint) => (x < 0n ? 0n : x);
  const amountMicro = clamp(receipt.amountMicro - booked.amount);
  const priceBp =
    dir === "ENTRY"
      ? Number((amountMicro * 10_000n + sharesMicro - 1n) / sharesMicro)
      : Number((amountMicro * 10_000n) / sharesMicro);
  return { ...receipt, sharesMicro, amountMicro, feeMicro: clamp(receipt.feeMicro - booked.fee), priceBp };
}

// FILLED vs PARTIAL is decided by the attempt's CUMULATIVE booked shares — comparing one batch
// against the whole request means split receipts never reach FILLED (K3 S6/S7 Q2).
function fillLabel(cumulativeShares: bigint, requestedSharesMicro: bigint): "FILLED" | "PARTIAL" | "KILLED" {
  if (cumulativeShares <= 0n) return "KILLED";
  return cumulativeShares >= requestedSharesMicro ? "FILLED" : "PARTIAL";
}

// What the user actually SWIPED, in cents. Since the platform fee moved on top of the stake
// (owner, 2026-08-17) `allInCapMicro` is the debit CEILING — stake + fee — so reading the stake off
// it would show a $1 swipe as $1.04 everywhere the position is displayed. The intent stores the
// chosen number; the cap is the fallback for rows written before the change, where the two were
// the same thing by definition.
function swipedStakeCents(attempt: OrderAttempt): number {
  const p = attempt.approvedParams as { stakeCents?: unknown } | null;
  return typeof p?.stakeCents === "number" && p.stakeCents > 0
    ? p.stakeCents
    : Number(attempt.allInCapMicro / 10_000n);
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
  opts?: { cumulative?: boolean },
): Promise<"FILLED" | "PARTIAL" | "KILLED"> {
  if (fills.length === 0) {
    // KILL and release in ONE transaction. Two statements meant a crash in between left the attempt
    // terminal with the slot still spent, and unrecoverably so: the retry's updateMany matches zero
    // rows, so nothing downstream can tell that the release still owes.
    await prisma.$transaction(async (tx) => {
      const k = await tx.orderAttempt.updateMany({
        where: { id: attempt.id, state: { in: ["SUBMITTING", "POSTED"] } },
        data: { state: "KILLED" },
      });
      // Gated on the update actually landing, so a replayed receipt against an already-KILLED
      // attempt cannot release a second slot.
      if (k.count > 0) await releaseSwipeSlot(tx, attempt.userId, utcDayOf(attempt.createdAt));
    });
    return "KILLED";
  }

  // The ATTEMPT's day everywhere below — the same key /api/real/submit reserved the cap slot under.
  // Using the wall clock here would put the point (and the bet) on the fill day while the slot was
  // spent on the submit day, so a fill that lands after midnight could mint a point on a day whose
  // cap was already full.
  const utcDay = utcDayOf(attempt.createdAt);
  let outcome: "FILLED" | "PARTIAL" | "KILLED" = "KILLED";

  await prisma.$transaction(async (tx) => {
    // What this attempt already holds — the base for both the cumulative-receipt delta and the
    // FILLED/PARTIAL label.
    const booked = await tx.fill.aggregate({
      where: { attemptId: attempt.id },
      _sum: { sharesMicro: true, amountMicro: true, feeMicro: true },
    });
    const bookedShares = booked._sum.sharesMicro ?? 0n;

    // Aggregate increments are driven ONLY by fills actually INSERTED this call — a replayed
    // receipt deduped by the unique fill id must not double-book the position (executor-test
    // finding). No skipDuplicates: a true concurrent replay hits the unique and aborts cleanly.
    // A cumulative receipt needs no id dedup: an exact replay simply yields a zero delta.
    let fresh: NormalizedFill[];
    if (opts?.cumulative && fills.length === 1) {
      const delta = receiptDelta(
        fills[0],
        { shares: bookedShares, amount: booked._sum.amountMicro ?? 0n, fee: booked._sum.feeMicro ?? 0n },
        "ENTRY",
      );
      fresh = delta ? [delta] : [];
    } else {
      const seen = new Set(
        (
          await tx.fill.findMany({
            where: { externalFillId: { in: fills.map((f) => f.externalFillId) } },
            select: { externalFillId: true },
          })
        ).map((e) => e.externalFillId),
      );
      fresh = fills.filter((f) => !seen.has(f.externalFillId));
    }
    if (fresh.length === 0) {
      outcome = fillLabel(bookedShares, requestedSharesMicro);
      // A replay books nothing, but the LABEL is derived — and the rule deriving it has been wrong
      // before: judged against the intent's PREDICTED size, a fully matched order came back one
      // micro-share short and sat as PARTIAL forever. Refreshing it here lets a corrected rule heal
      // the rows it already mislabelled, on the next sweep, with no migration. Only from a booked
      // state and only to a booked label: KILLED and FAILED are decisions, not labels.
      if ((outcome === "FILLED" || outcome === "PARTIAL") && outcome !== attempt.state) {
        await tx.orderAttempt.updateMany({
          where: { id: attempt.id, state: { in: ["POSTED", "PARTIAL", "FILLED"] } },
          data: { state: outcome },
        });
      }
      return; // full replay: nothing new to book
    }
    const totalShares = fresh.reduce((s, f) => s + f.sharesMicro, 0n);
    const totalSpend = fresh.reduce((s, f) => s + f.amountMicro, 0n);
    const totalFee = fresh.reduce((s, f) => s + f.feeMicro, 0n);
    const vwapBp = Number((totalSpend * 10_000n + totalShares - 1n) / totalShares); // ceil
    outcome = fillLabel(bookedShares + totalShares, requestedSharesMicro);

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

    // Q1 participation fires once per POSITION: this read decides whether this call is the one
    // creating it (a split receipt must not burn a second swipe of the daily cap).
    const priorBet = await tx.bet.findUnique({
      where: { userId_marketId_mode: { userId: attempt.userId, marketId: attempt.marketId, mode: "REAL" } },
      select: { id: true, filledSharesMicro: true, closedSharesMicro: true },
    });

    // REOPEN vs add-to-position. The intent route admits an ENTRY whenever the remainder is zero,
    // so this row can be a fully-CLOSED lot from an earlier trade — and, since the block it passed
    // was only about the remainder, a lot on the OTHER side. Incrementing into it keeps the stale
    // `side`, and EXIT reads exactly that field to pick the token to sell: the user would sign a
    // SELL for a token they do not hold. It also leaves the closed lot's cost in spendMicro, which
    // bookExitFills prorates as basis, so the reopened position's realized PnL is priced against
    // money that was already realized. Reset the LOT to this fill and adopt the side actually
    // bought. realizedPnlMicro is deliberately NOT reset — it is the account's running history,
    // not this lot's basis. Unreachable with zero fills: the fresh.length===0 return above.
    // Sub-tick dust counts as "no position" here for the same reason it does in the intent route's
    // admission gate (tradableRemainder): the two predicates disagreeing let an entry increment into
    // a dust lot with a stale side, and EXIT then signs a SELL for a token the user does not hold.
    const reopening =
      priorBet !== null && (priorBet.filledSharesMicro ?? 0n) - (priorBet.closedSharesMicro ?? 0n) < SHARE_TICK_MICRO;

    // A reopen on a market that no longer trades is not a re-entry — it is a LATE fill for a lot
    // that has already been settled (and possibly redeemed on chain). Resetting the row would clear
    // the settlement stamp, real-settle would see a fresh remainder on a resolved market with a
    // zero token balance, and the same shares would be booked a second time at $1/share. The fills
    // are already in the ledger; leave the position settled and hand the attempt to ops.
    if (reopening && priorBet !== null) {
      const mkt = await tx.market.findUnique({ where: { id: attempt.marketId }, select: { status: true } });
      if (mkt && mkt.status !== "OPEN") {
        await tx.orderAttempt.update({
          where: { id: attempt.id },
          data: {
            state: outcome,
            betId: priorBet.id,
            error: "late_fill_after_market_close: booked to Fill ledger only, settled position not reopened",
          },
        });
        return;
      }
    }

    // The position aggregate — one REAL row per (user, market). stakeCents keeps the swiped
    // all-in INTENT; actuals live in the micro fields (PnL derives from these, never stakeCents).
    const bet = await tx.bet.upsert({
      where: { userId_marketId_mode: { userId: attempt.userId, marketId: attempt.marketId, mode: "REAL" } },
      create: {
        userId: attempt.userId,
        marketId: attempt.marketId,
        side: betSide,
        stakeCents: swipedStakeCents(attempt),
        lockedPriceBp: vwapBp,
        utcDay,
        mode: "REAL",
        source: "DECK",
        filledSharesMicro: totalShares,
        spendMicro: totalSpend,
        feeMicro: totalFee,
        vwapBp,
      },
      update: reopening
        ? {
            // A new lot in every field the basis is computed from, plus the side that was actually
            // bought. The close-side counters go back to zero or the next EXIT would think part of
            // this lot is already sold.
            side: betSide,
            stakeCents: swipedStakeCents(attempt),
            utcDay,
            // New lot, new number. Every attempt stamps the lot it booked into, so a late fee
            // true-up for the PREVIOUS lot can tell that the counters it wants to prorate against
            // are no longer its own.
            lotSeq: { increment: 1 },
            filledSharesMicro: totalShares,
            spendMicro: totalSpend,
            feeMicro: totalFee,
            closedSharesMicro: 0n,
            proceedsMicro: 0n,
            closeFeeMicro: 0n,
            // The previous lot's settlement stamp belongs to the previous lot. Left in place, a
            // re-entered market would open already wearing "SETTLED / LOST" (bookExitFills stamps
            // a fully sold-out position), and the results inbox would list a position that is open.
            settlementStatus: "PENDING",
            result: "PENDING", // BetResult's own not-decided value — the column is not nullable
            pnlCents: null,
            settledAt: null,
            seenAt: null,
          }
        : {
            filledSharesMicro: { increment: totalShares },
            spendMicro: { increment: totalSpend },
            feeMicro: { increment: totalFee },
            // vwapBp is NOT set from this batch — it is re-derived from the post-increment aggregate
            // below, so it can never diverge from spendMicro/filledSharesMicro after an add-to-
            // position (K3 S6/S7 Q2). Still fee-EXCLUSIVE: the micro fields carry the all-in truth.
          },
    });
    const nextVwap =
      bet.filledSharesMicro && bet.filledSharesMicro > 0n
        ? Number(((bet.spendMicro ?? 0n) * 10_000n + bet.filledSharesMicro - 1n) / bet.filledSharesMicro)
        : vwapBp;
    if (nextVwap !== bet.vwapBp) await tx.bet.update({ where: { id: bet.id }, data: { vwapBp: nextVwap } });

    await tx.orderAttempt.update({
      where: { id: attempt.id },
      data: { state: outcome, betId: bet.id, lotSeq: bet.lotSeq },
    });

    // Q1 (owner, locked): real swipes fully participate — swipe counter + point book AT FILL,
    // VirtualBalance untouched. Over-cap fills (day rolled over between intent and fill) record
    // earnedPoint=false, like paper over-cap feed bets.
    // NO P2002 catch here: a swallowed unique violation inside a Postgres transaction turns the
    // COMMIT into a silent ROLLBACK — the earlier version discarded the very fills, increments and
    // state transition this transaction had just written and still returned FILLED (verified: the
    // second receipt for a position booked zero rows). The duplicate is PREVENTED via priorBet;
    // a genuine concurrent duplicate now throws — visible and reconcilable, never silent loss.
    if (!priorBet) {
      // The swipe COUNTER is no longer bumped here — /api/real/submit reserves it inside the same
      // transaction as the CAS claim, because a bare read at intent time let N parallel intents
      // pass on one value and let a re-entry after a full EXIT skip the increment entirely via the
      // `!priorBet` guard right above. The reservation throws when the post-increment value would
      // exceed the cap, so anything that reaches this line was within it by construction — the
      // old `swipeCount <= SWIPE_CAP` re-check would now only mis-fire on a later swipe's bump.
      // ponytail: a REOPENED lot consumes a swipe slot at /submit but earns no point, because this
      // block is gated on `!priorBet` and a reopen reuses the same Bet row. Do NOT fix it by
      // relaxing the guard: PointsLedger.betId is UNIQUE, so a second row for the same bet throws
      // P2002 inside this transaction, and a swallowed P2002 in Postgres turns the COMMIT into a
      // silent ROLLBACK — the exact failure the comment above this block was written about. The
      // column it needs now exists (Bet.lotSeq); the remaining work is replacing that unique with a
      // composite on (betId, lotSeq), which is a data migration, not an additive one.
      await tx.pointsLedger.create({
        data: { userId: attempt.userId, type: "SWIPE", amount: 1, utcDay, betId: bet.id },
      });
      await tx.bet.update({ where: { id: bet.id }, data: { earnedPoint: true } });
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
  opts?: { cumulative?: boolean },
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
    // discipline as the entry booker — the executor's own test surfaced the double-book), and a
    // cumulative receipt books its delta against what the attempt already holds.
    const booked = await tx.fill.aggregate({
      where: { attemptId: attempt.id },
      _sum: { sharesMicro: true, amountMicro: true, feeMicro: true },
    });
    const bookedShares = booked._sum.sharesMicro ?? 0n;
    let fresh: NormalizedFill[];
    if (opts?.cumulative && fills.length === 1) {
      const delta = receiptDelta(
        fills[0],
        { shares: bookedShares, amount: booked._sum.amountMicro ?? 0n, fee: booked._sum.feeMicro ?? 0n },
        "EXIT",
      );
      fresh = delta ? [delta] : [];
    } else {
      const seen = new Set(
        (
          await tx.fill.findMany({
            where: { externalFillId: { in: fills.map((f) => f.externalFillId) } },
            select: { externalFillId: true },
          })
        ).map((e) => e.externalFillId),
      );
      fresh = fills.filter((f) => !seen.has(f.externalFillId));
    }
    if (fresh.length === 0) {
      outcome = fillLabel(bookedShares, requestedSharesMicro);
      // A replay books nothing, but the LABEL is derived — and the rule deriving it has been wrong
      // before: judged against the intent's PREDICTED size, a fully matched order came back one
      // micro-share short and sat as PARTIAL forever. Refreshing it here lets a corrected rule heal
      // the rows it already mislabelled, on the next sweep, with no migration. Only from a booked
      // state and only to a booked label: KILLED and FAILED are decisions, not labels.
      if ((outcome === "FILLED" || outcome === "PARTIAL") && outcome !== attempt.state) {
        await tx.orderAttempt.updateMany({
          where: { id: attempt.id, state: { in: ["POSTED", "PARTIAL", "FILLED"] } },
          data: { state: outcome },
        });
      }
      return; // full replay: nothing new to book
    }
    const totalShares = fresh.reduce((s, f) => s + f.sharesMicro, 0n);
    const totalProceeds = fresh.reduce((s, f) => s + f.amountMicro, 0n); // amountMicro = proceeds for SELL
    const totalFee = fresh.reduce((s, f) => s + f.feeMicro, 0n);
    outcome = fillLabel(bookedShares + totalShares, requestedSharesMicro);

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

    // Sub-tick dust. The signer works in 4-decimal shares, so a position of 1.333332 can only ever
    // be sold down to 1.3333 — and the 32 micro-shares left behind are not a position, they are an
    // artefact of that granularity. Left on the row they are permanent: no EXIT can offer them, and
    // the ENTRY guard reads any remainder as "position exists", so the market would be closed to
    // this user forever over three thousandths of a cent. They are written off as closed with no
    // proceeds, and their basis is realized as the loss it actually is.
    const trailing = filledShares - (closedShares + sharesToBook);
    const dust = trailing > 0n && trailing < SHARE_TICK_MICRO ? trailing : 0n;
    const closedTotal = closedShares + sharesToBook + dust;

    // Realized PnL for the closed slice: proceeds − close fee − prorated cost basis, where the
    // basis includes the prorated ENTRY fee — fee-inclusive economics end to end (S6/S7 review:
    // omitting it overstated user PnL by the entry fee). The dust carries its own basis and no
    // proceeds, so it lands as a loss of exactly what it cost.
    const costBasis = costBasisMicro(bet.spendMicro ?? 0n, bet.feeMicro ?? 0n, filledShares, sharesToBook + dust);
    const realizedDelta = proceedsBooked - closeFeeBooked - costBasis;

    // Explicit SET, not { increment }: these columns are NULL on an entry-created row, and SQL
    // NULL + x = NULL — an increment would silently book nothing (caught by the close test).
    // Safe because the row was read in THIS transaction.
    // Selling the LAST share ends the position, so it is stamped exactly as a redemption is
    // (real-settle.consumeResolvedPosition). Without this an early close left the row PENDING
    // forever: /api/results serves SETTLED/VOID only, so a position the user deliberately exited
    // never appeared under "every call you've made" — the history sheet showed it (that status is
    // derived from the remainder) and the results inbox did not. The outcome is the LEDGER's, not
    // the market's: what the sale realized is what happened to this person's money.
    const realizedTotal = (bet.realizedPnlMicro ?? 0n) + realizedDelta;
    const closedOut = closedTotal >= filledShares;
    await tx.bet.update({
      where: { id: bet.id },
      data: {
        closedSharesMicro: closedTotal,
        proceedsMicro: (bet.proceedsMicro ?? 0n) + proceedsBooked,
        closeFeeMicro: (bet.closeFeeMicro ?? 0n) + closeFeeBooked,
        realizedPnlMicro: realizedTotal, // can be negative — schema allows it
        ...(closedOut
          ? {
              settlementStatus: "SETTLED" as const,
              result: realizedTotal > 0n ? ("WIN" as const) : realizedTotal < 0n ? ("LOSS" as const) : ("PUSH" as const),
              pnlCents: centsFromMicro(realizedTotal),
              settledAt: new Date(),
            }
          : {}),
      },
    });

    // A profitable sold-out REAL position is the ledger's WIN, and the paper settle job
    // (mode:PAPER) will never see this row — this is where its shard is earned. Idempotent on
    // ShardGrant.betId, so a reopened lot on the same market can never earn a second one.
    if (closedOut && realizedTotal > 0n) {
      await awardShard(tx, bet.userId, bet.id, bet.createdAt, { bypassCap: bet.source === "FEED" });
    }

    // A clamp means the exchange sold MORE than we thought the position held: the Fill rows carry
    // the exchange's number, the aggregate carries the remainder, and the two now disagree. That
    // is a reconciliation question for a human, so it lands on the attempt (the stuck-attempt
    // watcher and anyone reading the row see it) instead of being swallowed. Cleared when the
    // clamp does not fire, so a stale error never sticks.
    await tx.orderAttempt.update({
      where: { id: attempt.id },
      data: {
        lotSeq: bet.lotSeq, // the lot this close belongs to — see trueUpAttemptFee
        state: outcome,
        betId: bet.id,
        error: prorate ? `clamped: fill ${totalShares} > remainder ${remainder}` : null,
      },
    });
  });

  return outcome;
}

// The receipt's fee is an ESTIMATE (the post response has no fee field — classifyPostResponse
// derives it from the intent's fee params). Once the exchange's own trade records are read, the
// CHARGED total is known and must replace the estimate on the Fill ledger AND on the position
// aggregate (pre-Gate-0 item 4). The correction lands on the NEWEST fill — the most recent
// knowledge — and the same delta hits the aggregate, so ledger and aggregate never diverge.
// Both CHECK constraints (fills_sane, bets_real_fields_nonneg) forbid negative fees, so the
// delta is clamped against BOTH before anything is written; the applied delta is returned.
export async function trueUpAttemptFee(
  prisma: PrismaClient,
  attempt: OrderAttempt & { userId: string; marketId: string },
  trueFeeMicro: bigint,
): Promise<bigint> {
  return prisma.$transaction(async (tx) => {
    const fills = await tx.fill.findMany({ where: { attemptId: attempt.id }, orderBy: { createdAt: "asc" } });
    if (fills.length === 0) return 0n;
    const booked = fills.reduce((s, f) => s + f.feeMicro, 0n);

    const bet = attempt.betId
      ? await tx.bet.findUnique({ where: { id: attempt.betId } })
      : await tx.bet.findUnique({
          where: { userId_marketId_mode: { userId: attempt.userId, marketId: attempt.marketId, mode: "REAL" } },
        });
    const isExit = attempt.dir === "EXIT";
    const aggregateFee = bet ? (isExit ? (bet.closeFeeMicro ?? 0n) : (bet.feeMicro ?? 0n)) : null;

    // How far DOWN the correction can go before something would turn negative: the ledger can give
    // back what it booked, the aggregate what it holds. Decided before any write so both move by
    // the same number.
    const floor = aggregateFee === null ? -booked : -(booked < aggregateFee ? booked : aggregateFee);
    let applied = trueFeeMicro - booked;
    if (applied < floor) applied = floor;
    if (applied === 0n) return 0n;

    if (applied > 0n) {
      // An increase lands on the newest fill — the most recent knowledge.
      const last = fills[fills.length - 1];
      await tx.fill.update({ where: { id: last.id }, data: { feeMicro: last.feeMicro + applied } });
    } else {
      // A decrease is absorbed newest-first: the over-estimate usually sits on an EARLIER receipt
      // row, and the newest row alone often cannot give back enough (its fee may be zero).
      let left = -applied;
      for (let i = fills.length - 1; i >= 0 && left > 0n; i--) {
        const f = fills[i];
        const take = f.feeMicro < left ? f.feeMicro : left;
        if (take === 0n) continue;
        await tx.fill.update({ where: { id: f.id }, data: { feeMicro: f.feeMicro - take } });
        left -= take;
      }
    }
    if (!bet) return applied;
    // The aggregate half only applies while the row still describes THIS attempt's lot. A reopened
    // position reuses the same bets row with the counters reset and lotSeq bumped, so prorating
    // against them would charge a correction to a basis that never paid it and leave the closed lot
    // still holding a fee now known to be wrong. The Fill rows above are per-attempt and were
    // already corrected — that part is always right. Null lotSeq means the attempt predates lot
    // tracking: treated as a match, so historical rows keep behaving exactly as they did.
    if (attempt.lotSeq !== null && attempt.lotSeq !== bet.lotSeq) return applied;
    // How much of this lot is already realized — the slice a late entry-fee correction must restate
    // by hand, because it has no future exit to price itself off the corrected basis.
    const filledShare = bet.filledSharesMicro ?? 0n;
    const closedShare = filledShare > 0n ? (bet.closedSharesMicro ?? 0n) : 0n;

    // An entry-fee correction reprices the cost basis (basis IS spendMicro + feeMicro), so every
    // FUTURE exit picks it up for free. The shares already closed have no future exit left to pick
    // it up: bookExitFills computed their realizedDelta against the fee that was on the row at the
    // time, and that number is now known to be wrong. Restate exactly the closed fraction — a fully
    // closed lot would otherwise swallow the whole correction, and a position entered at a
    // 20_000µ¢ under-estimate and closed flat would keep reporting zero PnL on what was really a
    // 20_000µ¢ loss. Floor-divides like the exit's own prorate, so the correction never claims
    // more than the closed slice actually bore. (Exit: a higher charged close fee lowers realized
    // PnL by exactly that much.)
    const newRealized = isExit
      ? (bet.realizedPnlMicro ?? 0n) - applied
      : closedShare > 0n
        ? (bet.realizedPnlMicro ?? 0n) - (applied * closedShare) / filledShare
        : (bet.realizedPnlMicro ?? 0n);

    // Explicit SET, not { increment }: these columns are NULL on rows that never got there and
    // SQL NULL + x = NULL (the rule the close test pinned). Safe — the row was read in THIS tx.
    await tx.bet.update({
      where: { id: bet.id },
      data: {
        ...(isExit
          ? { closeFeeMicro: (bet.closeFeeMicro ?? 0n) + applied, realizedPnlMicro: newRealized }
          : {
              feeMicro: (bet.feeMicro ?? 0n) + applied,
              ...(closedShare > 0n ? { realizedPnlMicro: newRealized } : {}),
            }),
        // The stamped verdict must follow the money it was stamped from: /api/results reads
        // pnlCents/result while /api/history reads realizedPnlMicro. A true-up that restates one
        // and not the other shows a WIN in the inbox and a loss in the history for the same close.
        ...(bet.settlementStatus === "SETTLED" && newRealized !== (bet.realizedPnlMicro ?? 0n)
          ? {
              result: newRealized > 0n ? ("WIN" as const) : newRealized < 0n ? ("LOSS" as const) : ("PUSH" as const),
              pnlCents: centsFromMicro(newRealized),
            }
          : {}),
      },
    });
    return applied;
  });
}
