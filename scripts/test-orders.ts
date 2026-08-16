// scripts/test-orders.ts — the order-path server core (plan §2.1): signed-order validation
// against the intent, fill booking into the REAL Bet aggregate + Q1 paper-game participation,
// zero-fill slot release. Run: npx tsx scripts/test-orders.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import {
  validateSignedOrder,
  classifyPostResponse,
  bookEntryFills,
  trueUpAttemptFee,
  type SignedOrderWire,
} from "../src/lib/orders";
import { SWIPE_CAP } from "../src/lib/config";

const DW = "0x" + "aa".repeat(20);
const EW = "0x" + "bb".repeat(20);
const BUILDER = "0x" + "cc".repeat(32);

const goodOrder = (over: Partial<SignedOrderWire> = {}): SignedOrderWire => ({
  builder: BUILDER,
  expiration: Math.floor(Date.now() / 1000) + 300,
  maker: DW,
  makerAmount: "10000000", // $10
  orderType: "FAK",
  salt: "1",
  side: "BUY",
  signatureType: 3,
  signer: DW, // POLY_1271: the order is signed BY the deposit wallet contract, not the EOA
  takerAmount: "19323671", // implies ~0.5175/share
  timestamp: String(Date.now()), // the SDK emits milliseconds
  tokenId: "tok-1",
  signature: "0x" + "ab".repeat(150), // ERC-1271-wrapped: EOA sig + separator + contents hash + type + length
  ...over,
});
const intent = { tokenId: "tok-1", side: "BUY" as const, allInCapMicro: 10_000_000n, maxPriceBp: 5200 };
const ctx = { depositWallet: DW, embeddedWallet: EW, builderCode: BUILDER };

