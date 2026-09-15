// Tokenized stocks (xStocks on Solana — "Stocklana"). A stock card is NOT a binary market: it never
// resolves, its price is spot, and a right swipe is a BUY. This module is the PURE core — no prisma,
// no env, no fetch — so the deck/portfolio/swap paths and the unit tests share one arithmetic.
//
// UNITS (the whole file is written in these, and mixing them is the bug this comment exists to stop):
//  • priceCents  — integer USD cents per ONE RAW token (Jupiter's usdPrice is USD per raw token).
//  • qtyBase     — raw base units (BigInt). A Token-2022 ScaledUiAmount mint carries a multiplier in
//                  scaledUiConfig; raw balances are NOT scaled by it, only the wallet's DISPLAY is.
//                  So qtyBase is the number the chain moves and the number we store.
//  • costCents   — integer USD cents actually spent (USDC micro-units / 10_000, rounded UP).
//  • uiMultiplierMicro — multiplier × 1e6, for DISPLAY ONLY (uiQty), never for money.

import type { JupPriceEntry } from "./prices";
import { STOCK_MIN_LIQUIDITY_CENTS } from "./config";

// USDC on Solana — the quote side of every xStock swap (Jupiter routes USDC -> xStock).
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

// One node of GET https://api.xstocks.fi/api/v2/public/assets. Every field is optional/nullable
// because the upstream is a public API we do not control — a shape change must degrade to "skip this
// asset", never to a crash mid-deck.
export interface XStockNode {
  symbol?: string | null;
  name?: string | null;
  logo?: string | null;
  underlyingSymbol?: string | null;
  isTradingHalted?: boolean | null;
  trading?: { tradingHoursMode?: string | null; openNow?: boolean | null } | null;
  deployments?: { network?: string | null; address?: string | null }[] | null;
}

export interface StockAssetInput {
  mint: string;
  symbol: string;
  name: string;
  underlying: string;
  logoUrl: string | null;
  halted: boolean;
  tradingHours: string | null;
  openNow: boolean;
}

// Normalise one upstream node. null unless we have a symbol AND a Solana deployment with a real
// address — an Ethereum-only asset is not tradable here and must not reach the deck.
export function xstockToAsset(n: XStockNode): StockAssetInput | null {
  const symbol = typeof n.symbol === "string" ? n.symbol.trim() : "";
  if (!symbol) return null;
  const sol = (n.deployments ?? []).find(
    (d) => d && d.network === "Solana" && typeof d.address === "string" && d.address.length > 0,
  );
  if (!sol || !sol.address) return null;
  const name = typeof n.name === "string" && n.name.trim() ? n.name.trim() : symbol;
  const underlying =
    typeof n.underlyingSymbol === "string" && n.underlyingSymbol.trim()
      ? n.underlyingSymbol.trim()
      : symbol.endsWith("x")
        ? symbol.slice(0, -1)
        : symbol;
  return {
    mint: sol.address,
    symbol,
    name,
    underlying,
    logoUrl: typeof n.logo === "string" && n.logo ? n.logo : null,
    halted: n.isTradingHalted === true,
    tradingHours: n.trading?.tradingHoursMode ?? null,
    openNow: n.trading?.openNow === true,
  };
}

export interface StockPriceFields {
  priceCents: number;
  change24hBp: number | null;
  liquidityCents: number | null;
  mcapMillions: number | null;
  decimals: number;
  uiMultiplierMicro: number | null;
}

// INT4 ceiling — every one of these columns is a Prisma Int, so a value past it must be clamped here
// rather than blow up at insert time.
const INT4_MAX = 2_147_483_647;

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

