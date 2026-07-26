// Depth-aware quoting — PURE core (D10). Turns an order-book ladder + a stake into the price you
// would ACTUALLY pay, by walking the book instead of trusting a mid. DB-free, network-free, so the
// whole thing is unit-testable off fixtures (scripts/test-quote.ts).
//
// Why this exists (measured live 2026-07-26 over 29 near-resolution Polymarket books):
//   - Gamma's outcomePrices is a MID. On a book with bid 1¢ / ask 98¢ it reports 49.5¢ — a card
//     priced off that mid promises ~2x the payout the market can actually deliver.
//   - A $10 stake already fails to fill, or slips >2%, on ~1 in 6 near-resolution markets; one book
//     had an empty ask side entirely. At $500 (HEDGE_MAX_STAKE_CENTS) slippage of +20..86% is normal.
// So the price we display AND the price we lock must both come from a walk, never from a mid.
//
// Model: our binary market is two CLOB tokens (YES = outcome index 0, NO = index 1), each with its
// own book. "Betting NO" is BUYING the NO token off ITS ask side — never selling YES into YES's bids
// (a different trade with a different price). So every quote here is a BUY walk over asks.

// One price level of a book. `priceBp` is integer basis points (0..10000 = 0..$1 per share);
// `size` is shares available at that price and is genuinely fractional upstream (e.g. "3.9"), so it
// stays a float — it is a quantity, not money. All MONEY crossing this module's boundary is integer
// cents and all PRICES are integer bp, matching the rest of the codebase.
export interface BookLevel {
  priceBp: number;
  size: number;
}

export interface Quote {
  // VWAP actually paid for the stake, integer bp. Rounded UP (see roundEffPriceBp) so the payout we
  // show is never better than reality.
  effPriceBp: number;
  bestPriceBp: number; // top of book — the price a dust-sized order would get
  // RELATIVE slippage: (effPriceBp − bestPriceBp) / bestPriceBp, in bp. Relative, not absolute,
  // because payout = stake/price — so a 3¢ walk costs ~3% of the payout on a 90¢ market but ~37% on
  // a 5¢ one. An absolute cap would wave the second one through; this is what the user actually feels.
  slippageBp: number;
  filled: boolean; // the ladder held enough depth for the WHOLE stake
  filledCents: number; // how much of the stake the book could actually absorb
  levelsUsed: number;
  depthCents: number; // total USD sitting on this side of the ladder
}

// Sort a raw ladder into buy order (cheapest first) and drop junk levels. Exported because both the
// live client and the fixtures need the same normalization — an unsorted ladder silently produces a
// wrong VWAP rather than an error, so normalizing in ONE place is load-bearing.
export function normalizeAsks(levels: BookLevel[]): BookLevel[] {
  return levels
    .filter((l) => Number.isFinite(l.priceBp) && Number.isFinite(l.size) && l.priceBp > 0 && l.size > 0)
    .sort((a, b) => a.priceBp - b.priceBp);
}

// Same, for a bid ladder (best = highest price first). Used for depth diagnostics, never to price a
// buy — we quote buys off asks only.
export function normalizeBids(levels: BookLevel[]): BookLevel[] {
  return levels
    .filter((l) => Number.isFinite(l.priceBp) && Number.isFinite(l.size) && l.priceBp > 0 && l.size > 0)
    .sort((a, b) => b.priceBp - a.priceBp);
}

// Cost in cents of `size` shares at `priceBp`. priceBp/10000 = dollars per share, ×100 = cents.
function levelCostCents(priceBp: number, size: number): number {
  return (priceBp * size) / 100;
}

// Always round the effective price UP. Price is the DENOMINATOR of the payout (payout = stake/price),
// so rounding up can only ever understate what we promise the user. Rounding down — or to nearest —
// would let sub-bp dust inflate a displayed payout we then have to honour at settlement.
function roundEffPriceBp(costCents: number, shares: number): number {
  return Math.ceil((costCents * 100) / shares);
}

