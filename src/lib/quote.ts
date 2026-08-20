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
  // priceBp < 10000: a binary-token share can never cost ≥ $1 — a malformed upstream level above
  // that flips p(1−p) negative in the fee formula and silently understates all-in cost.
  return levels
    .filter((l) => Number.isFinite(l.priceBp) && Number.isFinite(l.size) && l.priceBp > 0 && l.priceBp < 10_000 && l.size > 0)
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

// ============================================================ real-money all-in quoting (§2.6)
// The platform taker fee, PER SHARE: rate × (p(1−p))^exp — proven against a real fill 2026-08-13
// (rate 0.07, exp 1, p=0.52, 5 shares → predicted $0.08736, charged $0.08736, exact). It peaks at
// 50/50 — exactly where a hedge lives — and NO price estimate includes it, so the honest card
// price and the order sizing must both add it. Fee params are per market (fees.ts cache);
// rateBp = rate×10⁴, expMilli = exponent×10³. Applied PER LEVEL at that level's own price —
// locally exact for the proven single-level case; per-level-vs-VWAP for multi-level fills is an
// open trap-list question Gate-0 revisits.

// Unrounded, in DOLLARS per share — the walk accumulates this and rounds ONCE at the aggregate
// boundary (rounding per share first then multiplying under-reserves: at 104bp/rate 700 the true
// per-share fee is 720.4288µ$ — rounding to 720 loses 428µ$ over 1000 shares; Sol S5 #2).
function feePerShareExact(priceBp: number, feeRateBp: number, feeExpMilli: number): number {
  const p = priceBp / 10_000;
  return (feeRateBp / 10_000) * Math.pow(p * (1 - p), feeExpMilli / 1000);
}
export function feePerShareMicro(priceBp: number, feeRateBp: number, feeExpMilli: number): number {
  return Math.round(feePerShareExact(priceBp, feeRateBp, feeExpMilli) * 1_000_000);
}

// Binary float dust (0.07×0.25 = 0.017500000000000002) must not tip an exact aggregate over the
// next integer micro-dollar: ceil/floor with a sub-µ$ epsilon. 1e-6 µ$ = 10⁻¹² dollars — twelve
// orders below anything either exchange or user can observe.
const ceilEps = (x: number) => Math.ceil(x - 1e-6);
const floorEps = (x: number) => Math.floor(x + 1e-6);

// micro-USD → CENTS, floored toward −infinity. `Number(x / 10_000n)` truncates toward ZERO, which
// rounds gains down (fine) but losses UP (a −1.6¢ loss booked as −1¢) — the one place the repo's
// "cost up, proceeds down" convention was inverted. Floor is user-pessimistic on both signs.
export function centsFromMicro(micro: bigint): number {
  const q = micro / 10_000n;
  return Number(micro < 0n && micro % 10_000n !== 0n ? q - 1n : q);
}

export interface AllInQuote {
  sharesMicro: bigint; // micro-shares bought within the budget
  spendMicro: bigint; // notional spent on shares (excl. fee), rounded UP
  feeMicro: bigint; // platform fee, rounded UP
  vwapBp: number; // spend/shares, rounded UP (payout denominator — never understate)
  allInPriceBp: number; // (spend+fee)/shares, rounded UP — the number the card shows
  marginalAskBp: number; // the dearest level touched — the maxPrice bound derives from THIS, not VWAP
  exhaustedBook: boolean; // the ladder ran out before the budget did
}