// Jupiter entry -> the fields we persist. The price is Jupiter's DEX usdPrice when the mint has a
// pool; otherwise the issuer's reference price (stockData.price — what xStocks says the share is
// worth), which is honest for a paper buy or a hedge card but comes with NO liquidity, so such an
// asset never reaches the deck (isDeckEligible) and a real swap for it fails at the quote. null when
// neither exists (a mint nobody prices is never a $0 card).
export function priceFieldsFrom(e: JupPriceEntry | undefined): StockPriceFields | null {
  if (!e) return null;
  const usd = positive(e.usdPrice) ? e.usdPrice : positive(e.stockData?.price) ? e.stockData.price : null;
  if (usd === null) return null;
  const priceCents = Math.round(usd * 100);
  if (priceCents <= 0 || priceCents >= INT4_MAX) return null;
  const decimals = typeof e.decimals === "number" && Number.isInteger(e.decimals) && e.decimals >= 0 ? e.decimals : 8;
  const change24hBp =
    typeof e.priceChange24h === "number" && Number.isFinite(e.priceChange24h)
      ? Math.round(e.priceChange24h * 100)
      : null;
  const liquidityCents =
    typeof e.liquidity === "number" && Number.isFinite(e.liquidity) && e.liquidity > 0
      ? Math.min(INT4_MAX, Math.round(e.liquidity * 100))
      : null;
  const mult = e.scaledUiConfig?.multiplier;
  const uiMultiplierMicro =
    typeof mult === "number" && Number.isFinite(mult) && mult > 0 ? Math.round(mult * 1e6) : null;
  const mcap = e.stockData?.mcap;
  const mcapMillions = positive(mcap) ? Math.min(INT4_MAX, Math.round(mcap / 1e6)) : null;
  return { priceCents, change24hBp, liquidityCents, mcapMillions, decimals, uiMultiplierMicro };
}

// Deck eligibility: not halted and priced. Liquidity is a RANK, not a gate: only ~60 of ~830 xStocks
// have a Solana pool, and a deck of 11 cards is not a deck. The pool is ordered liquidity-first then
// market-cap (see deckRank), so the liquid names lead and the household-name long tail follows.
export function isDeckEligible(a: { halted: boolean; priceCents: number | null }): boolean {
  return !a.halted && a.priceCents !== null && a.priceCents > 0;
}

// Can a REAL buy be attempted? Only with a Solana pool deep enough that a small order is not the
// whole book. The Jupiter quote (price-impact cap) is the final gate; this is what the card shows.
export function isTradable(a: { halted: boolean; liquidityCents: number | null }): boolean {
  return !a.halted && a.liquidityCents !== null && a.liquidityCents >= STOCK_MIN_LIQUIDITY_CENTS;
}

// Deck ordering: liquidity desc (nulls last), then market cap desc (nulls last). Pure so the refresh
// ranking and any in-memory sort agree byte-for-byte.
export function deckRank(
  a: { liquidityCents: number | null; mcapMillions: number | null },
  b: { liquidityCents: number | null; mcapMillions: number | null },
): number {
  const la = a.liquidityCents ?? -1;
  const lb = b.liquidityCents ?? -1;
  if (la !== lb) return lb - la;
  return (b.mcapMillions ?? -1) - (a.mcapMillions ?? -1);
}

export function pow10(decimals: number): bigint {
  return 10n ** BigInt(Math.max(0, Math.trunc(decimals)));
}

// How many raw base units a stake buys at the quoted price. FLOOR — the user never gets more than
// they paid for, and the remainder stays in their USDC.
export function qtyBaseFor(stakeCents: number, priceCents: number, decimals: number): bigint {
  if (stakeCents <= 0 || priceCents <= 0) return 0n;
  return (BigInt(Math.trunc(stakeCents)) * pow10(decimals)) / BigInt(Math.trunc(priceCents));
}

// What a holding is worth at a price. FLOOR — a gain never reads high (the mirror of usdcMicroToCents).
export function valueCents(qtyBase: bigint, priceCents: number, decimals: number): number {
  if (qtyBase <= 0n || priceCents <= 0) return 0;
  return Number((qtyBase * BigInt(Math.trunc(priceCents))) / pow10(decimals));
}

// The price a lot was actually bought at, derived from what it cost. ROUND — this is a display/entry
// figure, not a payout, so neither direction is systematically unfair. Integer rounding is done in
// BigInt (add half the divisor before dividing) — Math.round cannot take a BigInt.
export function entryPriceCents(costCents: number, qtyBase: bigint, decimals: number): number {
  if (qtyBase <= 0n || costCents <= 0) return 0;
  const num = BigInt(Math.trunc(costCents)) * pow10(decimals);
  return Number((num + qtyBase / 2n) / qtyBase);
}

