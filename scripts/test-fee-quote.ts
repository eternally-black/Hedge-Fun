// scripts/test-fee-quote.ts — the all-in fee math (plan §2.6), pinned to the MEASURED fill of
// 2026-08-13: rate 0.07, exponent 1, p=0.52, 5 shares → fee $0.08736 charged, predicted exact.
// Pure test (no DB, no SDK). Run: npx tsx scripts/test-fee-quote.ts
import assert from "node:assert";
import { feePerShareMicro, quoteBuyAllIn, quoteSellAllIn, quoteBuy } from "../src/lib/quote";

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

// ---- 8. Sell-side all-in: flat bid book, exact math.
const sellFlat = [{ priceBp: 5000, size: 1000 }];
const s1 = quoteSellAllIn(sellFlat, 10_000_000n, 700, 1000); // sell 10 shares @0.50, fee 3.5%
if (!s1) throw new Error("unreachable");
assert.strictEqual(s1.sharesMicro, 10_000_000n, "sold all 10 shares");
assert.strictEqual(s1.proceedsMicro, 5_000_000n, "10 × $0.50 = $5.00 exactly");
assert.strictEqual(s1.feeMicro, 175_000n, "10 × $0.0175 = $0.175, ceil = exact");
assert.strictEqual(s1.netMicro, 4_825_000n, "$5.00 − $0.175 = $4.825");
assert.strictEqual(s1.vwapBp, 5000, "flat book → vwap = level price");
assert.strictEqual(s1.marginalBidBp, 5000);
assert.strictEqual(s1.exhaustedBook, false);

// ---- 9. Two-level bids: walk best-first, marginal = cheapest touched.
const sellTwo = [
  { priceBp: 5200, size: 5 },
  { priceBp: 4800, size: 100 },
];
const s2 = quoteSellAllIn(sellTwo, 10_000_000n, 700, 1000); // sell 10: 5 @0.52 then 5 @0.48
if (!s2) throw new Error("unreachable");
assert.strictEqual(s2.sharesMicro, 10_000_000n);
assert.strictEqual(s2.proceedsMicro, 5_000_000n, "5×0.52 + 5×0.48 = $5.00");
assert.strictEqual(s2.marginalBidBp, 4800, "cheapest level touched");
assert.strictEqual(s2.vwapBp, 5000, "($5.00 / 10 shares) × 10000");
assert.ok(s2.feeMicro > 0n, "fee charged on sells too");
assert.strictEqual(s2.netMicro, s2.proceedsMicro - s2.feeMicro, "net = proceeds − fee");

// ---- 10. Thin bids: ladder exhausts, shortfall visible.
const sellThin = [{ priceBp: 5000, size: 2 }];
const s3 = quoteSellAllIn(sellThin, 10_000_000n, 700, 1000); // sell 10, only 2 available
if (!s3) throw new Error("unreachable");
assert.strictEqual(s3.sharesMicro, 2_000_000n, "took the whole ladder");
assert.strictEqual(s3.exhaustedBook, true, "shares still unsold");

// ---- 11. Malformed inputs → null or filtered, never NaN/throw.
assert.strictEqual(quoteSellAllIn([], 10_000_000n, 700, 1000), null, "empty ladder");
assert.strictEqual(quoteSellAllIn(sellFlat, 0n, 700, 1000), null, "zero shares");
const sellJunk = [
  { priceBp: 10100, size: 5 }, // malformed: ≥ $1, must be ignored
  { priceBp: 5000, size: 100 },
];
const s4 = quoteSellAllIn(sellJunk, 10_000_000n, 700, 1000);
if (!s4) throw new Error("unreachable");
assert.strictEqual(s4.marginalBidBp, 5000, "10100bp level filtered out");
assert.ok(s4.feeMicro > 0n, "fee computed from valid levels only");
assert.ok(Number.isFinite(s4.vwapBp), "no NaN from malformed levels");

// ---- 12. Zero fee rate → no fee, net equals proceeds.
const s5 = quoteSellAllIn(sellFlat, 10_000_000n, 0, 1000);
if (!s5) throw new Error("unreachable");
assert.strictEqual(s5.feeMicro, 0n);
assert.strictEqual(s5.netMicro, s5.proceedsMicro);

console.log("OK: sell-side all-in quoting — proceeds down, fee up, marginal bid tracked");
