// Jupiter price integration (D3: current market value). Public price API — NO key at our volumes.
// Maps a set of SPL mints to their current USD price. Native SOL is priced under the wSOL mint
// (WSOL_MINT), which is how the exposure core looks it up. Graceful: a mint Jupiter can't price is
// simply absent from the map (exposure treats it as $0 — no exposure signal, never a crash).
//
// Verified facts (Jupiter Lite Price API v3, verified live 2026-07-17):
//  - GET https://lite-api.jup.ag/price/v3?ids=<mint1,mint2,...>
//  - -> { "<mint>": { "usdPrice": <number>, "decimals": <int>, ... }, ... }  (missing mint => omitted)

import type { PriceMap } from "./hedge/exposure";

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
const CHUNK = 100; // ids per request (stay well under the URL/endpoint cap)

interface JupPriceEntry {
  usdPrice?: number;
}

async function fetchChunk(ids: string[]): Promise<Record<string, JupPriceEntry>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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

// Resolve USD prices for the given mints (deduped, chunked). Returns a partial map — mints Jupiter
// doesn't price are omitted (no exposure signal, never a crash). Throws JupiterUnavailableError only
// on a transport failure (non-2xx / timeout / network) so the route degrades to a typed 502 (F4).
export async function getPrices(mints: string[]): Promise<PriceMap> {
  const unique = [...new Set(mints.filter(Boolean))];
  const out: PriceMap = {};
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    let data: Record<string, JupPriceEntry>;
    try {
      data = await fetchChunk(chunk);
    } catch (e) {
      throw new JupiterUnavailableError(`Jupiter fetch failed: ${(e as Error).message}`);
    }
    for (const [mint, entry] of Object.entries(data)) {
      if (entry && typeof entry.usdPrice === "number" && entry.usdPrice > 0) out[mint] = entry.usdPrice;
    }
  }
  return out;
}