// Walk `asks` buying `stakeCents` worth of shares. Returns null only when there is nothing to buy at
// all (empty/garbage ladder) — a PARTIAL fill still returns a quote with filled=false and the price
// for the part that fills, so callers can distinguish "no market" from "market too thin for THIS
// stake" and report the latter honestly.
export function quoteBuy(asks: BookLevel[], stakeCents: number): Quote | null {
  const ladder = normalizeAsks(asks);
  if (ladder.length === 0 || !(stakeCents > 0)) return null;

  const depthCents = ladder.reduce((s, l) => s + levelCostCents(l.priceBp, l.size), 0);
  const bestPriceBp = ladder[0]!.priceBp;

  let remaining = stakeCents;
  let shares = 0;
  let spent = 0;
  let levelsUsed = 0;

  for (const l of ladder) {
    const cost = levelCostCents(l.priceBp, l.size);
    levelsUsed++;
    if (cost >= remaining) {
      // Partial take of this level finishes the order.
      shares += (remaining * 100) / l.priceBp;
      spent += remaining;
      remaining = 0;
      break;
    }
    shares += l.size;
    spent += cost;
    remaining -= cost;
  }

  if (shares <= 0) return null;
  const effPriceBp = roundEffPriceBp(spent, shares);
  return {
    effPriceBp,
    bestPriceBp,
    slippageBp: Math.round(((effPriceBp - bestPriceBp) * 10_000) / bestPriceBp),
    filled: remaining === 0,
    filledCents: Math.floor(spent),
    levelsUsed,
    depthCents: Math.floor(depthCents),
  };
}

// Largest stake (integer cents) whose VWAP stays within `maxSlippageBp` of the top of book. Used by
// the S1 hedge sizer: a $500 proposal is meaningless on a book that only absorbs $40 without moving
// 20%, so the sizer clamps to what the market can actually take.
//
// Closed form, exact, O(levels). VWAP is monotonically non-decreasing in stake, so we consume levels
// while they are at or under the price ceiling, then take the partial slice of the first level ABOVE
// the ceiling that still keeps the average under it:
//   (spent + p·q) / (shares + q) <= Pmax   =>   q·(p − Pmax) <= Pmax·shares − spent
export function maxStakeWithinSlippage(asks: BookLevel[], maxSlippageBp: number): number {
  const ladder = normalizeAsks(asks);
  if (ladder.length === 0) return 0;
  // Ceiling is RELATIVE to the top of book, matching Quote.slippageBp. Kept fractional on purpose —
  // it is a threshold for the walk, not money we store.
  const maxPriceBp = (ladder[0]!.priceBp * (10_000 + Math.max(0, maxSlippageBp))) / 10_000;

  let shares = 0;
  let spentCents = 0;
  for (const l of ladder) {
    if (l.priceBp <= maxPriceBp) {
      shares += l.size;
      spentCents += levelCostCents(l.priceBp, l.size);
      continue;
    }
    // This level is above the ceiling: take only the slice the average can still absorb. Units:
    // VWAP_bp = spentCents·100/shares, so the constraint above expands to
    //   q·(p − Pmax) <= Pmax·shares − spentCents·100      (both sides in bp·shares)
    const headroomShares = (maxPriceBp * shares - spentCents * 100) / (l.priceBp - maxPriceBp);
    if (headroomShares <= 0) break; // the average is already sitting on the ceiling
    const take = Math.min(headroomShares, l.size);
    shares += take;
    spentCents += levelCostCents(l.priceBp, take);
    // Only stop when the HEADROOM ran out. If this level was simply too small to use it up, the
    // budget still has room and the next (dearer) level can contribute a thinner slice — breaking
    // here instead would under-report the book's real capacity.
    if (take < l.size) break;
  }
  return Math.floor(spentCents);
}

// Can this side absorb `stakeCents` without breaching the slippage cap? The deck/hedge eligibility
// gate — a market that fails this on EITHER side is not a real two-way swipe and gets dropped.
export function sideIsTradable(asks: BookLevel[], stakeCents: number, maxSlippageBp: number): boolean {
  const q = quoteBuy(asks, stakeCents);
  return q !== null && q.filled && q.slippageBp <= maxSlippageBp;
}
