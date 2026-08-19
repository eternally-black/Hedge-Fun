// scripts/test-close.ts — EXIT/close path: sell validation + booking (plan S7).
// Run: npx tsx scripts/test-close.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { validateSignedSellOrder, bookExitFills, classifyPostResponse, type SignedOrderWire } from "../src/lib/orders";
import { settleResolvedRealPositions } from "../src/lib/real-settle";

const DW = "0x" + "aa".repeat(20);
const EW = "0x" + "bb".repeat(20);
const BUILDER = "0x" + "cc".repeat(32);

const goodSell = (over: Partial<SignedOrderWire> = {}): SignedOrderWire => ({
  builder: BUILDER,
  expiration: Math.floor(Date.now() / 1000) + 300,
  maker: DW,
  makerAmount: "5000000", // 5 shares
  orderType: "FAK",
  salt: "1",
  side: "SELL",
  signatureType: 3,
  signer: DW, // POLY_1271: the deposit wallet contract is the order signer, not the EOA
  takerAmount: "2500000", // $2.50 → 0.50/share
  timestamp: String(Date.now()), // the SDK emits milliseconds
  tokenId: "tok-1",
  signature: "0x" + "ab".repeat(150), // ERC-1271-wrapped, as the SDK produces
  ...over,
});
const exitIntent = { tokenId: "tok-1", sharesMicro: 5_000_000n, minPriceBp: 4800 };
const ctx = { depositWallet: DW, embeddedWallet: EW, builderCode: BUILDER };

