// scripts/test-reconcile.ts — reconciliation of POSTED attempts against the exchange's own trade
// records (plan §2.1 step 6 + pre-Gate-0 item 4). SDK-free: the probe is a plain async function
// the test supplies. Run: npx tsx scripts/test-reconcile.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { reconcileAttempt, reconcileStuckAttempts, type OrderProbe, type TradeRecord } from "../src/lib/reconcile";
import { feePerShareMicro } from "../src/lib/quote";

const FEE_EXP_MILLI = 1000;
const FEE_RATE_BP = 700;

// The two formulas the module documents, recomputed here so a drift in either fails loudly.
const tradeFee = (priceBp: number, sizeMicro: bigint): bigint =>
  (BigInt(feePerShareMicro(priceBp, FEE_RATE_BP, FEE_EXP_MILLI)) * sizeMicro + 999_999n) / 1_000_000n;
const entryNotional = (priceBp: number, sizeMicro: bigint): bigint => (sizeMicro * BigInt(priceBp) + 9_999n) / 10_000n;

async function main() {
  const tag = `rec-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode() },
  });
  const utcDay = new Date().toISOString().slice(0, 10);

  const mkMarket = (suffix: string) =>
    prisma.market.create({
      data: {
        polymarketId: `${tag}-${suffix}`,
        question: `reconcile test ${suffix}`,
        status: "OPEN",
        resolutionDeadline: new Date(Date.now() + 3_600_000),
        feeRateBp: FEE_RATE_BP,
        feeExpMilli: FEE_EXP_MILLI,
      },
    });
  const mkAttempt = (marketId: string, over: Record<string, unknown> = {}) =>
    prisma.orderAttempt.create({
      data: {
        userId: user.id,
        marketId,
        dir: "ENTRY",
        side: "YES",
        tokenId: "tok-1",
        idempotencyKey: crypto.randomUUID(),
        approvedParams: {},
        allInCapMicro: 10_000_000n,
        maxPriceBp: 5200,
        state: "POSTED",
        ...over,
      },
    });

  try {
    // ---- 1. Unknown probe → no writes at all. An unreachable exchange never moves money state.
    const m1 = await mkMarket("c1");
    const a1 = await mkAttempt(m1.id, { externalOrderId: `${tag}-o1` });
    assert.strictEqual(await reconcileAttempt(prisma, a1, async () => null, FEE_EXP_MILLI), "unknown");
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a1.id } })).state, "POSTED");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a1.id } }), 0, "no fills on unknown");

    // ---- 2. Matched but no trade records → unknown. Booking an unpriced fill is the one thing
    // this pass refuses to do.
    const m2 = await mkMarket("c2");
    const a2 = await mkAttempt(m2.id, { externalOrderId: `${tag}-o2` });
    const noTrades: OrderProbe = async () => ({ terminal: true, matchedSharesMicro: 5_000_000n, trades: [] });
    assert.strictEqual(await reconcileAttempt(prisma, a2, noTrades, FEE_EXP_MILLI), "unknown");
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a2.id } })).state, "POSTED");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a2.id } }), 0);

    // ---- 3. Terminal zero-match → KILLED, no position, slot freed.
    const m3 = await mkMarket("c3");
    const a3 = await mkAttempt(m3.id, { externalOrderId: `${tag}-o3` });
    const deadZero: OrderProbe = async () => ({ terminal: true, matchedSharesMicro: 0n, trades: [] });
    assert.strictEqual(await reconcileAttempt(prisma, a3, deadZero, FEE_EXP_MILLI), "killed");
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a3.id } })).state, "KILLED");
    assert.strictEqual(await prisma.bet.count({ where: { marketId: m3.id } }), 0, "no Bet on a killed zero-match");

    // ---- 4. Non-terminal zero-match → pending, untouched (a live order may still match).
    const m4 = await mkMarket("c4");
    const a4 = await mkAttempt(m4.id, { externalOrderId: `${tag}-o4` });
    const liveZero: OrderProbe = async () => ({ terminal: false, matchedSharesMicro: 0n, trades: [] });
    assert.strictEqual(await reconcileAttempt(prisma, a4, liveZero, FEE_EXP_MILLI), "pending");
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a4.id } })).state, "POSTED");

    // ---- 5. The core case: a receipt booked half the order with a WRONG fee estimate; the trade
    // records carry the truth. The delta lands as a new fill and the estimate is trued up.
    const m5 = await mkMarket("c5");
    const a5 = await mkAttempt(m5.id, {
      externalOrderId: `${tag}-o5`,
      approvedParams: { betSide: "YES", sharesMicro: "6000000" },
    });
    await prisma.fill.create({
      data: {
        attemptId: a5.id,
        externalFillId: `${tag}-recv`,
        sharesMicro: 3_000_000n,
        amountMicro: 1_560_000n,
        feeMicro: 999_999n, // deliberately absurd estimate
        priceBp: 5200,
        ts: new Date(),
      },
    });
    const bet5 = await prisma.bet.create({
      data: {
        userId: user.id,
        marketId: m5.id,
        side: "YES",
        mode: "REAL",
        stakeCents: 1000,
        lockedPriceBp: 5200,
        utcDay,
        filledSharesMicro: 3_000_000n,
        spendMicro: 1_560_000n,
        feeMicro: 999_999n,
        vwapBp: 5200,
      },
    });
    const a5row = await prisma.orderAttempt.update({ where: { id: a5.id }, data: { betId: bet5.id } });
    const trades5: TradeRecord[] = [
      { id: `${tag}-t1`, priceBp: 5200, sizeMicro: 3_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() },
      { id: `${tag}-t2`, priceBp: 5300, sizeMicro: 3_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() },
    ];
    const truth5: OrderProbe = async () => ({ terminal: true, matchedSharesMicro: 6_000_000n, trades: trades5 });
    assert.strictEqual(await reconcileAttempt(prisma, a5row, truth5, FEE_EXP_MILLI), "booked");

    const fills5 = await prisma.fill.findMany({ where: { attemptId: a5.id }, orderBy: { createdAt: "asc" } });
    assert.strictEqual(fills5.length, 2, "receipt row + one delta row");
    assert.strictEqual(fills5.reduce((s, f) => s + f.sharesMicro, 0n), 6_000_000n, "shares sum = the order total");
    const notional5 = trades5.reduce((s, t) => s + entryNotional(t.priceBp, t.sizeMicro), 0n);
    assert.strictEqual(fills5.reduce((s, f) => s + f.amountMicro, 0n), notional5, "amount sum = trades' notional");
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a5.id } })).state, "FILLED");

    const bet5row = await prisma.bet.findUniqueOrThrow({ where: { id: bet5.id } });
    const trueFee5 = trades5.reduce((s, t) => s + tradeFee(t.priceBp, t.sizeMicro), 0n);
    assert.strictEqual(bet5row.filledSharesMicro, 6_000_000n);
    assert.strictEqual(bet5row.spendMicro, notional5);
    assert.strictEqual(bet5row.feeMicro, trueFee5, "aggregate fee = the CHARGED total");
    assert.strictEqual(trueFee5, 104_727n, "literal true fee so a formula drift fails");
    assert.ok((bet5row.feeMicro ?? 0n) < 999_999n, "the estimate was corrected DOWNWARD");
    const fills5after = await prisma.fill.findMany({ where: { attemptId: a5.id } });
    assert.strictEqual(
      fills5after.reduce((s, f) => s + f.feeMicro, 0n),
      bet5row.feeMicro,
      "ledger and aggregate agree after the true-up",
    );

    // ---- 6. EXIT: the shares were already booked, so only the fee is wrong — the true-up must
    // move realized PnL by exactly the charged close fee.
    const m6 = await mkMarket("c6");
    const bet6 = await prisma.bet.create({
      data: {
        userId: user.id,
        marketId: m6.id,
        side: "YES",
        mode: "REAL",
        stakeCents: 1000,
        lockedPriceBp: 5000,
        utcDay,
        filledSharesMicro: 4_000_000n,
        spendMicro: 2_000_000n,
        feeMicro: 60_000n,
        vwapBp: 5000,
        closedSharesMicro: 4_000_000n,
        proceedsMicro: 2_000_000n,
        closeFeeMicro: 0n,
        realizedPnlMicro: -60_000n,
      },
    });
    const a6 = await mkAttempt(m6.id, {
      dir: "EXIT",
      externalOrderId: `${tag}-o6`,
      approvedParams: { sharesMicro: "4000000" },
      betId: bet6.id,
    });
    await prisma.fill.create({
      data: {
        attemptId: a6.id,
        externalFillId: `${tag}-recv6`,
        sharesMicro: 4_000_000n,
        amountMicro: 2_000_000n,
        feeMicro: 0n, // the receipt had no fee params — zero, and wrong
        priceBp: 5000,
        ts: new Date(),
      },
    });
    const truth6: OrderProbe = async () => ({
      terminal: true,
      matchedSharesMicro: 4_000_000n,
      trades: [{ id: `${tag}-t6`, priceBp: 5000, sizeMicro: 4_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() }],
    });
    assert.strictEqual(await reconcileAttempt(prisma, a6, truth6, FEE_EXP_MILLI), "booked");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a6.id } }), 1, "zero share delta → no new row");
    const trueFee6 = tradeFee(5000, 4_000_000n);
    const bet6row = await prisma.bet.findUniqueOrThrow({ where: { id: bet6.id } });
    assert.strictEqual(bet6row.closeFeeMicro, trueFee6, "close fee = the charged fee");
    assert.strictEqual(bet6row.realizedPnlMicro, -60_000n - trueFee6, "realized PnL dropped by exactly that fee");

    // ---- 7. Sweep selection: attempts that carry an exchange order id and are worth asking about —
    // POSTED (verdict still unknown) plus FILLED/PARTIAL (booked, but their fee is still the
    // ESTIMATE until the charged one replaces it). A SUBMITTING attempt has nothing to ask about, a
    // POSTED one without an id likewise, and anything older than 48h is settled history.
    const m7a = await mkMarket("c7a");
    await mkAttempt(m7a.id, { externalOrderId: `${tag}-o7a` });
    const m7b = await mkMarket("c7b");
    await mkAttempt(m7b.id, { state: "SUBMITTING", externalOrderId: `${tag}-o7b` });
    const m7c = await mkMarket("c7c");
    await mkAttempt(m7c.id); // POSTED, no order id
    const m7d = await mkMarket("c7d");
    const a7d = await mkAttempt(m7d.id, { state: "FILLED", externalOrderId: `${tag}-o7d` });
    const m7e = await mkMarket("c7e");
    const a7e = await mkAttempt(m7e.id, { state: "FILLED", externalOrderId: `${tag}-o7e` });
    // Nudged past the floor: a fee trued up two days ago must not be rescanned every pass.
    await prisma.orderAttempt.update({
      where: { id: a7e.id },
      data: { updatedAt: new Date(Date.now() - 49 * 60 * 60_000) },
    });
    const window = { lt: new Date(), gt: new Date(Date.now() - 48 * 60 * 60_000) };
    const eligible = await prisma.orderAttempt.count({
      where: {
        state: { in: ["POSTED", "FILLED", "PARTIAL"] },
        externalOrderId: { not: null },
        updatedAt: window,
      },
    });
    const swept = await reconcileStuckAttempts(prisma, async () => null, { minAgeMs: 0, limit: 50 });
    assert.strictEqual(swept.scanned, eligible, "scanned exactly the id-carrying attempts inside the window");
    assert.ok(
      await prisma.orderAttempt
        .findMany({ where: { id: { in: [a7d.id, a7e.id] } }, select: { id: true, updatedAt: true } })
        .then((rows) => rows.length === 2),
      "both FILLED fixtures still exist — one inside the window, one past the floor",
    );
    assert.ok(swept.scanned >= 1);
    assert.strictEqual(swept.unknown, swept.scanned, "a null probe leaves everything unknown");

    console.log("OK: unknown probe / matched-without-trades / terminal + live zero-match verdicts");
    console.log("OK: trade records replace the receipt estimate — delta booked, fee trued up");
    console.log("OK: EXIT true-up moves realized PnL by the charged close fee");
    console.log("OK: the sweep selects id-carrying POSTED/FILLED/PARTIAL attempts inside the 48h window");
    console.log("PASS: reconcile");
  } finally {
    await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
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