// USDC micro-units -> cents, CEIL: a cost basis must never read low (understating cost overstates P&L).
export function usdcMicroToCents(micro: bigint): number {
  if (micro <= 0n) return 0;
  return Number((micro + 9_999n) / 10_000n);
}

// USDC micro-units -> cents, FLOOR: the mirror of the above for PROCEEDS. A cost ceils and a payout
// floors, so a rounding artefact can never invent profit that the wallet does not actually hold.
export function usdcMicroToCentsFloor(micro: bigint): number {
  if (micro <= 0n) return 0;
  return Number(micro / 10_000n);
}

// THE P&L. Portfolio totals and alerts both read this one function so they can never disagree.
export function livePnlCents(p: { qtyBase: bigint; costCents: number }, a: { priceCents: number; decimals: number }): number {
  return valueCents(p.qtyBase, a.priceCents, a.decimals) - p.costCents;
}

// Display-only quantity: raw units scaled by the Token-2022 multiplier so the number matches what the
// user's wallet shows. NEVER feed this back into money math.
export function uiQty(qtyBase: bigint, decimals: number, uiMultiplierMicro: number | null): number {
  const base = Number(qtyBase) / 10 ** Math.max(0, Math.trunc(decimals));
  return uiMultiplierMicro === null ? base : base * (uiMultiplierMicro / 1e6);
}

// ─── Helius getTransaction (jsonParsed) parsing ────────────────────────────────────────────────────

