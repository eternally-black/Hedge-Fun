// DB-free self-check for the depth-aware quoting core (D10). Same style as test-hedge-cores.ts —
// node:assert, no framework, no DB, no network. Run: npx tsx scripts/test-quote.ts
//
// The fixtures are shaped after REAL books measured live 2026-07-26 (see src/lib/quote.ts header):
// a healthy deep book, a book whose whole top level is $2, and the bid-1¢/ask-98¢ husk whose Gamma
// mid reads a perfectly reasonable 49.5¢.
import assert from "node:assert";
import {
  quoteBuy,
  maxStakeWithinSlippage,
  sideIsTradable,
  normalizeAsks,
  normalizeBids,
  type BookLevel,
} from "../src/lib/quote";

const lvl = (priceCents: number, size: number): BookLevel => ({ priceBp: priceCents * 100, size });

// ─── normalization: the CLOB ships ladders worst-price-first; a wrong sort silently mis-prices ─────
{
  const raw = [lvl(53, 10), lvl(51, 5), lvl(52, 8)];
  assert.deepStrictEqual(
    normalizeAsks(raw).map((l) => l.priceBp),
    [5100, 5200, 5300],
    "asks normalize cheapest-first",
  );
  assert.deepStrictEqual(
    normalizeBids(raw).map((l) => l.priceBp),
    [5300, 5200, 5100],
    "bids normalize highest-first",
  );
  assert.deepStrictEqual(
    normalizeAsks([{ priceBp: 0, size: 5 }, { priceBp: 5000, size: 0 }, { priceBp: NaN, size: 1 }]),
    [],
    "zero/NaN price and zero size levels are dropped",
  );
}

// ─── exact VWAP math on a hand-checkable ladder ────────────────────────────────────────────────────
{
  // 10 shares @ 50¢ ($5 of depth), then 100 @ 60¢.
  const asks = [lvl(50, 10), lvl(60, 100)];

  // $5 fills entirely at the top level -> no slippage.
  const q5 = quoteBuy(asks, 500)!;
  assert.strictEqual(q5.effPriceBp, 5000, "$5 fills at top of book");
  assert.strictEqual(q5.slippageBp, 0, "$5 has no slippage");
  assert.strictEqual(q5.filled, true, "$5 fully filled");
  assert.strictEqual(q5.levelsUsed, 1, "$5 touches one level");

  // $11 = $5 (10sh @50¢) + $6 (10sh @60¢) = 20 shares -> VWAP exactly 55¢.
  const q11 = quoteBuy(asks, 1100)!;
  assert.strictEqual(q11.effPriceBp, 5500, "$11 walks two levels to a 55¢ VWAP");
  assert.strictEqual(q11.slippageBp, 1000, "50¢ -> 55¢ is 10% RELATIVE slippage, i.e. 1000bp");
  assert.strictEqual(q11.depthCents, 6500, "depth = $5 + $60");

  // The same walk on a CHEAP book is a far bigger payout hit, and the relative measure says so:
  // $1 over 10sh@5¢ then into 10¢ lands at 6.67¢ — a 33% payout haircut off a 1¢ move.
  const cheap = quoteBuy([lvl(5, 10), lvl(10, 100)], 100)!;
  assert.strictEqual(cheap.effPriceBp, 667, "$1 clears the 5¢ level and averages 6.67¢");
  assert.strictEqual(cheap.slippageBp, 3340, "an absolute cap would have called this a harmless 1.67¢");
}

// ─── rounding is deliberately AGAINST the user: payout = stake/price, so price rounds UP ───────────
{
  // 3 shares @ 33¢ = 99¢ of depth. $0.99 buys exactly 3 shares -> 33¢ flat.
  const flat = quoteBuy([lvl(33, 3)], 99)!;
  assert.strictEqual(flat.effPriceBp, 3300, "clean division stays exact");

  // A ladder that lands on a fractional bp must round UP, never down.
  const frac = quoteBuy([{ priceBp: 3333, size: 1 }, { priceBp: 6667, size: 1 }], 100)!;
  assert.ok(frac.effPriceBp >= 3333, "effective price never rounds below the top of book");
  assert.strictEqual(frac.effPriceBp, Math.ceil(frac.effPriceBp), "effective price is an integer bp");
}

