// Matcher — PURE core (D1: deterministic, no LLM). Given the wallet's exposure and the parsed
// majors market index, pick the opposite-direction markets that hedge each holding: a LONG position
// wants a side that pays when the price FALLS. For an UP market ("above/reach/hit $X") that's the NO
// side; for a DOWN market ("dip to/below $X") that's the YES side. Ranks candidates by liquidity then
// deadline sanity. DB-free / network-free — unit-tested in scripts/test-hedge-cores.ts.

import type { BetSide } from "../api-types";
import type { HedgeAsset, ParsedDirection } from "./parse";
import type { ExposureResult } from "./exposure";
import { HEDGE_MIN_NOTIONAL_CENTS, HEDGE_MIN_LEAD_MS } from "../config";

// A parsed, S1-eligible market row (built from MarketMeta + Market by the DB orchestrator).
export interface IndexedMarket {
  marketId: string; // internal Market.id
  asset: HedgeAsset;
  direction: ParsedDirection; // UP (YES wins on a rise) | DOWN (YES wins on a fall)
  strikeCents: number;
  deadlineMs: number;
  liquidityCents: number | null;
  yesPriceBp: number | null;
  noPriceBp: number | null;
}

export type HedgeKind = "S1_MAJOR" | "S1_PROXY";

export interface HedgeCandidate {
  marketId: string;
  kind: HedgeKind;
  hedgedAsset: string; // "BTC"|"ETH"|"SOL" (the proxy uses SOL as the shorting instrument)
  hedgedNotionalCents: number;
  side: BetSide; // the down-benefit side to bet
  sidePriceBp: number; // that side's current price (lockable)
  strikeCents: number;
  deadlineMs: number;
  liquidityCents: number | null;
  isProxy: boolean;
}

// Drop degenerate/decided sides (a hedge side priced ~0% or ~100% is useless). Keep a wide band.
const SIDE_FLOOR_BP = 100; // 1%
const SIDE_CEIL_BP = 9900; // 99%

// The side of a market that benefits a LONG holder if the price falls.
function downBenefitSide(direction: ParsedDirection): BetSide {
  return direction === "UP" ? "NO" : "YES";
}

function sidePrice(m: IndexedMarket, side: BetSide): number | null {
  const p = side === "YES" ? m.yesPriceBp : m.noPriceBp;
  return p == null ? null : p;
}

// Rank: highest liquidity first (deeper = better fill signal), then the SOONEST still-sane deadline
// (tighter hedge horizon), then marketId for a stable deterministic tiebreak.
function rankCmp(a: IndexedMarket, b: IndexedMarket): number {
  const la = a.liquidityCents ?? 0;
  const lb = b.liquidityCents ?? 0;
  if (lb !== la) return lb - la;
  if (a.deadlineMs !== b.deadlineMs) return a.deadlineMs - b.deadlineMs;
  return a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0;
}

function pickForAsset(
  markets: IndexedMarket[],
  asset: HedgeAsset,
  nowMs: number,
  perAsset: number,
): { m: IndexedMarket; side: BetSide; priceBp: number }[] {
  const out: { m: IndexedMarket; side: BetSide; priceBp: number }[] = [];
  const eligible = markets
    .filter((m) => m.asset === asset && m.deadlineMs > nowMs + HEDGE_MIN_LEAD_MS)
    .sort(rankCmp);
  for (const m of eligible) {
    const side = downBenefitSide(m.direction);
    const priceBp = sidePrice(m, side);
    if (priceBp == null || priceBp < SIDE_FLOOR_BP || priceBp > SIDE_CEIL_BP) continue;
    out.push({ m, side, priceBp });
    if (out.length >= perAsset) break;
  }
  return out;
}

// Build S1 candidates. `perAsset` caps how many markets are offered per major (default 1 = the single
// best hedge). Majors held (above the dust floor) -> S1_MAJOR; the summed long-tail SPL -> a single
// S1_PROXY on SOL (basis risk — the caller labels it a proxy, never a hedge).
export function matchS1(
  exposure: ExposureResult,
  indexedMarkets: IndexedMarket[],
  nowMs: number,
  opts: { perAsset?: number } = {},
): HedgeCandidate[] {
  const perAsset = opts.perAsset ?? 1;
  const candidates: HedgeCandidate[] = [];

  // Majors — direct hedges.
  for (const major of exposure.majors) {
    if (major.notionalCents < HEDGE_MIN_NOTIONAL_CENTS) continue;
    const asset = major.asset as HedgeAsset; // majors are always BTC/ETH/SOL
    for (const p of pickForAsset(indexedMarkets, asset, nowMs, perAsset)) {
      candidates.push({
        marketId: p.m.marketId,
        kind: "S1_MAJOR",
        hedgedAsset: asset,
        hedgedNotionalCents: major.notionalCents,
        side: p.side,
        sidePriceBp: p.priceBp,
        strikeCents: p.m.strikeCents,
        deadlineMs: p.m.deadlineMs,
        liquidityCents: p.m.liquidityCents,
        isProxy: false,
      });
    }
  }

  // Long-tail SPL aggregate — one SOL-short PROXY.
  if (exposure.splAggregateCents >= HEDGE_MIN_NOTIONAL_CENTS) {
    // Don't double-suggest a market already used as a direct SOL major hedge.
    const usedMarketIds = new Set(candidates.map((c) => c.marketId));
    for (const p of pickForAsset(indexedMarkets, "SOL", nowMs, perAsset + candidates.length)) {
      if (usedMarketIds.has(p.m.marketId)) continue;
      candidates.push({
        marketId: p.m.marketId,
        kind: "S1_PROXY",
        hedgedAsset: "SOL",
        hedgedNotionalCents: exposure.splAggregateCents,
        side: p.side,
        sidePriceBp: p.priceBp,
        strikeCents: p.m.strikeCents,
        deadlineMs: p.m.deadlineMs,
        liquidityCents: p.m.liquidityCents,
        isProxy: true,
      });
      break; // one proxy suggestion is enough
    }
  }

  return candidates;
}