export interface RpcTokenBalance {
  accountIndex?: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RpcParsedTx {
  meta: {
    err: unknown;
    preTokenBalances?: RpcTokenBalance[] | null;
    postTokenBalances?: RpcTokenBalance[] | null;
  } | null;
  transaction: { message: { accountKeys: { pubkey: string; signer?: boolean; writable?: boolean }[] } };
}

export interface SwapDelta {
  qtyBase: bigint;
  usdcOutMicro: bigint;
}

function sumFor(balances: RpcTokenBalance[] | null | undefined, owner: string, mint: string): bigint {
  let total = 0n;
  for (const b of balances ?? []) {
    if (!b || b.owner !== owner || b.mint !== mint) continue;
    try {
      total += BigInt(b.uiTokenAmount.amount);
    } catch {
      // A malformed amount string means we cannot trust this tx — treat the whole parse as failed.
      throw new Error("bad token amount");
    }
  }
  return total;
}

// Did our wallet SIGN this transaction? Under fee sponsorship the fee payer is the server's key, so
// the payer is no longer accountKeys[0] — but it must still be a signer of the tx that moved its
// tokens. A key merely PRESENT in the tx (someone else's swap touching a shared account) is not a
// receipt for our wallet, so `signer: true` is required, not just presence.
export function signedBy(tx: RpcParsedTx, payer: string): boolean {
  for (const k of tx.transaction?.message?.accountKeys ?? []) {
    if (k?.pubkey === payer && k.signer === true) return true;
  }
  return false;
}

// The signed token movement of ONE owner in a landed swap: +stock/-USDC for a buy, the mirror for a
// sell. Throws (via sumFor) on an unreadable amount — the caller turns that into "no delta".
function ownerDeltas(tx: RpcParsedTx, payer: string, mint: string): { stock: bigint; usdc: bigint } {
  const meta = tx.meta!;
  return {
    stock: sumFor(meta.postTokenBalances, payer, mint) - sumFor(meta.preTokenBalances, payer, mint),
    usdc: sumFor(meta.postTokenBalances, payer, USDC_MINT) - sumFor(meta.preTokenBalances, payer, USDC_MINT),
  };
}

// Read what a landed BUY actually moved. null on ANY doubt: a failed tx, a tx our wallet did not
// sign, or a tx that did not both receive the stock and spend USDC. Booking a lot off a tx we only
// half-understand is how a user ends up with a position they never bought.
export function parseSwapDelta(tx: RpcParsedTx, expect: { payer: string; mint: string }): SwapDelta | null {
  const meta = tx.meta;
  if (!meta || meta.err != null) return null; // a successful tx carries err: null
  if (!signedBy(tx, expect.payer)) return null;
  let d: { stock: bigint; usdc: bigint };
  try {
    d = ownerDeltas(tx, expect.payer, expect.mint);
  } catch {
    return null;
  }
  if (d.stock <= 0n || d.usdc >= 0n) return null;
  return { qtyBase: d.stock, usdcOutMicro: -d.usdc };
}

export interface SellDelta {
  qtyBase: bigint; // raw stock units that LEFT the wallet
  usdcInMicro: bigint; // USDC micro-units that arrived
}

// The same reading for a landed SELL: the stock went out and USDC came in. Same null-on-doubt rule —
// a lot is only ever closed as "sold" against a tx we can fully account for.
export function parseSellDelta(tx: RpcParsedTx, expect: { payer: string; mint: string }): SellDelta | null {
  const meta = tx.meta;
  if (!meta || meta.err != null) return null;
  if (!signedBy(tx, expect.payer)) return null;
  let d: { stock: bigint; usdc: bigint };
  try {
    d = ownerDeltas(tx, expect.payer, expect.mint);
  } catch {
    return null;
  }
  if (d.stock >= 0n || d.usdc <= 0n) return null;
  return { qtyBase: -d.stock, usdcInMicro: d.usdc };
}

export interface AttemptLike {
  inAmountMicro: bigint;
  minOutBase: bigint;
}

// Does the landed swap match the quote we built the attempt from? ExactIn is EXACT on chain: the swap
// spends the amount it was built for, to the micro-unit. "<=" would also accept an OLDER, SMALLER
// swap of the same mint by the same wallet as the receipt for this attempt — which is how one buy
// gets booked twice. The minimum output stays a bound (the route can pay out more than quoted).
export function attemptMatches(d: SwapDelta, a: AttemptLike): boolean {
  return d.usdcOutMicro === a.inAmountMicro && d.qtyBase >= a.minOutBase;
}

// The same question for a SELL, with the units flipped: ExactIn is the lot's own quantity, exactly,
// and the wallet must receive at least the minimum USDC it signed for.
export function sellMatches(d: SellDelta, a: { inAmountBase: bigint; minOutMicro: bigint }): boolean {
  return d.qtyBase === a.inAmountBase && d.usdcInMicro >= a.minOutMicro;
}

// ─── Jupiter Lite Swap v1 quote parsing ─────────────────────────────────────────────────────────────

export interface JupQuoteParsed {
  inAmount: bigint;
  outAmount: bigint;
  minOutBase: bigint;
  priceImpactBp: number;
}

function bigFromString(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

// Parse a Jupiter quote. null when any amount is missing/malformed/non-positive — a quote we cannot
// fully read is a quote we must not sign. priceImpactPct is a PERCENT (string or number); a missing
// one reads as 0 bp, which is the permissive direction and is why the caller also caps it.
export function parseJupQuote(json: unknown): JupQuoteParsed | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const inAmount = bigFromString(o.inAmount);
  const outAmount = bigFromString(o.outAmount);
  const minOutBase = bigFromString(o.otherAmountThreshold);
  if (inAmount === null || inAmount <= 0n) return null;
  if (outAmount === null || outAmount <= 0n) return null;
  if (minOutBase === null || minOutBase <= 0n) return null;
  const raw = o.priceImpactPct;
  const pct = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 0;
  const priceImpactBp = Number.isFinite(pct) ? Math.round(pct * 100) : 0;
  return { inAmount, outAmount, minOutBase, priceImpactBp };
}

// ─── base58 (inline — no dependency for one decoder) ────────────────────────────────────────────────

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]] = i;
  return m;
})();

// Decode base58 to bytes. null on any character outside the alphabet (0, O, I, l are the classic
// typos) — a signature we cannot decode is a signature we must not trust. The accumulator starts
// EMPTY: a seeded [0] would leave an extra zero byte behind for an all-'1' input.
export function decodeBase58(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const bytes: number[] = [];
  for (const ch of s) {
    const val = B58_MAP[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's are leading zero bytes.
  for (let i = 0; i < s.length && s[i] === "1"; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

// A Solana signature is exactly 64 bytes of base58 — anything else is not a signature.
export function sigBytesValid(sig: string): boolean {
  const bytes = decodeBase58(sig);
  return bytes !== null && bytes.length === 64;
}