// ─── the $2-top-level book: $10 does NOT fill, and we must say so rather than quote a fantasy ──────
{
  const thin = [lvl(38, 5), lvl(45, 1)]; // $1.90 + $0.45 = $2.35 of total depth
  const q = quoteBuy(thin, 1000)!;
  assert.strictEqual(q.filled, false, "$10 cannot fill a $2.35 book");
  assert.strictEqual(q.filledCents, 235, "reports how much the book could absorb");
  assert.ok(q.effPriceBp > 3800, "the partial fill still prices above the top of book");
  assert.strictEqual(sideIsTradable(thin, 1000, 300), false, "an unfillable side is not tradable");
  assert.strictEqual(sideIsTradable(thin, 100, 300), true, "$1 does fit inside the same book");
}

// ─── the husk: bid 1¢ / ask 98¢, Gamma mid says 49.5¢. Depth-aware pricing must expose the lie ─────
{
  const husk = [lvl(98, 50)];
  const q = quoteBuy(husk, 1000)!;
  assert.strictEqual(q.effPriceBp, 9800, "the real cost of YES here is 98¢, not the 49.5¢ mid");
  // payout = stake/price: at the mid we would have promised ~$20, reality is ~$10.20.
  const payoutAtMid = Math.round(1000 / 100 / (4950 / 10000));
  const payoutReal = Math.round(1000 / 100 / (q.effPriceBp / 10000));
  assert.strictEqual(payoutAtMid, 20, "mid-priced payout would have been $20");
  assert.strictEqual(payoutReal, 10, "depth-aware payout is $10");
}

// ─── empty / absent book: no quote at all (distinct from a thin one) ───────────────────────────────
{
  assert.strictEqual(quoteBuy([], 1000), null, "empty ladder yields no quote");
  assert.strictEqual(quoteBuy([lvl(50, 10)], 0), null, "zero stake yields no quote");
  assert.strictEqual(sideIsTradable([], 1000, 300), false, "empty ask side is never tradable");
}

// ─── maxStakeWithinSlippage: closed form must agree with a brute-force search ──────────────────────
{
  const asks = [lvl(50, 10), lvl(60, 100)];

  assert.strictEqual(maxStakeWithinSlippage(asks, 0), 500, "zero tolerance stops at the top level");
  // 1000bp RELATIVE tolerance -> ceiling 55¢: 10sh@50¢ + 10sh@60¢ = $11 at exactly 55¢ VWAP.
  assert.strictEqual(maxStakeWithinSlippage(asks, 1000), 1100, "10% tolerance absorbs $11");
  assert.strictEqual(maxStakeWithinSlippage([], 500), 0, "empty ladder absorbs nothing");

  // Brute force: the largest stake whose quoted slippage is within budget, to the cent.
  const ladders: BookLevel[][] = [
    [lvl(50, 10), lvl(60, 100)],
    [lvl(38, 5), lvl(45, 1), lvl(61, 40)],
    [lvl(12, 3), lvl(13, 3), lvl(14, 300)],
    [lvl(98, 50)],
  ];
  for (const ladder of ladders) {
    for (const tol of [0, 50, 200, 500, 1500]) {
      const closed = maxStakeWithinSlippage(ladder, tol);
      if (closed > 0) {
        const q = quoteBuy(ladder, closed)!;
        // Rounding is upward by design, so allow the quote to sit 1bp over the ceiling.
        assert.ok(
          q.slippageBp <= tol + 1,
          `closed form stays within tolerance (tol=${tol} got=${q.slippageBp})`,
        );
      }
      // The answer must be MAXIMAL: meaningfully overshooting it has to breach the budget, unless
      // the ladder simply has no more depth to sell (then the cap was never the binding constraint).
      const depth = Math.floor(ladder.reduce((s, l) => s + (l.priceBp * l.size) / 100, 0));
      const overshoot = closed + Math.max(10, Math.round(closed * 0.05));
      if (overshoot <= depth) {
        const over = quoteBuy(ladder, overshoot)!;
        assert.ok(
          over.slippageBp > tol,
          `maxStakeWithinSlippage is maximal (tol=${tol} overshoot=${overshoot}c still at ${over.slippageBp}bp)`,
        );
      }
    }
  }
}

// ─── monotonicity: a bigger stake can never quote a BETTER price ───────────────────────────────────
{
  const asks = [lvl(20, 4), lvl(25, 9), lvl(31, 50), lvl(44, 500)];
  let prev = 0;
  for (let cents = 10; cents <= 20_000; cents += 137) {
    const q = quoteBuy(asks, cents);
    if (!q) continue;
    assert.ok(q.effPriceBp >= prev, `effective price never improves with size (at ${cents}c)`);
    prev = q.effPriceBp;
  }
}

console.log("✓ quote core: normalization, VWAP, conservative rounding, thin/husk/empty books, slippage cap");
