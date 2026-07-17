// Birdeye Wallet PnL integration (D4) — the ONLY source of the "you bought at $X" narrative line.
// Beta wallet APIs are hard-capped 5 rps / 75 rpm on every tier, so this is NEVER called
// synchronously per screen: the snapshot builder calls it at most once per address per TTL, behind a
// single-flight guard (concurrent snapshot builds for the same wallet share one call) and an
// in-process rate guard. EVERY failure path returns null → the card still renders, just without the
// avg-cost line (graceful degradation, spec §2). BIRDEYE_API_KEY env.
//
// The exact beta wallet-PnL response shape is not pinned here (it's beta + capped, hard to snapshot):
// the parser is defensive across the common field names and returns null on any mismatch, so a shape
// drift degrades to "no narrative" rather than a crash or a wrong number.

import { rateLimit } from "./ratelimit";

const BASE = process.env.BIRDEYE_API_BASE ?? "https://public-api.birdeye.so";
const PNL_PATH = process.env.BIRDEYE_PNL_PATH ?? "/wallet/v2/pnl"; // D4: /wallet/v2/pnl*
const TIMEOUT_MS = 10_000;

// mint -> average buy cost in integer USD cents. null = the call failed/was skipped (retry next TTL);
// an object (possibly empty) = a successful call (cache it, even if it carried no cost data).
export type AvgCostMap = Record<string, number>;

const inflight = new Map<string, Promise<AvgCostMap | null>>();

// Respect the beta caps WITHOUT blocking: if we're at the limit, skip the call (degrade to null)
// rather than queue — a missing narrative line is fine, a stalled request is not.
function underRateCap(): boolean {
  if (!rateLimit("birdeye:rpm", 75, 60_000)) return false;
  if (!rateLimit("birdeye:rps", 5, 1_000)) return false;
  return true;
}

// Pull an average-buy-price number out of one token PnL entry across the common beta field names.
function avgCostUsdOf(entry: Record<string, unknown>): number | null {
  const keys = ["avgBuyPrice", "avg_buy_price", "averageBuyPrice", "buyAvgPrice", "avgCost", "costBasis"];
  for (const k of keys) {
    const v = entry[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function mintOf(entry: Record<string, unknown>): string | null {
  for (const k of ["address", "mint", "tokenAddress", "token_address"]) {
    const v = entry[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// Defensively walk a few known container shapes to an array of token entries.
function entriesOf(json: unknown): Record<string, unknown>[] {
  const data = (json as { data?: unknown })?.data ?? json;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const items = (data as { items?: unknown; tokens?: unknown })?.items ?? (data as { tokens?: unknown })?.tokens;
  if (Array.isArray(items)) return items as Record<string, unknown>[];
  // { data: { <mint>: {..} } } form
  if (data && typeof data === "object") {
    const vals = Object.values(data as Record<string, unknown>).filter((v) => v && typeof v === "object");
    if (vals.length && vals.every((v) => typeof v === "object")) return vals as Record<string, unknown>[];
  }
  return [];
}

async function fetchPnl(address: string): Promise<AvgCostMap | null> {
  const key = (process.env.BIRDEYE_API_KEY ?? "").trim();
  if (!key) return null; // no key -> no narrative (graceful)
  if (!underRateCap()) return null; // beta cap hit -> skip this cycle

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${BASE}${PNL_PATH}?wallet=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json", "X-API-KEY": key, "x-chain": "solana" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const map: AvgCostMap = {};
    for (const entry of entriesOf(json)) {
      const mint = mintOf(entry);
      const usd = avgCostUsdOf(entry);
      if (mint && usd != null) map[mint] = Math.round(usd * 100); // USD -> cents
    }
    return map;
  } catch {
    return null; // timeout / transport / parse failure -> degrade
  } finally {
    clearTimeout(t);
  }
}

// Average buy cost per mint (integer cents), or null when Birdeye is unavailable/capped/keyless.
// Single-flight per address: concurrent callers share one in-flight request.
export async function getWalletAvgCost(address: string): Promise<AvgCostMap | null> {
  const existing = inflight.get(address);
  if (existing) return existing;
  const p = fetchPnl(address).finally(() => inflight.delete(address));
  inflight.set(address, p);
  return p;
}