async function main() {
  // ---- 1. Validation matrix: SELL-specific checks + shared checks still fire.
  assert.strictEqual(validateSignedSellOrder(goodSell(), exitIntent, ctx), null, "happy path");
  assert.strictEqual(validateSignedSellOrder(goodSell({ side: "BUY" }), exitIntent, ctx), "side_mismatch");
  assert.strictEqual(validateSignedSellOrder(goodSell({ makerAmount: "5000001" }), exitIntent, ctx), "over_position");
  assert.strictEqual(validateSignedSellOrder(goodSell({ takerAmount: "2300000" }), exitIntent, ctx), "below_min_price");
  assert.strictEqual(validateSignedSellOrder(goodSell({ maker: "0x" + "11".repeat(20) }), exitIntent, ctx), "maker_mismatch");
  assert.strictEqual(validateSignedSellOrder(goodSell({ orderType: "GTC" }), exitIntent, ctx), "bad_order_type");

  // ---- 2. Booking: seed user + market + REAL Bet + EXIT attempts.
  const tag = `cls-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode() },
  });
  const market = await prisma.market.create({
    data: {
      polymarketId: `${tag}-m`,
      question: "exit close booking test",
      status: "OPEN",
      resolutionDeadline: new Date(Date.now() + 3_600_000),
    },
  });

  // A second market: the dust case needs its own position, and one REAL bet per (user, market).
  const dustMarket = await prisma.market.create({
    data: {
      polymarketId: `${tag}-dust`,
      question: "exit dust write-off test",
      status: "OPEN",
      resolutionDeadline: new Date(Date.now() + 3_600_000),
    },
  });

  try {
    const utcDay = new Date().toISOString().slice(0, 10);
    const bet = await prisma.bet.create({
      data: {
        userId: user.id,
        marketId: market.id,
        side: "YES",
        mode: "REAL",
        stakeCents: 1000,
        lockedPriceBp: 5200,
        utcDay,
        filledSharesMicro: 5_000_000n,
        spendMicro: 2_600_000n,
        feeMicro: 87_360n,
        vwapBp: 5200,
      },
    });

    const mkAttempt = () =>
      prisma.orderAttempt.create({
        data: {
          userId: user.id,
          marketId: market.id,
          dir: "EXIT",
          side: "YES",
          tokenId: "tok-1",
          idempotencyKey: crypto.randomUUID(),
          approvedParams: {},
          allInCapMicro: 2_500_000n,
          maxPriceBp: 4800,
          state: "SUBMITTING",
          betId: bet.id,
        },
      });

    // a) Partial close: 2M of 5M shares → PARTIAL, exact realized PnL.
    const a1 = await mkAttempt();
    const s1 = await bookExitFills(prisma, a1, 5_000_000n, [
      { externalFillId: `${tag}-c1`, sharesMicro: 2_000_000n, amountMicro: 1_000_000n, feeMicro: 35_000n, priceBp: 5000, ts: new Date() },
    ]);
    assert.strictEqual(s1, "PARTIAL");
    let betRow = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    assert.strictEqual(betRow.closedSharesMicro, 2_000_000n);
    assert.strictEqual(betRow.proceedsMicro, 1_000_000n);
    assert.strictEqual(betRow.closeFeeMicro, 35_000n);
    // Fee-inclusive basis: 1,000,000 − 35,000 − ((2,600,000+87,360 entry fee)×2M/5M = 1,074,944) = −109,944.
    assert.strictEqual(betRow.realizedPnlMicro, -109_944n, "realized PnL exact, entry fee in basis");

    // b) Replayed receipt: fill row deduped AND the aggregate does NOT double-book — increments
    // are driven only by fills actually inserted (the executor's own test surfaced the original
    // double-book; fixed in review).
    const s2 = await bookExitFills(prisma, a1, 5_000_000n, [
      { externalFillId: `${tag}-c1`, sharesMicro: 2_000_000n, amountMicro: 1_000_000n, feeMicro: 35_000n, priceBp: 5000, ts: new Date() },
    ]);
    assert.strictEqual(s2, "PARTIAL", "replay reports the attempt's existing state");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a1.id } }), 1, "fill row deduped");
    betRow = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    assert.strictEqual(betRow.closedSharesMicro, 2_000_000n, "aggregate NOT double-booked on replay");
    assert.strictEqual(betRow.realizedPnlMicro, -109_944n, "PnL unchanged on replay");

    // c) Overshoot clamp: a fill larger than the remainder books only the remainder — the CHECK
    // constraint closedShares <= filledShares can never trip.
    const a2 = await mkAttempt();
    const s3 = await bookExitFills(prisma, a2, 5_000_000n, [
      { externalFillId: `${tag}-c2`, sharesMicro: 10_000_000n, amountMicro: 5_000_000n, feeMicro: 175_000n, priceBp: 5000, ts: new Date() },
    ]);
    assert.strictEqual(s3, "FILLED", "10M fresh shares >= 5M requested → FILLED (booked clamped)");
    betRow = await prisma.bet.findUniqueOrThrow({ where: { id: bet.id } });
    assert.ok(betRow.closedSharesMicro! <= betRow.filledSharesMicro!, "clamp holds");
    assert.strictEqual(betRow.closedSharesMicro, 5_000_000n, "closed exactly to the remainder");
    // The clamp means the exchange sold more than the position held — never silent (Sol S6/S7).
    const a2row = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a2.id } });
    assert.ok(a2row.error?.startsWith("clamped:"), "clamp is recorded on the attempt");
    // The remainder here is 3M (step (a) already closed 2M of the 5M position), not the 5M total.
    assert.ok(a2row.error?.includes("10000000") && a2row.error.includes("3000000"), "and names fill vs remainder");

    // d) Zero fills → KILLED.
    const a3 = await mkAttempt();
    const s4 = await bookExitFills(prisma, a3, 5_000_000n, []);
    assert.strictEqual(s4, "KILLED");

    // ---- e) Cumulative EXIT receipts: the CLOB reports the ORDER's running totals, so a grown
    // receipt must book the DELTA and the FILLED label must come from cumulative shares. Own
    // position (the seeded one is fully closed by step (c)).
    const market2 = await prisma.market.create({
      data: {
        polymarketId: `${tag}-m2`,
        question: "exit cumulative receipt test",
        status: "OPEN",
        resolutionDeadline: new Date(Date.now() + 3_600_000),
      },
    });
    const bet2 = await prisma.bet.create({
      data: {
        userId: user.id,
        marketId: market2.id,
        side: "YES",
        mode: "REAL",
        stakeCents: 1000,
        lockedPriceBp: 5200,
        utcDay,
        filledSharesMicro: 4_000_000n,
        spendMicro: 2_000_000n,
        feeMicro: 60_000n,
        vwapBp: 5000,
      },
    });
    const attempt2 = await prisma.orderAttempt.create({
      data: {
        userId: user.id,
        marketId: market2.id,
        dir: "EXIT",
        side: "YES",
        tokenId: "tok-1",
        idempotencyKey: crypto.randomUUID(),
        approvedParams: {},
        allInCapMicro: 2_000_000n,
        maxPriceBp: 4800,
        state: "SUBMITTING",
        betId: bet2.id,
      },
    });

    // Receipt #1 — 2 shares at 0.50 → PARTIAL.
    const r1 = classifyPostResponse(
      { ok: true, status: "matched", orderId: `${tag}-x`, makingAmount: "2", takingAmount: "1", tradeIds: [`${tag}-x-t1`] },
      "EXIT",
      `${tag}-x`,
      null,
    );
    if (r1.kind !== "matched") throw new Error("receipt #1 not matched");
    const s5 = await bookExitFills(prisma, attempt2, 4_000_000n, r1.fills, { cumulative: true });
    assert.strictEqual(s5, "PARTIAL", "2 of 4 shares → PARTIAL");

    // Receipt #2 — same order grown to 4 shares / $2, a second trade id → FILLED.
    const r2 = classifyPostResponse(
      {
        ok: true,
        status: "matched",
        orderId: `${tag}-x`,
        makingAmount: "4",
        takingAmount: "2",
        tradeIds: [`${tag}-x-t1`, `${tag}-x-t2`],
      },
      "EXIT",
      `${tag}-x`,
      null,
    );
    if (r2.kind !== "matched") throw new Error("receipt #2 not matched");
    const s6 = await bookExitFills(prisma, attempt2, 4_000_000n, r2.fills, { cumulative: true });
    assert.strictEqual(s6, "FILLED", "cumulative 4 of 4 → FILLED");

    const fills2 = await prisma.fill.findMany({ where: { attemptId: attempt2.id } });
    assert.strictEqual(fills2.length, 2, "two fill rows");
    assert.strictEqual(fills2.reduce((s, f) => s + f.sharesMicro, 0n), 4_000_000n, "shares sum = 4M");
    assert.strictEqual(fills2.reduce((s, f) => s + f.amountMicro, 0n), 2_000_000n, "delta booked, not the whole 4 again");

    const bet2Row = await prisma.bet.findUniqueOrThrow({ where: { id: bet2.id } });
    assert.strictEqual(bet2Row.closedSharesMicro, 4_000_000n, "fully closed");
    assert.strictEqual(bet2Row.proceedsMicro, 2_000_000n, "proceeds = $2");
    assert.strictEqual(bet2Row.realizedPnlMicro, -60_000n, "PnL = proceeds − basis incl. entry fee");

    // No clamp on this position → the attempt's error stays null (a stale clamp must not stick).
    assert.strictEqual(
      (await prisma.orderAttempt.findUniqueOrThrow({ where: { id: attempt2.id } })).error,
      null,
      "an unclamped close records no error",
    );

    const s7 = await bookExitFills(prisma, attempt2, 4_000_000n, r2.fills, { cumulative: true });
    assert.strictEqual(s7, "FILLED", "replay reports FILLED");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: attempt2.id } }), 2, "no third fill row");

    // ---- 8. Sub-tick DUST. The signer works in 4-decimal shares, so a 1.333332-share position
    // (the shape a $1 buy actually produces) can only be sold down to 1.3333. Left behind, those 32
    // micro-shares are unsellable AND count as an open position, which locks the user out of that
    // market forever over three thousandths of a cent. They must be written off by the close, with
    // their basis realized as the loss it is.
    const dustBet = await prisma.bet.create({
      data: {
        userId: user.id,
        marketId: dustMarket.id,
        side: "YES",
        mode: "REAL",
        stakeCents: 100,
        lockedPriceBp: 7500,
        utcDay,
        filledSharesMicro: 1_333_332n,
        spendMicro: 999_999n,
        feeMicro: 12_500n,
        vwapBp: 7500,
      },
    });
    const dustAttempt = await prisma.orderAttempt.create({
      data: {
        userId: user.id,
        marketId: dustMarket.id,
        dir: "EXIT",
        side: "YES",
        tokenId: "tok-dust",
        idempotencyKey: crypto.randomUUID(),
        approvedParams: { sharesMicro: "1333300" },
        allInCapMicro: 1_000_000n,
        maxPriceBp: 7400,
        state: "POSTED",
        betId: dustBet.id,
      },
    });
    // The exchange sold exactly what was signed: 1.3333 shares at 0.74.
    const dustState = await bookExitFills(prisma, dustAttempt, 1_333_300n, [
      {
        externalFillId: `${tag}-dust`,
        sharesMicro: 1_333_300n,
        amountMicro: 986_642n,
        feeMicro: 12_000n,
        priceBp: 7400,
        ts: new Date(),
      },
    ]);
    assert.strictEqual(dustState, "FILLED", "sold every share it signed for");
    const dustRow = await prisma.bet.findUniqueOrThrow({ where: { id: dustBet.id } });
    assert.strictEqual(dustRow.closedSharesMicro, 1_333_332n, "the 32 micro-share remnant is written off, not left");
    assert.strictEqual(
      (dustRow.filledSharesMicro ?? 0n) - (dustRow.closedSharesMicro ?? 0n),
      0n,
      "no remainder survives to block a re-entry",
    );
    // Basis for 1_333_332 shares of a 1_012_499 spend: the dust carries its share of the cost and
    // brings no proceeds, so realized PnL is proceeds − close fee − the WHOLE basis.
    const dustBasis = ((999_999n + 12_500n) * 1_333_332n) / 1_333_332n;
    assert.strictEqual(dustRow.realizedPnlMicro, 986_642n - 12_000n - dustBasis, "dust realized at its own cost");
    // Selling out ENDS the position, so it is stamped like any settled bet — /api/results serves
    // SETTLED/VOID only, and without this an early close never appeared under "every call you've
    // made", while the history sheet (which derives status from the remainder) showed it.
    assert.strictEqual(dustRow.settlementStatus, "SETTLED", "a sold-out position is settled");
    assert.strictEqual(dustRow.result, "LOSS", "the LEDGER's outcome: this sale realized less than it cost");
    assert.strictEqual(dustRow.pnlCents, Number((dustRow.realizedPnlMicro ?? 0n) / 10_000n), "cents match the micros");
    assert.ok(dustRow.settledAt, "and it carries the moment it ended");

    // ---- 9. Server-side settlement of a RESOLVED position. A win is booked on PROOF that the
    // collateral moved — the outcome token has left the wallet, which is what Polymarket's
    // auto-redeemer does — never on the market's verdict alone. Live case that forced it: the market
    // resolved, the money arrived, and the app still said "awaiting result" with a Close button.
    const wonMarket = await prisma.market.create({
      data: {
        polymarketId: `${tag}-won`,
        question: "settled winner",
        status: "RESOLVED",
        resolvedOutcome: "NO",
        yesTokenId: `${tag}-yes`,
        noTokenId: `${tag}-no`,
        resolutionDeadline: new Date(Date.now() - 3_600_000),
      },
    });
    const wonBet = await prisma.bet.create({
      data: {
        userId: user.id,
        marketId: wonMarket.id,
        side: "NO", // the side the market resolved to
        mode: "REAL",
        stakeCents: 100,
        lockedPriceBp: 5200,
        utcDay,
        filledSharesMicro: 1_923_075n,
        spendMicro: 1_000_000n,
        feeMicro: 12_500n,
        vwapBp: 5200,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { depositWalletAddress: `0x${"ab".repeat(20)}` } });

    // Still holding the token: the redemption has not landed, so nothing is booked.
    const held = await settleResolvedRealPositions(prisma, async () => 1_923_075n);
    assert.strictEqual(held.won, 0, "a resolved winner is NOT booked while the token is still held");
    assert.strictEqual(held.winnersPending, 1);
    assert.strictEqual((await prisma.bet.findUniqueOrThrow({ where: { id: wonBet.id } })).closedSharesMicro, null);

    // Token gone → the redeemer burned it and sent the collateral. NOW it books.
    const settled = await settleResolvedRealPositions(prisma, async () => 0n);
    assert.strictEqual(settled.won, 1, "token gone from the wallet = the win is real");
    const wonRow = await prisma.bet.findUniqueOrThrow({ where: { id: wonBet.id } });
    assert.strictEqual(wonRow.closedSharesMicro, 1_923_075n, "position fully consumed");
    // 1.923075 shares × $1 − (spend + entry fee) = 1_923_075 − 1_012_500.
    assert.strictEqual(wonRow.realizedPnlMicro, 910_575n, "payout is $1/share, basis is fee-inclusive");
    assert.strictEqual(wonRow.settlementStatus, "SETTLED", "and it is stamped like a settled bet");
    assert.strictEqual(wonRow.result, "WIN");
    assert.strictEqual(wonRow.pnlCents, 91, "so the results inbox and the reveal can show it");
    assert.strictEqual(wonRow.seenAt, null, "unseen — that is what makes it a notification");

    // Idempotent: a second pass finds no remainder and books nothing.
    const again = await settleResolvedRealPositions(prisma, async () => 0n);
    assert.strictEqual(again.won, 0, "nothing left to consume");

    console.log("OK: exit validation + close booking, realized PnL exact, replay-safe, clamp holds");
    console.log("OK: a resolved winner books only once the outcome token has left the wallet");
    console.log("OK: a sub-tick remnant is written off so it cannot block the market forever");
    console.log("OK: cumulative EXIT receipts book the delta, label FILLED, close the position exactly");
    console.log("PASS: close");
  } finally {
    await prisma.fill.deleteMany({ where: { attempt: { userId: user.id } } });
    await prisma.orderAttempt.deleteMany({ where: { userId: user.id } });
    await prisma.bet.deleteMany({ where: { userId: user.id } });
    await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
    await prisma.market.deleteMany({ where: { polymarketId: { startsWith: tag } } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
