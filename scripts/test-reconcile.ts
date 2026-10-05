// scripts/test-reconcile.ts — reconciliation of POSTED attempts against the exchange's own trade
// records (plan §2.1 step 6 + pre-Gate-0 item 4). SDK-free: the probe is a plain async function
// the test supplies. Run: npx tsx scripts/test-reconcile.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import {
  reconcileAttempt,
  reconcileStuckAttempts,
  resolveOrphanAttempt,
  discoverOrphanAttempts,
  confirmReportedAttempts,
  REPORTED_UNVERIFIED_PREFIX,
  type ReportedConfirm,
  type OrderProbe,
  type OrphanDiscover,
  type TradeRecord,
} from "../src/lib/reconcile";
import { feePerShareMicro } from "../src/lib/quote";
import { trueUpAttemptFee } from "../src/lib/orders";

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
        approvedParams: { feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
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
      approvedParams: { betSide: "YES", sharesMicro: "6000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
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

    // ---- 5b. A terminal verdict with trade records stamps reconciledAt, so the sweep stops
    // re-probing the attempt every pass: a spy probe must never be asked about it again.
    const a5stamped = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a5.id } });
    assert.notStrictEqual(a5stamped.reconciledAt, null, "terminal trade records stamp reconciledAt");
    const probedIds: string[] = [];
    const spy: typeof truth5 = async (a) => {
      probedIds.push(a.id);
      return truth5(a);
    };
    await reconcileStuckAttempts(prisma, spy, { minAgeMs: 0, limit: 50 });
    assert.ok(!probedIds.includes(a5.id), "a reconciled attempt is not probed again");
    console.log("OK: a reconciled attempt is not probed again");

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
      approvedParams: { sharesMicro: "4000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
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
    // POSTED one without an id likewise. Age has no upper bound: unresolved money state must not
    // disappear merely because it has been ambiguous for more than 48 hours.
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
    // Forty-nine hours old is still unresolved and therefore still eligible.
    await prisma.orderAttempt.update({
      where: { id: a7e.id },
      data: { updatedAt: new Date(Date.now() - 49 * 60 * 60_000) },
    });
    const m7old = await mkMarket("c7old");
    const a7old = await mkAttempt(m7old.id, {
      externalOrderId: `${tag}-o7old`,
      approvedParams: { betSide: "YES", sharesMicro: "1000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
    });
    await prisma.orderAttempt.update({
      where: { id: a7old.id },
      data: { updatedAt: new Date(Date.now() - 49 * 24 * 60 * 60_000) },
    });
    const window = { lt: new Date() };
    // Mirrors the sweep's own predicate: a booked attempt stays eligible only until its terminal
    // trade records were booked (reconciledAt).
    const eligible = await prisma.orderAttempt.count({
      where: {
        OR: [{ state: "POSTED" }, { state: { in: ["FILLED", "PARTIAL"] }, reconciledAt: null }],
        externalOrderId: { not: null },
        updatedAt: window,
      },
    });
    await prisma.sweepCursor.deleteMany({ where: { name: { in: ["polymarket-order-reconcile-v1", "polymarket-orphan-sweep-v1", "polymarket-reported-fast-v1"] } } });
    const swept = await reconcileStuckAttempts(prisma, async (attempt) => attempt.id === a7old.id ? {
      terminal: true,
      matchedSharesMicro: 1_000_000n,
      trades: [{ id: `${tag}-t7old`, priceBp: 5000, sizeMicro: 1_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() }],
    } : null, { minAgeMs: 0, limit: 50 });
    assert.strictEqual(swept.scanned, eligible, "scanned every old id-carrying unresolved attempt");
    assert.ok(
      await prisma.orderAttempt
        .findMany({ where: { id: { in: [a7d.id, a7e.id] } }, select: { id: true, updatedAt: true } })
        .then((rows) => rows.length === 2),
      "both FILLED fixtures still exist and remain eligible regardless of age",
    );
    assert.ok(swept.scanned >= 1);
    assert.strictEqual(swept.booked, 1, "a 49-day POSTED attempt is still scanned and booked");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a7old.id } }), 1, "the old fill is durable");
    assert.strictEqual(swept.unknown, swept.scanned - 1, "other null probes remain unknown");

    // ---- 7b. The PLATFORM fee comes from the INTENT's rate, not from the trade record. Live on
    // 2026-08-17: the exchange's trade carried feeRateBps 0 while the chain showed $0.012490
    // charged — that field is the BUILDER's rate (zero for us), and reading it as the platform's
    // booked a real fill at zero fee and understated the position's basis by exactly the fee.
    // Here the trade reports 0 and the intent says 700bp: the fee must still be the 700bp number.
    const m7f = await mkMarket("c7f");
    const a7f = await mkAttempt(m7f.id, {
      externalOrderId: `${tag}-o7f`,
      approvedParams: { betSide: "YES", sharesMicro: "2000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
    });
    const zeroRateTrade: OrderProbe = async () => ({
      terminal: true,
      matchedSharesMicro: 2_000_000n,
      trades: [{ id: `${tag}-t7f`, priceBp: 5000, sizeMicro: 2_000_000n, feeRateBp: 0, ts: new Date() }],
    });
    assert.strictEqual(await reconcileAttempt(prisma, a7f, zeroRateTrade, FEE_EXP_MILLI), "booked");
    const fill7f = await prisma.fill.findFirstOrThrow({ where: { attemptId: a7f.id } });
    assert.strictEqual(fill7f.feeMicro, tradeFee(5000, 2_000_000n), "fee from the intent's rate, not the trade's 0");
    assert.ok(fill7f.feeMicro > 0n, "a zero on the trade record must not book a free fill");

    // ---- 7c. FILLED vs PARTIAL is judged against the SIGNED size, not the intent's prediction.
    // A fully matched order came back one micro-share under the prediction and sat as PARTIAL.
    // The replay path also refreshes the label, so a corrected rule heals rows it mislabelled.
    const m7g = await mkMarket("c7g");
    const a7g = await mkAttempt(m7g.id, {
      externalOrderId: `${tag}-o7g`,
      approvedParams: { betSide: "YES", sharesMicro: "1333333", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
      signedOrder: { makerAmount: "1000000", takerAmount: "1333332", side: "BUY" },
    });
    const shortByOne: OrderProbe = async () => ({
      terminal: true,
      matchedSharesMicro: 1_333_332n,
      trades: [{ id: `${tag}-t7g`, priceBp: 7500, sizeMicro: 1_333_332n, feeRateBp: 0, ts: new Date() }],
    });
    assert.strictEqual(await reconcileAttempt(prisma, a7g, shortByOne, FEE_EXP_MILLI), "booked");
    assert.strictEqual(
      (await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a7g.id } })).state,
      "FILLED",
      "matched every share it signed for",
    );
    // Re-running against the same trade set books nothing and must keep the label — and would have
    // repaired it had the first pass got it wrong.
    assert.strictEqual(await reconcileAttempt(prisma, a7g, shortByOne, FEE_EXP_MILLI), "booked");
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a7g.id } })).state, "FILLED");
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a7g.id } }), 1, "replay booked no second fill");

    // ---- 8. Orphan discovery. The browser posts the order now, so an attempt can be left
    // SUBMITTING with no externalOrderId — invisible to the sweep above (it filters on that column)
    // and holding this user's in-flight slot on that market forever. These are the four answers.

    // 8a. Unknown discovery is inert: an unreachable exchange must never move money state.
    const m8a = await mkMarket("c8a");
    const a8a = await mkAttempt(m8a.id, {
      state: "SUBMITTING",
      approvedParams: { betSide: "YES", sharesMicro: "6000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
    });
    assert.strictEqual(await resolveOrphanAttempt(prisma, a8a, async () => null, async () => null, FEE_EXP_MILLI), "unknown");
    const a8aRow = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a8a.id } });
    assert.strictEqual(a8aRow.state, "SUBMITTING", "unknown discovery leaves the state untouched");
    assert.strictEqual(a8aRow.externalOrderId, null);
    assert.strictEqual(await prisma.fill.count({ where: { attemptId: a8a.id } }), 0, "no fills on unknown discovery");

    // 8b. A DEFINITIVE absence kills the attempt and hands the daily-cap slot back — nothing was
    // posted, so no money moved and the market must be swipeable again.
    const m8b = await mkMarket("c8b");
    const a8b = await mkAttempt(m8b.id, {
      state: "SUBMITTING",
      approvedParams: { betSide: "YES", sharesMicro: "6000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
    });
    await prisma.dailyCounter.upsert({
      where: { userId_utcDay: { userId: user.id, utcDay } },
      create: { userId: user.id, utcDay, swipeCount: 1 }, // the slot /api/real/submit reserved
      update: { swipeCount: 1 },
    });
    assert.strictEqual(
      await resolveOrphanAttempt(prisma, a8b, async () => ({ orderId: null }), async () => null, FEE_EXP_MILLI),
      "killed",
    );
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a8b.id } })).state, "KILLED");
    assert.strictEqual(await prisma.bet.count({ where: { marketId: m8b.id } }), 0, "no position on a killed orphan");
    const counter8b = await prisma.dailyCounter.findUnique({
      where: { userId_utcDay: { userId: user.id, utcDay } },
    });
    assert.strictEqual(counter8b?.swipeCount ?? -1, 0, "the reserved swipe slot came back");

    // 8c. A FOUND order is adopted and booked — the id came from a client, every NUMBER from the
    // exchange's own trade records.
    const m8c = await mkMarket("c8c");
    const a8c = await mkAttempt(m8c.id, {
      state: "SUBMITTING",
      approvedParams: { betSide: "YES", sharesMicro: "6000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
    });
    const discover8c: OrphanDiscover = async () => ({
      orderId: `${tag}-orphan`,
      order: { id: `${tag}-orphan`, status: "matched" },
    });
    const probe8c: OrderProbe = async () => ({
      terminal: true,
      matchedSharesMicro: 6_000_000n,
      trades: [{ id: `${tag}-t8c`, priceBp: 5200, sizeMicro: 6_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() }],
    });
    assert.strictEqual(await resolveOrphanAttempt(prisma, a8c, discover8c, probe8c, FEE_EXP_MILLI), "adopted");
    const a8cRow = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a8c.id } });
    assert.strictEqual(a8cRow.externalOrderId, `${tag}-orphan`, "the adopted attempt carries the exchange id");
    assert.strictEqual(a8cRow.state, "FILLED");
    const fills8c = await prisma.fill.findMany({ where: { attemptId: a8c.id } });
    assert.strictEqual(fills8c.length, 1, "exactly one fill booked");
    assert.strictEqual(fills8c[0].sharesMicro, 6_000_000n);
    assert.strictEqual(fills8c[0].amountMicro, entryNotional(5200, 6_000_000n));
    const bet8c = await prisma.bet.findUniqueOrThrow({
      where: { userId_marketId_mode: { userId: user.id, marketId: m8c.id, mode: "REAL" } },
    });
    assert.strictEqual(bet8c.filledSharesMicro, 6_000_000n);
    assert.strictEqual(bet8c.feeMicro, tradeFee(5200, 6_000_000n), "the CHARGED fee, not the estimate");

    // 8d. One exchange order can never be bound to two attempts — adopting it would book the same
    // fills twice, so the unique index throws P2002 and discovery backs off.
    const m8d1 = await mkMarket("c8d1");
    await mkAttempt(m8d1.id, { externalOrderId: `${tag}-taken` });
    const m8d2 = await mkMarket("c8d2");
    const a8d = await mkAttempt(m8d2.id, { state: "SUBMITTING" });
    assert.strictEqual(
      await resolveOrphanAttempt(
        prisma,
        a8d,
        async () => ({ orderId: `${tag}-taken`, order: {} }),
        async () => null,
        FEE_EXP_MILLI,
      ),
      "unknown",
    );
    const a8dRow = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a8d.id } });
    assert.strictEqual(a8dRow.state, "SUBMITTING", "an already-bound id leaves the orphan untouched");
    assert.strictEqual(a8dRow.externalOrderId, null);

    // 8e. Sweep selection: SUBMITTING rows with NO id, which is exactly the set the reconcile sweep
    // above cannot see. A null discover changes nothing about them.
    const orphanCount = await prisma.orderAttempt.count({ where: { state: "SUBMITTING", externalOrderId: null } });
    assert.ok(orphanCount >= 1, "at least one orphan is on the table");
    const sweptOrphans = await discoverOrphanAttempts(prisma, async () => null, async () => null, {
      minAgeMs: 0,
      limit: 50,
    });
    assert.strictEqual(sweptOrphans.scanned, orphanCount, "scanned exactly the id-less SUBMITTING attempts");
    assert.strictEqual(sweptOrphans.unknown, sweptOrphans.scanned, "a null discover leaves everything unknown");

    // ---- 9. The reported-id fast pass: it can only ADOPT. Rows carry the id /api/real/posted wrote
    // under REPORTED_UNVERIFIED_PREFIX; anything without it is invisible to this pass.
    const params9 = { betSide: "YES", sharesMicro: "6000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI };
    const m9a = await mkMarket("c9a");
    const a9a = await mkAttempt(m9a.id, { state: "SUBMITTING", approvedParams: params9, error: `${REPORTED_UNVERIFIED_PREFIX}${tag}-r9a` });
    const m9b = await mkMarket("c9b");
    const a9b = await mkAttempt(m9b.id, { state: "SUBMITTING", approvedParams: params9, error: `${REPORTED_UNVERIFIED_PREFIX}${tag}-r9b` });
    const m9c = await mkMarket("c9c");
    const a9c = await mkAttempt(m9c.id, { state: "SUBMITTING", approvedParams: params9, error: `${REPORTED_UNVERIFIED_PREFIX}${tag}-r9c` });
    const m9d = await mkMarket("c9d");
    const a9d = await mkAttempt(m9d.id, { state: "SUBMITTING", approvedParams: params9 }); // never reported

    const asked: string[] = [];
    const confirm9: ReportedConfirm = async (attempt, orderId) => {
      asked.push(orderId);
      if (attempt.id === a9a.id) return { ok: false, reason: "unverifiable" };
      if (attempt.id === a9b.id) return { ok: true, order: { id: orderId, source: "trade-evidence" } };
      if (attempt.id === a9c.id) return { ok: false, reason: "mismatch", detail: "maker differs" };
      throw new Error(`asked about an unreported attempt ${attempt.id}`);
    };
    const probe9: OrderProbe = async (attempt) =>
      attempt.id === a9b.id
        ? {
            terminal: true,
            matchedSharesMicro: 6_000_000n,
            trades: [{ id: `${tag}-t9b`, priceBp: 5200, sizeMicro: 6_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() }],
          }
        : null;
    const fast = await confirmReportedAttempts(prisma, confirm9, probe9, { minAgeMs: 0, limit: 50 });
    assert.deepStrictEqual(
      { confirmed: fast.confirmed, pending: fast.pending, mismatch: fast.mismatch, scanned: fast.scanned },
      { confirmed: 1, pending: 1, mismatch: 1, scanned: 3 },
      "only the three reported rows are scanned",
    );
    assert.deepStrictEqual(asked.sort(), [`${tag}-r9a`, `${tag}-r9b`, `${tag}-r9c`].sort(), "each asked by its REPORTED id");

    // 9a. Unverifiable → untouched: still SUBMITTING, still carrying its reported id. Never killed.
    const a9aRow = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a9a.id } });
    assert.strictEqual(a9aRow.state, "SUBMITTING");
    assert.strictEqual(a9aRow.error, `${REPORTED_UNVERIFIED_PREFIX}${tag}-r9a`);
    // 9b. Proven → bound to the reported id and booked from the exchange's trades; the marker is cleared.
    const a9bRow = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a9b.id } });
    assert.strictEqual(a9bRow.externalOrderId, `${tag}-r9b`);
    assert.strictEqual(a9bRow.state, "FILLED");
    assert.strictEqual(a9bRow.error, null);
    const bet9b = await prisma.bet.findUniqueOrThrow({
      where: { userId_marketId_mode: { userId: user.id, marketId: m9b.id, mode: "REAL" } },
    });
    assert.strictEqual(bet9b.filledSharesMicro, 6_000_000n, "the position shows up");
    // 9c. A mismatch is recorded and drops out of the fast pass; the row stays for the orphan sweep.
    const a9cRow = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a9c.id } });
    assert.strictEqual(a9cRow.state, "SUBMITTING");
    assert.strictEqual(a9cRow.externalOrderId, null);
    assert.ok(a9cRow.error?.startsWith("order_mismatch:"), "the mismatch is on the row");
    // 9d. The unreported orphan was never touched by this pass.
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a9d.id } })).state, "SUBMITTING");
    // A second pass sees only the still-unverified row.
    const again = await confirmReportedAttempts(prisma, async () => ({ ok: false, reason: "unverifiable" }), probe9, { minAgeMs: 0 });
    assert.strictEqual(again.scanned, 1);
    // The age floor keeps a row the posted route is still working on out of the pass.
    const young = await confirmReportedAttempts(prisma, confirm9, probe9, { minAgeMs: 3_600_000 });
    assert.strictEqual(young.scanned, 0);
    // The upper age bound hands an old unproven row to the orphan sweep: past maxAgeMs it is not scanned.
    const stale = await confirmReportedAttempts(prisma, confirm9, probe9, { minAgeMs: 0, maxAgeMs: 1 });
    assert.strictEqual(stale.scanned, 0, "a row older than maxAgeMs is out of the fast pass");
    console.log("OK: reported-id fast pass — adopts a proven id, leaves the unverifiable alone, records a mismatch, never kills");

    // ---- 10. The orphan sweep's kill on a STALE snapshot: the fast pass adopted the row after the
    // sweep read it. The kill must back off rather than kill an adopted (possibly filled) order.
    const m10 = await mkMarket("c10");
    const a10 = await mkAttempt(m10.id, { state: "SUBMITTING", approvedParams: params9, error: `${REPORTED_UNVERIFIED_PREFIX}${tag}-r10` });
    const snapshot10 = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a10.id } });
    await prisma.orderAttempt.update({ where: { id: a10.id }, data: { state: "POSTED", externalOrderId: `${tag}-r10`, error: null } });
    assert.strictEqual(
      await resolveOrphanAttempt(prisma, snapshot10, async () => ({ orderId: null }), async () => null, FEE_EXP_MILLI),
      "unknown",
    );
    const a10Row = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a10.id } });
    assert.strictEqual(a10Row.state, "POSTED", "an adopted row is never killed off a stale snapshot");
    assert.strictEqual(a10Row.externalOrderId, `${tag}-r10`);
    console.log("OK: the orphan kill re-claims the row first — it never kills what the fast pass adopted");

    // ---- 11. A late report the sweep's snapshot predates: the row is still SUBMITTING and unbound,
    // but now carries a reported id waiting to be proven. The orphan kill must refuse it.
    const m11 = await mkMarket("c11");
    const a11 = await mkAttempt(m11.id, { state: "SUBMITTING", approvedParams: params9 });
    const snapshot11 = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a11.id } });
    await prisma.orderAttempt.update({ where: { id: a11.id }, data: { error: `${REPORTED_UNVERIFIED_PREFIX}${tag}-r11` } });
    assert.strictEqual(
      await resolveOrphanAttempt(prisma, snapshot11, async () => ({ orderId: null }), async () => null, FEE_EXP_MILLI),
      "unknown",
    );
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a11.id } })).state, "SUBMITTING", "a reported row is never killed");
    console.log("OK: the orphan kill refuses a row carrying a reported id");

    // ---- 12. A stale mismatch must not erase a newer report: while the pass was verifying X, the
    // phone reported Y. The mismatch write is conditional on the marker it read.
    const m12 = await mkMarket("c12");
    const a12 = await mkAttempt(m12.id, { state: "SUBMITTING", approvedParams: params9, error: `${REPORTED_UNVERIFIED_PREFIX}${tag}-x12` });
    const newer = `${REPORTED_UNVERIFIED_PREFIX}${tag}-y12`;
    const racing: ReportedConfirm = async (attempt) => {
      if (attempt.id !== a12.id) return { ok: false, reason: "unverifiable" };
      await prisma.orderAttempt.update({ where: { id: a12.id }, data: { error: newer } }); // the re-report lands
      return { ok: false, reason: "mismatch", detail: "x was not ours" };
    };
    await confirmReportedAttempts(prisma, racing, async () => null, { minAgeMs: 0, limit: 50 });
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a12.id } })).error, newer, "the newer report survives");
    console.log("OK: the fast pass only rewrites the exact marker it read");

    // ---- 13. Two reconciliations race: B read the WHOLE fill (10 shares) and booked it with the
    // full fee; A had read it while only 4 shares were indexed and applies its fee true-up late.
    // A's correction (and its "reconciled" stamp) must be refused: it would cut the fee to the
    // partial fill's and close the attempt on a stale view.
    const m13 = await mkMarket("c13");
    const a13 = await mkAttempt(m13.id, {
      externalOrderId: `${tag}-o13`,
      approvedParams: { betSide: "YES", sharesMicro: "10000000", feeRateBp: FEE_RATE_BP, feeExpMilli: FEE_EXP_MILLI },
    });
    const full13: OrderProbe = async () => ({
      terminal: false, // not stamped by B either, so the test can see whether A stamps
      matchedSharesMicro: 10_000_000n,
      trades: [
        { id: `${tag}-t13a`, priceBp: 5200, sizeMicro: 4_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() },
        { id: `${tag}-t13b`, priceBp: 5200, sizeMicro: 6_000_000n, feeRateBp: FEE_RATE_BP, ts: new Date() },
      ],
    });
    assert.strictEqual(await reconcileAttempt(prisma, a13, full13, FEE_EXP_MILLI), "booked");
    const feeAfterB = (await prisma.fill.findMany({ where: { attemptId: a13.id } })).reduce((s, f) => s + f.feeMicro, 0n);
    assert.strictEqual(feeAfterB, tradeFee(5200, 4_000_000n) + tradeFee(5200, 6_000_000n), "B booked the full fee");
    const a13Row = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a13.id } });
    const staleApplied = await trueUpAttemptFee(prisma, a13Row, tradeFee(5200, 4_000_000n), {
      observedSharesMicro: 4_000_000n,
      stampReconciled: true,
    });
    assert.strictEqual(staleApplied, 0n, "a stale observation applies nothing");
    const feeAfterA = (await prisma.fill.findMany({ where: { attemptId: a13.id } })).reduce((s, f) => s + f.feeMicro, 0n);
    assert.strictEqual(feeAfterA, feeAfterB, "the full fee survives the stale true-up");
    assert.strictEqual((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a13.id } })).reconciledAt, null, "and it does not close the attempt");
    // A CURRENT observation still stamps.
    await trueUpAttemptFee(prisma, a13Row, feeAfterB, { observedSharesMicro: 10_000_000n, stampReconciled: true });
    assert.ok((await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a13.id } })).reconciledAt, "a current read stamps");
    console.log("OK: a stale fee true-up is refused under the position lock; only a current read stamps");

    // ---- 14. The orphan sweep progresses: rows that stay "unknown" are never written, yet two
    // consecutive small batches must cover DIFFERENT rows (a cursor, not "the same head forever").
    await prisma.sweepCursor.deleteMany({ where: { name: "polymarket-orphan-sweep-v1" } });
    const seen: string[][] = [[], []];
    for (let pass = 0; pass < 2; pass++) {
      await discoverOrphanAttempts(prisma, async (a) => { seen[pass].push(a.id); return null; }, async () => null, { minAgeMs: 0, limit: 2 });
    }
    assert.strictEqual(seen[0].length, 2);
    assert.ok(seen[1].length >= 1, "the second batch is not empty");
    assert.ok(seen[1].every((id) => !seen[0].includes(id)), "the second batch moved past the first");
    console.log("OK: the orphan sweep walks a cursor — unknown rows cannot hold the head of the queue");

    // ---- 15. The marker's grace runs out: a reported id nobody could prove for 30+ minutes no longer
    // shields its row from an exact-hash discovery's verdict of absence.
    const m15 = await mkMarket("c15");
    const a15 = await mkAttempt(m15.id, { state: "SUBMITTING", approvedParams: params9, error: `${REPORTED_UNVERIFIED_PREFIX}${tag}-r15` });
    await prisma.$executeRaw`UPDATE order_attempts SET "updatedAt" = now() - interval '31 minutes' WHERE id = ${a15.id}`;
    const old15 = await prisma.orderAttempt.findUniqueOrThrow({ where: { id: a15.id } });
    assert.strictEqual(
      await resolveOrphanAttempt(prisma, old15, async () => ({ orderId: null }), async () => null, FEE_EXP_MILLI),
      "killed",
    );
    console.log("OK: a reported marker shields its row only within its grace period");

    console.log("OK: unknown probe / matched-without-trades / terminal + live zero-match verdicts");
    console.log("OK: trade records replace the receipt estimate — delta booked, fee trued up");
    console.log("OK: EXIT true-up moves realized PnL by the charged close fee");
    console.log("OK: the sweep selects id-carrying POSTED/FILLED/PARTIAL attempts with no upper age bound");
    console.log("OK: orphan discovery — unknown is inert, a definitive absence kills and frees the slot");
    console.log("OK: orphan adoption books from the exchange and refuses an already-bound order id");
    console.log("OK: platform fee comes from the intent's rate; the label is judged against the SIGNED size");
    console.log("PASS: reconcile");
  } finally {
    await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
    await prisma.fill.deleteMany({ where: { attempt: { userId: user.id } } });
    await prisma.orderAttempt.deleteMany({ where: { userId: user.id } });
    await prisma.sweepCursor.deleteMany({ where: { name: "polymarket-order-reconcile-v1" } });
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