async function main() {
  // ---- 1. Validation matrix: the envelope is never trusted; every signed field checks the intent.
  assert.strictEqual(validateSignedOrder(goodOrder(), intent, ctx), null, "happy path");
  assert.strictEqual(validateSignedOrder(goodOrder({ maker: "0x" + "11".repeat(20) }), intent, ctx), "maker_mismatch");
  assert.strictEqual(validateSignedOrder(goodOrder({ signer: "0x" + "11".repeat(20) }), intent, ctx), "signer_mismatch");
  assert.strictEqual(validateSignedOrder(goodOrder({ signatureType: 0 }), intent, ctx), "bad_signature_type");
  assert.strictEqual(
    validateSignedOrder(goodOrder({ signature: undefined as unknown as string }), intent, ctx),
    "bad_signature_shape",
  );
  assert.strictEqual(validateSignedOrder(goodOrder({ signature: "0xdead" }), intent, ctx), "bad_signature_shape");
  assert.strictEqual(validateSignedOrder(goodOrder({ signature: "0x" + "AB".repeat(150) }), intent, ctx), null);
  // An UNWRAPPED 65-byte signature is what a hand-rolled client would send; the exchange would
  // reject it, so the gate does. The embedded EOA in `signer` is the same class of mistake.
  assert.strictEqual(validateSignedOrder(goodOrder({ signature: "0x" + "ab".repeat(65) }), intent, ctx), "bad_signature_shape");
  assert.strictEqual(validateSignedOrder(goodOrder({ signer: EW }), intent, ctx), "signer_mismatch");
  assert.strictEqual(
    validateSignedOrder(goodOrder({ timestamp: String(Date.now() - 20 * 60 * 1000) }), intent, ctx),
    "stale_signature",
  );
  assert.strictEqual(validateSignedOrder(goodOrder({ tokenId: "tok-2" }), intent, ctx), "token_mismatch");
  assert.strictEqual(validateSignedOrder(goodOrder({ side: "SELL" }), intent, ctx), "side_mismatch");
  assert.strictEqual(validateSignedOrder(goodOrder({ orderType: "GTC" }), intent, ctx), "bad_order_type");
  assert.strictEqual(validateSignedOrder(goodOrder({ builder: "0x" + "dd".repeat(32) }), intent, ctx), "builder_mismatch");
  assert.strictEqual(validateSignedOrder(goodOrder({ makerAmount: "10000001" }), intent, ctx), "over_cap");
  // implied price above the tick-rounded marginal bound: $10 for 15 shares = 0.666… > 0.52
  assert.strictEqual(validateSignedOrder(goodOrder({ takerAmount: "15000000" }), intent, ctx), "over_max_price");
  assert.strictEqual(
    validateSignedOrder(goodOrder({ expiration: Math.floor(Date.now() / 1000) - 10 }), intent, ctx),
    "expired",
  );
  assert.strictEqual(
    validateSignedOrder(goodOrder({ timestamp: String(Math.floor(Date.now() / 1000) - 3600) }), intent, ctx),
    "stale_signature",
  );
  // A checksummed maker still matches (case-insensitive), and a missing builder env skips that check.
  assert.strictEqual(validateSignedOrder(goodOrder({ maker: DW.toUpperCase().replace("0X", "0x") }), intent, ctx), null);
  assert.strictEqual(
    validateSignedOrder(goodOrder({ builder: "0x" + "dd".repeat(32) }), intent, { ...ctx, builderCode: null }),
    null,
  );

  // ---- 2. classifyPostResponse: the REAL 0.6.0 response shape (S6-review critical — a
  // fills-array guess read a matched response as zero-fill and killed paid attempts).
  assert.deepStrictEqual(classifyPostResponse(null, "ENTRY", "a", null), { kind: "unknown" });
  assert.deepStrictEqual(classifyPostResponse({ weird: 1 }, "ENTRY", "a", null), { kind: "unknown" });
  assert.deepStrictEqual(classifyPostResponse({ ok: true, status: "live" }, "ENTRY", "a", null), { kind: "pending" });
  assert.deepStrictEqual(classifyPostResponse({ ok: true, status: "delayed" }, "ENTRY", "a", null), { kind: "pending" });
  const rej = classifyPostResponse({ ok: false, code: "not enough balance" }, "ENTRY", "a", null);
  assert.strictEqual(rej.kind, "rejected");
  // The measured fill, in the real shape: BUY 5 shares for $2.60, rate 700/exp 1000 → fee $0.08736.
  const matched = classifyPostResponse(
    { ok: true, orderId: "ord-1", status: "matched", makingAmount: "2.6", takingAmount: "5", tradeIds: ["t-1"], transactionsHashes: [] },
    "ENTRY",
    "a",
    { rateBp: 700, expMilli: 1000 },
  );
  assert.strictEqual(matched.kind, "matched");
  if (matched.kind !== "matched") throw new Error("unreachable");
  const fills = matched.fills;
  assert.strictEqual(fills.length, 1);
  assert.strictEqual(fills[0]!.externalFillId, "t-1", "tradeId wins as the fill id");
  assert.strictEqual(fills[0]!.sharesMicro, 5_000_000n);
  assert.strictEqual(fills[0]!.amountMicro, 2_600_000n);
  assert.strictEqual(fills[0]!.feeMicro, 87_360n, "fee estimated from the measured formula");
  assert.strictEqual(fills[0]!.priceBp, 5200);
  // EXIT semantics invert: making = shares given, taking = collateral received.
  const sellMatch = classifyPostResponse(
    { ok: true, orderId: "ord-2", status: "matched", makingAmount: "5", takingAmount: "2.5", tradeIds: [], transactionsHashes: [] },
    "EXIT",
    "b",
    null,
  );
  assert.strictEqual(sellMatch.kind, "matched");
  if (sellMatch.kind !== "matched") throw new Error("unreachable");
  assert.strictEqual(sellMatch.fills[0]!.sharesMicro, 5_000_000n);
  assert.strictEqual(sellMatch.fills[0]!.amountMicro, 2_500_000n);
  assert.strictEqual(sellMatch.fills[0]!.priceBp, 5000);

  // ---- 3. Booking: fills create the REAL Bet ON FILL + Q1 participation; zero-fill frees the slot.
  const tag = `ord-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode() },
  });
  const market = await prisma.market.create({
    data: {
      polymarketId: `${tag}-m`,
      question: "order booking test",
      status: "OPEN",
      resolutionDeadline: new Date(Date.now() + 3_600_000),
    },
  });

  try {
    const mkAttempt = () =>
      prisma.orderAttempt.create({
        data: {
          userId: user.id,
          marketId: market.id,
          dir: "ENTRY",
          side: "YES",
          tokenId: "tok-1",
          idempotencyKey: crypto.randomUUID(),
          approvedParams: {},
          allInCapMicro: 10_000_000n,
          maxPriceBp: 5200,
          state: "SUBMITTING",
        },
      });

    // The daily cap is RESERVED by /api/real/submit inside its CAS-claim transaction, not by the
    // booker — a bare read at intent time let parallel intents share one value and let a re-entry
    // after a full EXIT skip the count entirely. These tests call the booker directly, so they
    // stand in for the route by seeding the reservation the route would have made.
    const utcDay = new Date().toISOString().slice(0, 10);
    const reserve = () =>
      prisma.dailyCounter.upsert({
        where: { userId_utcDay: { userId: user.id, utcDay } },
        create: { userId: user.id, utcDay, swipeCount: 1 },
        update: { swipeCount: { increment: 1 } },
      });

    // Zero fill → KILLED, no Bet row, slot freed (a second attempt is creatable) — and the booker
    // hands the reserved swipe back, or an unfillable market would silently eat the day's cap.
    await reserve();
    const a1 = await mkAttempt();
    const s1 = await bookEntryFills(prisma, a1, "YES", 19_000_000n, []);
    assert.strictEqual(s1, "KILLED");
    assert.strictEqual(await prisma.bet.count({ where: { userId: user.id } }), 0, "no position on zero fill");
    assert.strictEqual(
      (await prisma.dailyCounter.findUniqueOrThrow({ where: { userId_utcDay: { userId: user.id, utcDay } } }))
        .swipeCount,
      0,
      "a zero-fill ENTRY releases its reserved swipe",
    );
    const a2 = await mkAttempt(); // partial unique allows it — the slot is free

    // Partial fill → PARTIAL, REAL Bet created with actuals, point booked (Q1).
    await reserve();
    const s2 = await bookEntryFills(prisma, a2, "YES", 19_000_000n, [
      { externalFillId: `${tag}-f1`, sharesMicro: 5_000_000n, amountMicro: 2_600_000n, feeMicro: 87_360n, priceBp: 5200, ts: new Date() },
    ]);
    assert.strictEqual(s2, "PARTIAL");
    const bet = await prisma.bet.findUniqueOrThrow({
      where: { userId_marketId_mode: { userId: user.id, marketId: market.id, mode: "REAL" } },
    });
    assert.strictEqual(bet.mode, "REAL");
    assert.strictEqual(bet.filledSharesMicro, 5_000_000n);
    assert.strictEqual(bet.spendMicro, 2_600_000n);
    assert.strictEqual(bet.feeMicro, 87_360n);
    assert.strictEqual(bet.stakeCents, 1000, "stakeCents keeps the all-in INTENT");
    assert.strictEqual(bet.earnedPoint, true, "Q1: point booked at fill");
    const counter = await prisma.dailyCounter.findUniqueOrThrow({
      where: { userId_utcDay: { userId: user.id, utcDay } },
    });
    // Exactly the one slot reserved above: the booker awards the point but must NEVER bump the
    // counter itself, or every fill would double-charge the cap the route already charged.
    assert.strictEqual(counter.swipeCount, 1, "Q1: the reserved swipe is consumed, not doubled");
    assert.ok(counter.swipeCount <= SWIPE_CAP);
    const a2row = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a2.id } });
    assert.strictEqual(a2row.state, "PARTIAL");
    assert.strictEqual(a2row.betId, bet.id, "ledger linked to the position");

    // Replayed receipt: same externalFillId → no double-booking (skipDuplicates + betId unique).
    const s3 = await bookEntryFills(prisma, a2row, "YES", 19_000_000n, [
      { externalFillId: `${tag}-f1`, sharesMicro: 5_000_000n, amountMicro: 2_600_000n, feeMicro: 87_360n, priceBp: 5200, ts: new Date() },
    ]);
    void s3;
    const betAfter = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a2.id } }), 1, "fill row deduped");
    assert.strictEqual(
      await prisma.pointsLedger.count({ where: { userId: user.id, type: "SWIPE" } }),
      1,
      "one point ever per bet",
    );
    void betAfter;

    // ---- 4. Cumulative receipts: split CLOB receipts book deltas, label from cumulative totals,
    // vwap from the position aggregate (pre-Gate-0 items 2+3).
    const a3 = await mkAttempt();
    const rec1 = classifyPostResponse(
      { ok: true, status: "matched", orderId: `${tag}-o1`, makingAmount: "3.12", takingAmount: "6", tradeIds: [`${tag}-t1`] },
      "ENTRY",
      "fallback",
      { rateBp: 700, expMilli: 1000 },
    );
    if (rec1.kind !== "matched") throw new Error("receipt 1 not matched");
    assert.strictEqual(rec1.cumulative, true);
    const s4 = await bookEntryFills(prisma, a3, "YES", 12_000_000n, rec1.fills, { cumulative: true });
    assert.strictEqual(s4, "PARTIAL", "first cumulative receipt books 6 of 12 shares");

    // Same order, grown to 12 shares / $6.30 and a SECOND trade id — a different receipt key.
    const rec2 = classifyPostResponse(
      { ok: true, status: "matched", orderId: `${tag}-o1`, makingAmount: "6.3", takingAmount: "12", tradeIds: [`${tag}-t1`, `${tag}-t2`] },
      "ENTRY",
      "fallback",
      { rateBp: 700, expMilli: 1000 },
    );
    if (rec2.kind !== "matched") throw new Error("receipt 2 not matched");
    const s5 = await bookEntryFills(prisma, a3, "YES", 12_000_000n, rec2.fills, { cumulative: true });
    assert.strictEqual(s5, "FILLED", "cumulative labeling reaches FILLED on the second receipt");

    const fills3 = await prisma.fill.findMany({ where: { attemptId: a3.id } });
    assert.strictEqual(fills3.length, 2, "exactly two fill rows for the split receipts");
    assert.strictEqual(fills3.reduce((s, f) => s + f.sharesMicro, 0n), 12_000_000n, "delta booked 12 shares total");
    assert.strictEqual(fills3.reduce((s, f) => s + f.amountMicro, 0n), 6_300_000n, "delta booked $6.30 total");

    const s6 = await bookEntryFills(prisma, a3, "YES", 12_000_000n, rec2.fills, { cumulative: true });
    assert.strictEqual(s6, "FILLED", "exact replay still reports FILLED");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a3.id } }), 2, "replay adds no third fill row");

    const betCum = await prisma.bet.findUniqueOrThrow({
      where: { userId_marketId_mode: { userId: user.id, marketId: market.id, mode: "REAL" } },
    });
    assert.strictEqual(betCum.filledSharesMicro, 17_000_000n, "aggregate sums earlier steps plus this attempt");
    assert.strictEqual(betCum.spendMicro, 8_900_000n, "aggregate spend sums earlier steps plus this attempt");
    const expectedVwap = Number(
      ((betCum.spendMicro ?? 0n) * 10_000n + (betCum.filledSharesMicro ?? 1n) - 1n) / (betCum.filledSharesMicro ?? 1n),
    );
    assert.strictEqual(betCum.vwapBp, expectedVwap, "vwap re-derived from the aggregate");
    assert.strictEqual(betCum.vwapBp, 5236, "literal vwap so a silent drift fails");

    // Q1 fires once per POSITION: a second receipt must not burn another swipe of the daily cap,
    // and the point stays single. (The old P2002-catch made this whole transaction roll back
    // silently — fills booked, then discarded, with FILLED still reported.)
    const counterAfter = await prisma.dailyCounter.findUniqueOrThrow({
      where: { userId_utcDay: { userId: user.id, utcDay } },
    });
    assert.strictEqual(counterAfter.swipeCount, 1, "one swipe per position, not per receipt");
    assert.strictEqual(
      await prisma.pointsLedger.count({ where: { userId: user.id, type: "SWIPE" } }),
      1,
      "one point per position across split receipts",
    );

    // ─── lot attribution: a reopened position must not absorb the OLD lot's fee correction ──────
    // The reopen resets filled/closed/proceeds on the SAME bets row, which is what makes a late
    // trueUpAttemptFee for the previous attempt prorate against a basis that never paid it. lotSeq
    // is the marker that lets the true-up notice; without it the correction silently lands on the
    // wrong lot and the closed one keeps a realized PnL computed from a fee proved wrong.
    {
      const lotBet = await prisma.bet.findUniqueOrThrow({
        where: { userId_marketId_mode: { userId: user.id, marketId: market.id, mode: "REAL" } },
      });
      // Close the lot out so the intent route's remainder rule would admit a re-entry.
      await prisma.bet.update({
        where: { id: lotBet.id },
        data: { closedSharesMicro: lotBet.filledSharesMicro, realizedPnlMicro: 0n },
      });
      const oldAttempt = await prisma.orderAttempt.findFirstOrThrow({
        where: { userId: user.id, lotSeq: { not: null } },
        orderBy: { createdAt: "asc" },
      });
      assert.strictEqual(oldAttempt.lotSeq, 0, "the first booking stamps lot 0");

      await reserve();
      const reAttempt = await mkAttempt();
      await bookEntryFills(prisma, reAttempt, "NO", 5_000_000n, [
        { externalFillId: `${tag}-lot2`, sharesMicro: 4_000_000n, amountMicro: 2_000_000n, feeMicro: 50_000n, priceBp: 5000, ts: new Date() },
      ]);
      const reopened = await prisma.bet.findUniqueOrThrow({ where: { id: lotBet.id } });
      assert.strictEqual(reopened.lotSeq, 1, "a reopen advances the lot");
      assert.strictEqual(reopened.side, "NO", "…and adopts the side actually bought");
      assert.strictEqual(reopened.closedSharesMicro, 0n, "…with the close counters cleared");

      // A late fee true-up for the OLD attempt must correct its own fill rows and leave the new
      // lot's aggregate alone.
      const feeBefore = (await prisma.bet.findUniqueOrThrow({ where: { id: lotBet.id } })).feeMicro;
      const pnlBefore = (await prisma.bet.findUniqueOrThrow({ where: { id: lotBet.id } })).realizedPnlMicro;
      const appliedOld = await trueUpAttemptFee(prisma, oldAttempt, 999_999n);
      const afterOld = await prisma.bet.findUniqueOrThrow({ where: { id: lotBet.id } });
      assert.notStrictEqual(appliedOld, 0n, "the old attempt's own fill rows are still corrected");
      assert.strictEqual(afterOld.feeMicro, feeBefore, "a foreign lot's aggregate fee is untouched");
      assert.strictEqual(afterOld.realizedPnlMicro, pnlBefore, "…and so is its realized PnL");

      // The CURRENT lot's own attempt still trues up normally — the guard must not freeze everything.
      const curAttempt = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: reAttempt.id } });
      assert.strictEqual(curAttempt.lotSeq, 1, "the re-entry stamps the new lot");
      await trueUpAttemptFee(prisma, curAttempt, 60_000n);
      const afterCur = await prisma.bet.findUniqueOrThrow({ where: { id: lotBet.id } });
      assert.strictEqual(afterCur.feeMicro, 60_000n, "the matching lot IS corrected");
    }

    console.log("OK: lot attribution — a reopen advances lotSeq and a foreign lot's true-up is refused");
    console.log("OK: order validation matrix, tolerant fill parsing, on-fill booking, zero-fill slot release");
    console.log("OK: cumulative receipts — delta booking, cumulative FILLED label, aggregate-derived vwap");
    console.log("PASS: orders");
  } finally {
    await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
    await prisma.fill.deleteMany({ where: { attempt: { userId: user.id } } });
    await prisma.orderAttempt.deleteMany({ where: { userId: user.id } });
    await prisma.bet.deleteMany({ where: { userId: user.id } });
    await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
    await prisma.market.deleteMany({ where: { id: market.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