// Walk `asks` spending at most `budgetMicro`; shares are the derived quantity. Returns null when
// nothing is buyable. What the budget BOUNDS depends on the mode:
//   - feeOnTop absent/false: the budget is the ALL-IN debit cap (notional + fee) — the original
//     owner rule, where a $1 swipe puts a $0.96 order on the exchange and the fee comes out of the
//     same dollar.
//   - feeOnTop true: the budget bounds the NOTIONAL only. A $1 swipe puts a $1 ORDER up and the
//     platform fee is paid on top, out of the free balance (owner decision 2026-08-17, reversing
//     the rule above). It exists because the exchange refused the old shape live: "invalid amount
//     for a marketable BUY order ($0.96), min size: 1" — the fee-shrunk order fell under
//     Polymarket's own $1 minimum, so the product's minimum stake was unbuyable by construction.
// The fee accumulates per level identically in both modes, so feeMicro is the same convex number
// for the shares actually taken.
export function quoteBuyAllIn(
  asks: BookLevel[],
  budgetMicro: bigint,
  feeRateBp: number,
  feeExpMilli: number,
  opts?: { feeOnTop?: boolean },
): AllInQuote | null {
  const ladder = normalizeAsks(asks);
  if (ladder.length === 0 || budgetMicro <= 0n) return null;

  if (!(feeRateBp >= 0) || !(feeExpMilli > 0)) return null; // malformed fee params never quote

  const MICRO_SHARE = 1e-6;
  let remaining = Number(budgetMicro) / 1_000_000; // dollars; float internally, integers out
  let shares = 0;
  let spend = 0;
  let fee = 0;
  let marginalAskBp = ladder[0]!.priceBp;
  let bookRanOut = true;

  for (const l of ladder) {
    // A dust LEVEL is skipped, not fatal: one sub-micro-share ask sitting on top of the book must
    // not kill the whole quote — on the sell side that read as an uncloseable position. A dust
    // TAKE from budget exhaustion (below) still ends the walk: there the budget is done, not the book.
    if (l.size < MICRO_SHARE) continue;
    const p = l.priceBp / 10_000;
    const fps = feePerShareExact(l.priceBp, feeRateBp, feeExpMilli); // unrounded — ceil ONCE at the end
    // What a share costs AGAINST THE BUDGET. feeOnTop puts the fee outside the budget, so only the
    // notional competes for it; the fee is still accumulated below, it just does not shrink the order.
    const costPerShare = opts?.feeOnTop ? p : p + fps;
    const affordable = remaining / costPerShare;
    const take = Math.min(l.size, affordable);
    // Sub-micro-share takes are not representable: taking one would move marginalAsk (and thus
    // the future maxPrice bound) to a level the returned quantity never touches (Sol S5 #6).
    if (take < MICRO_SHARE) {
      bookRanOut = false;
      break;
    }
    shares += take;
    spend += take * p;
    fee += take * fps;
    remaining -= take * costPerShare;
    marginalAskBp = l.priceBp;
    if (take < l.size) {
      bookRanOut = false;
      break;
    }
  }

  if (shares < MICRO_SHARE) return null;
  const sharesMicro = BigInt(Math.floor(shares * 1_000_000));
  let spendMicro = ceilEps(spend * 1_000_000);
  const feeMicro = ceilEps(fee * 1_000_000); // the single aggregate-boundary ceil (Sol S5 #2)
  // Rounding both halves UP can overshoot an exactly-exhausted budget by micro-dollar dust; the
  // budget is the binding contract, so the dust comes off notional. WHICH sum overshoots depends on
  // the mode: all-in bounds spend+fee, feeOnTop bounds the notional alone and must NOT shave the
  // fee into the order (that is exactly the shrink this mode exists to stop).
  const over = opts?.feeOnTop ? spendMicro - Number(budgetMicro) : spendMicro + feeMicro - Number(budgetMicro);
  if (over > 0) spendMicro -= over;
  // Prices derive from the INTEGER outputs so every returned field describes the same transaction
  // (float-derived prices next to integer amounts drifted on degenerate inputs; Sol S5 #5).
  const ceilDiv = (a: bigint, b: bigint) => Number((a + b - 1n) / b);
  return {
    sharesMicro,
    spendMicro: BigInt(spendMicro),
    feeMicro: BigInt(feeMicro),
    vwapBp: ceilDiv(BigInt(spendMicro) * 10_000n, sharesMicro),
    allInPriceBp: ceilDiv((BigInt(spendMicro) + BigInt(feeMicro)) * 10_000n, sharesMicro),
    marginalAskBp,
    // True only when the LADDER ran out with budget left — exact simultaneous exhaustion is a
    // full fill, not a liquidity shortfall (Sol S5 #10). `remaining` carries the budget's own
    // units (all-in dollars, or notional under feeOnTop), and one micro-share of NOTIONAL at the
    // marginal price is the right threshold either way — the fee on a single micro-share is
    // sub-micro-dollar, i.e. below the resolution of every integer this function returns.
    exhaustedBook: bookRanOut && remaining > (MICRO_SHARE * marginalAskBp) / 10_000,
  };
}

