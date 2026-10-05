// DB-free self-check for the reported-order trust boundary (order-probe.ts): /api/real/posted
// books nothing until verifyReportedOrder answers, and the exchange reads are injectable so the
// gate order can be unit-tested without the SDK. Same style as test-quote.ts — node:assert, no
// framework, no DB, no network. Run: npx tsx scripts/test-order-probe.ts
import assert from "node:assert";
import { verifyReportedOrder } from "../src/lib/order-probe";
import type { ReconcilableAttempt } from "../src/lib/reconcile";
import { exchangeOrderIds, isThisSignedOrder, type SignedOrderWire } from "../src/lib/orders";

const DEPOSIT = "0x1111111111111111111111111111111111111111";

// A signed order that matchesExchangeOrder accepts: every field the identity test reads is
// derived from this, so the fixture must be internally consistent with the exchange view below.
const signedOrder: SignedOrderWire = {
  builder: "0x" + "0".repeat(63) + "7",
  expiration: 0,
  maker: DEPOSIT,
  makerAmount: "1000000", // the FIXED side: BUY = USDC paid (micro), SELL = shares offered
  orderType: "FAK",
  salt: "12345",
  side: "BUY",
  signatureType: 3,
  signer: DEPOSIT,
  takerAmount: "5000000", // BUY: shares wanted (micro) — 5 shares
  timestamp: String(Date.now()),
  tokenId: "123456789",
  signature: "0x" + "ab".repeat(131), // shape-only check: even-length hex, >= 131 bytes
} as SignedOrderWire;
// The exchange order id IS the hash of that signed payload (see exchangeOrderIds); reports carry it.
const ORDER_ID = exchangeOrderIds(signedOrder)![0];

const attemptFixture = (over: Partial<ReconcilableAttempt> = {}): ReconcilableAttempt =>
  ({
    id: "attempt-1",
    userId: "user-1",
    marketId: "market-1",
    dir: "ENTRY",
    state: "POSTED",
    externalOrderId: null,
    signedOrder: signedOrder as never,
    approvedParams: { betSide: "YES", sharesMicro: "5000000", feeRateBp: 500, feeExpMilli: 1000 },
    createdAt: new Date("2026-08-17T12:00:00Z"),
    updatedAt: new Date("2026-08-17T12:00:00Z"),
    lotSeq: 1,
    betId: null,
    error: null,
    postResponse: null,
    reconciledAt: null,
    ...over,
  }) as ReconcilableAttempt;

// The exchange's own view of the order above — every field matches the signed intent.
const exchangeOrder = {
  id: ORDER_ID,
  tokenId: "123456789",
  makerAddress: DEPOSIT,
  side: "BUY",
  originalSize: "5", // 5 shares = 5,000,000 micro
  price: "0.20", // 20¢ — price is deliberately NOT compared
  status: "matched",
  sizeMatched: "5",
  createdAt: "2026-08-17T12:00:30Z", // after the attempt existed
};

