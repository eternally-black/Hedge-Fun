// scripts/test-orders.ts — the order-path server core (plan §2.1): signed-order validation
// against the intent, fill booking into the REAL Bet aggregate + Q1 paper-game participation,
// zero-fill slot release. Run: npx tsx scripts/test-orders.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { validateSignedOrder, classifyPostResponse, bookEntryFills, type SignedOrderWire } from "../src/lib/orders";
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
  signer: EW,
  takerAmount: "19323671", // implies ~0.5175/share
  timestamp: String(Math.floor(Date.now() / 1000)),
  tokenId: "tok-1",
  signature: "0x" + "ab".repeat(65),
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

    // Zero fill → KILLED, no Bet row, slot freed (a second attempt is creatable).
    const a1 = await mkAttempt();
    const s1 = await bookEntryFills(prisma, a1, "YES", 19_000_000n, []);
    assert.strictEqual(s1, "KILLED");
    assert.strictEqual(await prisma.bet.count({ where: { userId: user.id } }), 0, "no position on zero fill");
    const a2 = await mkAttempt(); // partial unique allows it — the slot is free

    // Partial fill → PARTIAL, REAL Bet created with actuals, point + counter booked (Q1).
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
    const utcDay = new Date().toISOString().slice(0, 10);
    const counter = await prisma.dailyCounter.findUniqueOrThrow({
      where: { userId_utcDay: { userId: user.id, utcDay } },
    });
    assert.strictEqual(counter.swipeCount, 1, "Q1: swipe counter consumed at fill");
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

    console.log("OK: order validation matrix, tolerant fill parsing, on-fill booking, zero-fill slot release");
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
