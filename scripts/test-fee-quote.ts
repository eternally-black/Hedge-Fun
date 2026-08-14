// scripts/test-fee-quote.ts — the all-in fee math (plan §2.6), pinned to the MEASURED fill of
// 2026-08-13: rate 0.07, exponent 1, p=0.52, 5 shares → fee $0.08736 charged, predicted exact.
// Pure test (no DB, no SDK). Run: npx tsx scripts/test-fee-quote.ts
import assert from "node:assert";
import { feePerShareMicro, quoteBuyAllIn, quoteBuy } from "../src/lib/quote";

// ---- 1. The measured-fill fixture, to the micro-cent.
assert.strictEqual(feePerShareMicro(5200, 700, 1000), 17_472, "p=0.52: 0.07×(0.52×0.48) = $0.017472/share");
assert.strictEqual(5 * feePerShareMicro(5200, 700, 1000), 87_360, "5 shares = $0.08736 — the charged feeUsdc");

// ---- 2. The fee table from the plan (§0): peaks at 50/50, decays toward the tails.
assert.strictEqual(feePerShareMicro(5000, 700, 1000), 17_500, "3.50% of notional at p=0.50");
assert.strictEqual(feePerShareMicro(9000, 700, 1000), 6_300, "0.70% of notional at p=0.90");
assert.strictEqual(feePerShareMicro(9700, 700, 1000), 2_037, "≈0.21% of notional at p=0.97");
assert.ok(feePerShareMicro(5000, 700, 1000) > feePerShareMicro(7000, 700, 1000), "monotone toward the tail");
assert.strictEqual(feePerShareMicro(5000, 0, 1000), 0, "zero rate = zero fee");

// ---- 3. All-in solver, flat book: stake IS the all-in debit cap; shares are derived.
const flat = [{ priceBp: 5000, size: 1_000 }];
const q1 = quoteBuyAllIn(flat, 10_000_000n, 700, 1000); // $10 all-in at p=0.50, fee 3.5%
assert.ok(q1, "quotable");
if (!q1) throw new Error("unreachable");
// cost/share = 0.5 + 0.0175 = 0.5175 → shares = 10/0.5175 = 19.323671…
assert.ok(q1.sharesMicro >= 19_323_600n && q1.sharesMicro <= 19_323_700n, `shares ≈ 19.3236 (${q1.sharesMicro})`);
assert.ok(q1.spendMicro + q1.feeMicro <= 10_000_000n, "never exceeds the all-in cap");
assert.ok(q1.spendMicro + q1.feeMicro >= 9_999_990n, "…and uses essentially all of it");
assert.strictEqual(q1.vwapBp, 5000, "vwap = the level price on a flat book");
assert.ok(q1.allInPriceBp === 5175 || q1.allInPriceBp === 5176, `all-in ≈ 51.75¢ (${q1.allInPriceBp})`);
assert.strictEqual(q1.marginalAskBp, 5000);
assert.strictEqual(q1.exhaustedBook, false, "budget ran out, not the book");

// ---- 4. Multi-level walk: marginal ask = the dearest level touched (maxPrice derives from THIS).
const two = [
  { priceBp: 4000, size: 5 },
  { priceBp: 5000, size: 100 },
];
const q2 = quoteBuyAllIn(two, 10_000_000n, 700, 1000);
if (!q2) throw new Error("unreachable");
assert.strictEqual(q2.marginalAskBp, 5000, "second level touched");
assert.ok(q2.vwapBp > 4000 && q2.vwapBp < 5000, "vwap between the levels");
assert.ok(q2.allInPriceBp > q2.vwapBp, "all-in strictly above vwap when fee > 0");

// ---- 5. Thin book: exhausts before the budget; the shortfall is visible, never silent.
const thin = [{ priceBp: 5000, size: 2 }];
const q3 = quoteBuyAllIn(thin, 10_000_000n, 700, 1000);
if (!q3) throw new Error("unreachable");
assert.strictEqual(q3.exhaustedBook, true);
assert.strictEqual(q3.sharesMicro, 2_000_000n, "took the whole ladder");
assert.ok(q3.spendMicro + q3.feeMicro < 10_000_000n, "budget left over");

// ---- 6. Zero-fee solver degenerates to the plain walk (same book, same budget).
const q4 = quoteBuyAllIn(flat, 10_000_000n, 0, 1000);
const plain = quoteBuy(flat, 1000); // $10 in cents
if (!q4 || !plain) throw new Error("unreachable");
assert.strictEqual(q4.feeMicro, 0n);
assert.strictEqual(q4.vwapBp, plain.effPriceBp, "no-fee all-in == existing paper walk");
assert.strictEqual(q4.allInPriceBp, q4.vwapBp);

// ---- 7. Garbage in → null, like quoteBuy.
assert.strictEqual(quoteBuyAllIn([], 10_000_000n, 700, 1000), null);
assert.strictEqual(quoteBuyAllIn(flat, 0n, 700, 1000), null);

console.log("OK: fee math pinned to the measured fill; all-in solver honors the cap, surfaces shortfalls");