async function main() {
  const client = {} as never;

  // 1. fetchOrder resolves a matching order → ok, echoed.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => exchangeOrder,
    });
    assert.deepStrictEqual(verdict, { ok: true, order: exchangeOrder });
  }

  // 2. Same order but a different maker wallet → mismatch (the detail names what differed).
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => ({ ...exchangeOrder, makerAddress: "0xotherwallet" }),
    });
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual((verdict as { reason: string }).reason, "mismatch");
    assert.ok(/maker/i.test((verdict as { detail?: string }).detail ?? ""), "detail names the maker");
  }

  // 3. fetchOrder rejects; a trade names the id as TAKER after the intent → ok via trade evidence.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => {
        throw new Error("rpc down");
      },
      pageTrades: async () => ({
        rows: [{ takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "5", price: "0.2", matchedAt: "2026-08-17T12:00:45Z" }],
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: true, order: { id: ORDER_ID, source: "trade-evidence" } });
  }

  // 4. fetchOrder rejects; the trade names the id but matched long BEFORE the attempt → unverifiable.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => {
        throw new Error("rpc down");
      },
      pageTrades: async () => ({
        rows: [{ takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "5", price: "0.2", matchedAt: "2026-08-17T10:00:00Z" }], // 2h before, beyond any skew
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" });
  }

  // 5. fetchOrder rejects; pageTrades returns an incomplete set → unverifiable, never a refusal.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => {
        throw new Error("rpc down");
      },
      pageTrades: async () => ({ rows: [], complete: false }),
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" });
  }

  // 6. No signed order → mismatch with the specific detail.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture({ signedOrder: null }), ORDER_ID, DEPOSIT);
    assert.deepStrictEqual(verdict, { ok: false, reason: "mismatch", detail: "no_signed_order" });
  }

  // 7. The order record answers null (a FAK fill) and the trade lands on the SECOND read → the
  //    retry finds it; one wait happened, with the first configured delay.
  {
    let reads = 0;
    const waits: number[] = [];
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => null,
      pageTrades: async () => {
        reads++;
        return reads < 2
          ? { rows: [], complete: true }
          : { rows: [{ takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "5", price: "0.2", matchedAt: "2026-08-17T12:00:45Z" }], complete: true };
      },
      tradeRetryDelaysMs: [1000, 2000, 3000],
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.deepStrictEqual(verdict, { ok: true, order: { id: ORDER_ID, source: "trade-evidence" } });
    assert.strictEqual(reads, 2);
    assert.deepStrictEqual(waits, [1000]);
  }

  // 8. Retries exhausted with no trade → unverifiable after one read per delay plus the first.
  {
    let reads = 0;
    const waits: number[] = [];
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => null,
      pageTrades: async () => { reads++; return { rows: [], complete: true }; },
      tradeRetryDelaysMs: [1000, 2000, 3000],
      sleep: async (ms) => { waits.push(ms); },
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" });
    assert.strictEqual(reads, 4);
    assert.deepStrictEqual(waits, [1000, 2000, 3000]);
  }

  // 10. The trade names the id but is a SELL, against an ENTRY attempt → not ours (unverifiable,
  //     never a booking): a user's own trade in the other direction must not be adopted.
  // 11. Same for a trade on a different token.
  for (const wrong of [{ side: "SELL" }, { tokenId: "0xothertoken" }]) {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => null,
      pageTrades: async () => ({
        rows: [{ takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "5", price: "0.2", matchedAt: "2026-08-17T12:00:45Z", ...wrong }],
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" }, JSON.stringify(wrong));
  }

  // 12. Trades naming the id add up to MORE than was signed → unverifiable (not a 422: whether a taker can get
  //     extra shares is unconfirmed, and a refusal would show an error for a filled order).
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => null,
      pageTrades: async () => ({
        rows: [
          // 3 + 3 shares at 0.20 = $1.20 of a $1.00 (makerAmount) BUY → more USDC than signed.
          { takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "3", price: "0.2", matchedAt: "2026-08-17T12:00:45Z" },
          { takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "3", price: "0.2", matchedAt: "2026-08-17T12:00:46Z" },
        ],
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" }, "oversize is left to the orphan sweep, never a red error");
  }

  // 12b. MORE shares than takerAmount but within the signed USDC is a normal BUY fill (price
  //      improvement — live 2026-10-05: $1 signed, takerAmount 1.4493, filled 1.5625 at 0.64). Here:
  //      6 shares at 0.16 = $0.96 of $1.00, while takerAmount says 5 → verified.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => null,
      pageTrades: async () => ({
        rows: [{ takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "6", price: "0.16", matchedAt: "2026-08-17T12:00:45Z" }],
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: true, order: { id: ORDER_ID, source: "trade-evidence" } });
  }
  // 12c. A BUY trade without a usable price cannot be bounded → unverifiable.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => null,
      pageTrades: async () => ({
        rows: [{ takerOrderId: ORDER_ID, traderSide: "TAKER", tokenId: "123456789", side: "BUY", size: "5", matchedAt: "2026-08-17T12:00:45Z" }],
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" });
  }

  // 13. Exact identity: a CLOB order id is the EIP-712 hash of the signed Order. The expected value
  //     was computed with viem's hashTypedData (an independent implementation) for this synthetic
  //     payload; the scheme itself was checked against all 12 booked prod orders on 2026-10-05.
  {
    const realSigned = {
      salt: "4422653138285458",
      maker: "0x1111111111111111111111111111111111111111",
      signer: "0x1111111111111111111111111111111111111111",
      tokenId: "54779572715312001889451200805664620346156336491952555736541797575917215068195",
      makerAmount: "1000000",
      takerAmount: "2500000",
      side: "BUY",
      signatureType: 3,
      timestamp: "1759600000000",
      metadata: "0x" + "0".repeat(64),
      builder: "0x0690dceb8b95e90b8b846d61c8ea729c89be6ca550c204ec4eaabb6043f6740c",
      orderType: "FAK",
      signature: "0x" + "ab".repeat(131),
    } as unknown as SignedOrderWire;
    const expectedId = "0x0b3f0e4141e5fe6676c6ff1d2026aaf080fff7762bd0ac6d9ddb0ea8ecca4f30";
    assert.strictEqual(exchangeOrderIds(realSigned)?.[0], expectedId, "standard-exchange hash matches viem");
    assert.strictEqual(isThisSignedOrder(realSigned, expectedId.toUpperCase().replace("0X", "0x")), true, "case-insensitive");
    assert.strictEqual(isThisSignedOrder(realSigned, "0x" + "1".repeat(64)), false);
    assert.strictEqual(isThisSignedOrder({ ...realSigned, salt: "4422653138285459" } as SignedOrderWire, expectedId), false, "any field change → another id");
    assert.strictEqual(isThisSignedOrder({ ...realSigned, maker: "not-an-address" } as SignedOrderWire, expectedId), null, "unhashable → cannot tell");
    // Malformed fields are "cannot tell", never a coerced hash that would brand the real id foreign.
    for (const bad of [{ side: "HOLD" }, { signatureType: null }, { signatureType: 9 }, { metadata: "0x12" }, { builder: 7 }, { salt: "12x" }]) {
      assert.strictEqual(isThisSignedOrder({ ...realSigned, ...bad } as unknown as SignedOrderWire, expectedId), null, JSON.stringify(bad));
    }
    // Missing metadata/builder default to zero, exactly as the SDK signs them.
    const noMeta = { ...realSigned } as Record<string, unknown>; delete noMeta.metadata;
    assert.notStrictEqual(isThisSignedOrder(noMeta as unknown as SignedOrderWire, expectedId), null);

    // An unhashable payload is never verified by weaker evidence: unverifiable, without reading.
    let reads2 = 0;
    const unhashable = await verifyReportedOrder(client, attemptFixture({ signedOrder: { ...realSigned, side: "HOLD" } as never }), expectedId, DEPOSIT, {
      fetchOrder: async () => { reads2++; return null; },
      pageTrades: async () => { reads2++; return { rows: [], complete: true }; },
    });
    assert.deepStrictEqual(unhashable, { ok: false, reason: "unverifiable" });
    assert.strictEqual(reads2, 0);

    // A reported id that is provably another order is refused before any exchange read.
    let reads = 0;
    const foreign = await verifyReportedOrder(client, attemptFixture({ signedOrder: realSigned as never }), "0x" + "1".repeat(64), DEPOSIT, {
      fetchOrder: async () => { reads++; return null; },
      pageTrades: async () => { reads++; return { rows: [], complete: true }; },
    });
    assert.deepStrictEqual(foreign, { ok: false, reason: "mismatch", detail: "order_id_not_this_signed_order" });
    assert.strictEqual(reads, 0, "no exchange read for a foreign id");
  }

  // 9. Without tradeRetryDelaysMs (the poller's fast pass) there is exactly one read and no wait.
  {
    let reads = 0;
    const verdict = await verifyReportedOrder(client, attemptFixture(), ORDER_ID, DEPOSIT, {
      fetchOrder: async () => null,
      pageTrades: async () => { reads++; return { rows: [], complete: true }; },
      sleep: async () => { throw new Error("must not wait"); },
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" });
    assert.strictEqual(reads, 1);
  }

  console.log("✓ order-probe: a reported id is booked only when the exchange's own record or trade names it");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
