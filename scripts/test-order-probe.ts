// DB-free self-check for the reported-order trust boundary (order-probe.ts): /api/real/posted
// books nothing until verifyReportedOrder answers, and the exchange reads are injectable so the
// gate order can be unit-tested without the SDK. Same style as test-quote.ts — node:assert, no
// framework, no DB, no network. Run: npx tsx scripts/test-order-probe.ts
import assert from "node:assert";
import { verifyReportedOrder } from "../src/lib/order-probe";
import type { ReconcilableAttempt } from "../src/lib/reconcile";
import type { SignedOrderWire } from "../src/lib/orders";

// A signed order that matchesExchangeOrder accepts: every field the identity test reads is
// derived from this, so the fixture must be internally consistent with the exchange view below.
const signedOrder: SignedOrderWire = {
  builder: "0xbuilder",
  expiration: 0,
  maker: "0xdepositwallet",
  makerAmount: "1000000", // SELL: shares offered (micro); ENTRY uses takerAmount for shares
  orderType: "FAK",
  salt: "12345",
  side: "BUY",
  signatureType: 3,
  signer: "0xdepositwallet",
  takerAmount: "5000000", // BUY: shares wanted (micro) — 5 shares
  timestamp: String(Date.now()),
  tokenId: "0xtoken123",
  signature: "0x" + "ab".repeat(131), // shape-only check: even-length hex, >= 131 bytes
} as SignedOrderWire;

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
  id: "order-1",
  tokenId: "0xtoken123",
  makerAddress: "0xdepositwallet",
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
    const verdict = await verifyReportedOrder(client, attemptFixture(), "order-1", "0xdepositwallet", {
      fetchOrder: async () => exchangeOrder,
    });
    assert.deepStrictEqual(verdict, { ok: true, order: exchangeOrder });
  }

  // 2. Same order but a different maker wallet → mismatch (the detail names what differed).
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), "order-1", "0xdepositwallet", {
      fetchOrder: async () => ({ ...exchangeOrder, makerAddress: "0xotherwallet" }),
    });
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual((verdict as { reason: string }).reason, "mismatch");
    assert.ok(/maker/i.test((verdict as { detail?: string }).detail ?? ""), "detail names the maker");
  }

  // 3. fetchOrder rejects; a trade names the id as TAKER after the intent → ok via trade evidence.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), "order-1", "0xdepositwallet", {
      fetchOrder: async () => {
        throw new Error("rpc down");
      },
      pageTrades: async () => ({
        rows: [{ takerOrderId: "order-1", traderSide: "TAKER", matchedAt: "2026-08-17T12:00:45Z" }],
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: true, order: { id: "order-1", source: "trade-evidence" } });
  }

  // 4. fetchOrder rejects; the trade names the id but matched long BEFORE the attempt → unverifiable.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), "order-1", "0xdepositwallet", {
      fetchOrder: async () => {
        throw new Error("rpc down");
      },
      pageTrades: async () => ({
        rows: [{ takerOrderId: "order-1", traderSide: "TAKER", matchedAt: "2026-08-17T10:00:00Z" }], // 2h before, beyond any skew
        complete: true,
      }),
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" });
  }

  // 5. fetchOrder rejects; pageTrades returns an incomplete set → unverifiable, never a refusal.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture(), "order-1", "0xdepositwallet", {
      fetchOrder: async () => {
        throw new Error("rpc down");
      },
      pageTrades: async () => ({ rows: [], complete: false }),
    });
    assert.deepStrictEqual(verdict, { ok: false, reason: "unverifiable" });
  }

  // 6. No signed order → mismatch with the specific detail.
  {
    const verdict = await verifyReportedOrder(client, attemptFixture({ signedOrder: null }), "order-1", "0xdepositwallet");
    assert.deepStrictEqual(verdict, { ok: false, reason: "mismatch", detail: "no_signed_order" });
  }

  console.log("✓ order-probe: a reported id is booked only when the exchange's own record or trade names it");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
