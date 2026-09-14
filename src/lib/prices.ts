// Jupiter price integration (D3: current market value). Public price API — NO key at our volumes.
// Maps a set of SPL mints to their current USD price. Native SOL is priced under the wSOL mint
// (WSOL_MINT), which is how the exposure core looks it up. Graceful: a mint Jupiter can't price is
// simply absent from the map (exposure treats it as $0 — no exposure signal, never a crash).
//
// Verified facts (Jupiter Lite Price API v3, verified live 2026-07-17):
//  - GET https://lite-api.jup.ag/price/v3?ids=<mint1,mint2,...>
//  - -> { "<mint>": { "usdPrice": <number>, "decimals": <int>, ... }, ... }  (missing mint => omitted)
//  - Each entry also carries priceChange24h (PERCENT), liquidity (USD) and scaledUiConfig.multiplier
//    (Token-2022 ScaledUiAmount — DISPLAY only; raw balances are never scaled by it).

import type { PriceMap } from "./hedge/exposure";
import { deadlineLeftMs, boundedTimeoutMs } from "./deadline";

// Thrown when Jupiter can't answer (HTTP error, timeout, transport failure). Mirrors
// HeliusUnavailableError: without prices there is no exposure, so the wallet/suggestions routes map
// this to the SAME typed 502 (exposure_unavailable) as a Helius outage (F4) — never a bare 500.
export class JupiterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JupiterUnavailableError";
  }
}

const BASE = process.env.JUPITER_PRICE_BASE ?? "https://lite-api.jup.ag/price/v3";
const TIMEOUT_MS = 10_000;
// ids per request. Jupiter SILENTLY caps a request at 50 ids — a 100-id call answers 200 with the
// first 50 keys and drops the rest (measured 2026-09-14: n=100 -> 50 keys, n=50 -> 50 keys).
const CHUNK = 50;

export interface JupPriceEntry {
  usdPrice?: number;
  decimals?: number;
  priceChange24h?: number;
  liquidity?: number;
  scaledUiConfig?: { multiplier?: number } | null;
  // xStocks-specific: the issuer's reference price for the underlying stock. Present even for an
  // xStock with NO Solana pool yet (then usdPrice/liquidity are absent) — verified live 2026-09-14
  // on DALx. A price, not a route: a swap may still be impossible.
  stockData?: { price?: number; mcap?: number; updatedAt?: string } | null;
}

async function fetchChunk(ids: string[]): Promise<Record<string, JupPriceEntry>> {
  const left = deadlineLeftMs();
  if (left !== undefined && left <= 0) throw new Error("Jupiter time budget exhausted");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), boundedTimeoutMs(TIMEOUT_MS));
  try {
    const res = await fetch(`${BASE}?ids=${ids.map(encodeURIComponent).join(",")}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    return (await res.json()) as Record<string, JupPriceEntry>;
  } finally {
    clearTimeout(t);
  }
}

// Resolve the RAW Jupiter entries for the given mints (deduped, chunked). Returns a partial map —
// mints Jupiter doesn't price are simply absent (no signal, never a crash). Throws
// JupiterUnavailableError only on a transport failure (non-2xx / timeout / network) so callers
// degrade to a typed 502 (F4). The stocks path needs decimals/liquidity/multiplier, not just USD.
export async function getPriceEntries(mints: string[]): Promise<Record<string, JupPriceEntry>> {
  const unique = [...new Set(mints.filter(Boolean))];
  const out: Record<string, JupPriceEntry> = {};
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    let data: Record<string, JupPriceEntry>;
    try {
      data = await fetchChunk(chunk);
    } catch (e) {
      throw new JupiterUnavailableError(`Jupiter fetch failed: ${(e as Error).message}`);
    }
    for (const [mint, entry] of Object.entries(data)) {
      if (entry) out[mint] = entry;
    }
  }
  return out;
}

// Resolve USD prices for the given mints. A thin map over getPriceEntries keeping the original
// contract: only a finite usdPrice > 0 lands in the map (exposure treats a missing mint as $0).
export async function getPrices(mints: string[]): Promise<PriceMap> {
  const entries = await getPriceEntries(mints);
  const out: PriceMap = {};
  for (const [mint, entry] of Object.entries(entries)) {
    if (typeof entry.usdPrice === "number" && entry.usdPrice > 0) out[mint] = entry.usdPrice;
  }
  return out;
}