// The price bound a MARKETABLE order must carry, derived from the marginal level it intends to
// take. It is deliberately one tick BEYOND that level, and the reason is a live rejection on
// 2026-08-17: with the bound set to the marginal ask exactly (0.49), the SDK derived the share
// count by dividing the $1 amount by it and rounded that count UP (2.040816 → 2.0409), which makes
// the order's implied price 1.00/2.0409 = 0.48998 — a hair BELOW the ask it was aimed at. The
// exchange answered "no orders found to match with FAK order" while 19 shares sat on that very
// level. Any rounding in the share derivation has this effect, so the bound cannot sit on the
// level; it has to clear it.
// This does not loosen what the user pays: matching happens at the MAKER's price, and the order's
// collateral (makerAmount) is fixed at the stake either way. What widens by one tick is only the
// worst case if the book moves between the quote and the match — the price of being fillable at all.
export function marketableBuyBoundBp(marginalAskBp: number, tickBp: number, slipBp = 0): number {
  // Slippage first, then the tick clearance. The two answer different failures: `slipBp` is room for
  // the book to MOVE between the quote and the post (the device takes a second or two to sign, and
  // an in-play ask moved 0.82 → 0.88 in that window), while the extra tick is for the rounding that
  // would otherwise leave the bound sitting exactly on a level it cannot cross.
  const slipped = Math.ceil((marginalAskBp * (10_000 + slipBp)) / 10_000);
  return Math.min(Math.ceil(slipped / tickBp) * tickBp + tickBp, 10_000 - tickBp);
}

// The SELL mirror: a floor one tick BELOW the marginal bid. Same failure in the other direction —
// a rounded share/collateral pair whose implied price lands just above the bid is a sell nobody
// can lift, and refusing to fill an exit is the worse half of this bug.
export function marketableSellBoundBp(marginalBidBp: number, tickBp: number, slipBp = 0): number {
  const slipped = Math.floor((marginalBidBp * (10_000 - slipBp)) / 10_000);
  return Math.max(Math.floor(slipped / tickBp) * tickBp - tickBp, tickBp);
}

// Cost basis of `sharesMicro` taken out of a lot of `filledSharesMicro` that cost `spendMicro` plus
// its entry `feeMicro`. Pro-rata and fee-inclusive — this is EXACTLY what an exit realizes
// (orders.bookExitFills), so a preview quoting anything else would promise a P&L the booking then
// contradicts. Integer division floors, which understates the basis by at most a micro-cent.
export function costBasisMicro(
  spendMicro: bigint,
  feeMicro: bigint,
  filledSharesMicro: bigint,
  sharesMicro: bigint,
): bigint {
  if (filledSharesMicro <= 0n) return 0n;
  return ((spendMicro + feeMicro) * sharesMicro) / filledSharesMicro;
}

export interface SellAllInQuote {
  sharesMicro: bigint; // micro-shares actually sellable into the bids
  proceedsMicro: bigint; // notional received BEFORE fee, rounded DOWN (never overstate proceeds)
  feeMicro: bigint; // platform fee, rounded UP (never understate cost)
  netMicro: bigint; // proceeds - fee (what the user actually receives)
  vwapBp: number; // proceeds/shares, rounded DOWN (payout side — never overstate)
  marginalBidBp: number; // the CHEAPEST bid level touched — the future minPrice bound derives from THIS
  exhaustedBook: boolean; // the bid ladder ran out before the shares did
}

// Walk `bids` selling up to `sharesToSellMicro` micro-shares. The user's shares are the binding
// constraint (owner rule: they sell what they hold); proceeds are the derived quantity. Returns
// null when nothing is sellable.
//
// ASYMMETRY vs the buy side: on a SELL every rounding must favor UNDERSTATING what the user
// receives — proceeds down, fee up, vwap down. The buy side rounds spend UP because spend is a
// debit; here proceeds is a credit, so it rounds DOWN. And the future minPrice bound derives from
// marginalBidBp and will round DOWN to a tick — rounding up would make the protection unfillable
// (mirror of the BUY trap where maxPrice rounds up to stay fillable).
export function quoteSellAllIn(
  bids: BookLevel[],
  sharesToSellMicro: bigint,
  feeRateBp: number,
  feeExpMilli: number,
): SellAllInQuote | null {
  // normalizeBids sorts best-first but does NOT filter the upper price bound (a bid ≥ $1 is
  // malformed — a binary token can never be worth ≥ $1). Filter it ourselves, same domain as
  // normalizeAsks.
  const ladder = normalizeBids(bids).filter((l) => l.priceBp < 10_000);
  if (ladder.length === 0 || sharesToSellMicro <= 0n) return null;

  if (!(feeRateBp >= 0) || !(feeExpMilli > 0)) return null; // malformed fee params never quote

  const MICRO_SHARE = 1e-6;
  let remaining = Number(sharesToSellMicro) / 1_000_000; // shares; float internally, integers out
  if (ladder.length === 0) return null;
  let sold = 0;
  let proceeds = 0;
  let fee = 0;
  let marginalBidBp = ladder[0]!.priceBp;
  let bookRanOut = true;

  for (const l of ladder) {
    // A dust LEVEL is skipped, not fatal — the mirror of the buy walk, and the worse half: a
    // sub-micro-share bid on top of the book made the EXIT quote null and the position uncloseable.
    if (l.size < MICRO_SHARE) continue;
    const p = l.priceBp / 10_000;
    const fps = feePerShareExact(l.priceBp, feeRateBp, feeExpMilli); // unrounded — round ONCE at the end
    const take = Math.min(l.size, remaining);
    // Sub-micro-share takes are not representable: taking one would move marginalBid (and thus
    // the future minPrice bound) to a level the returned quantity never touches (mirror of S5 #6).
    if (take < MICRO_SHARE) {
      bookRanOut = false;
      break;
    }
    sold += take;
    proceeds += take * p;
    fee += take * fps;
    remaining -= take;
    marginalBidBp = l.priceBp;
    if (take < l.size) {
      bookRanOut = false;
      break;
    }
  }

  if (sold < MICRO_SHARE) return null;
  const sharesMicro = BigInt(Math.floor(sold * 1_000_000));
  const proceedsMicro = BigInt(floorEps(proceeds * 1_000_000)); // FLOOR — never overstate proceeds
  const feeMicro = BigInt(ceilEps(fee * 1_000_000)); // CEIL — never understate cost
  // Fee rounding can push net negative on dust-sized proceeds; floor at zero — the user never
  // pays more than they receive.
  const netMicro = proceedsMicro > feeMicro ? proceedsMicro - feeMicro : 0n;
  return {
    sharesMicro,
    proceedsMicro,
    feeMicro,
    netMicro,
    // Plain division = floor for positive integers — vwap rounds DOWN (payout side).
    vwapBp: Number((proceedsMicro * 10_000n) / sharesMicro),
    marginalBidBp,
    // True only when the LADDER ran out with shares still unsold — exact simultaneous exhaustion
    // is a full fill, not a liquidity shortfall (mirror of S5 #10).
    exhaustedBook: bookRanOut && remaining >= MICRO_SHARE,
  };
}
