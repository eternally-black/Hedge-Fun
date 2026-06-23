// Polymarket read-integration (Gamma API). Read-only — no orders, wallets, signatures.
// Base: https://gamma-api.polymarket.com
//
// Verified facts (blueprint, re-checked by scripts/verify-polymarket.ts):
//  - outcomes / outcomePrices / clobTokenIds are JSON-encoded STRINGS -> JSON.parse.
//  - end_date_min / end_date_max (snake_case, full ISO) filter by resolution time.
//  - Resolution signal = umaResolutionStatus === "resolved" + outcomePrices collapse to 1/0.
//  - conditionId is the stable id -> our polymarketId.

const BASE = process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com";

export interface MarketCache {
  polymarketId: string;
  question: string;
  category: string | null;
  yesPriceBp: number | null;
  noPriceBp: number | null;
  resolutionDeadline: string; // ISO UTC (endDate)
  status: "OPEN" | "CLOSED" | "RESOLVED";
  resolvedOutcome: "YES" | "NO" | null;
}

// Raw Gamma market shape (only the fields we read; many more exist).
interface GammaMarket {
  conditionId?: string;
  question?: string;
  category?: string | null;
  image?: string | null;
  endDate?: string;
  outcomes?: string; // JSON string e.g. '["Yes","No"]'
  outcomePrices?: string; // JSON string e.g. '["0.42","0.58"]'
  closed?: boolean;
  active?: boolean;
  umaResolutionStatus?: string;
}

function parseJsonArray(s: string | undefined): string[] | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : null;
  } catch {
    return null;
  }
}

// Fraction (0..1) -> basis points (0..10000).
function toBp(x: number): number {
  return Math.round(x * 10000);
}

// Map a raw Gamma market to our cache shape. Returns null if unusable (missing id,
// endDate, or a non-Yes/No outcome pair we can't interpret).
export function mapMarket(m: GammaMarket): MarketCache | null {
  if (!m.conditionId || !m.endDate || !m.question) return null;

  const outcomes = parseJsonArray(m.outcomes);
  const prices = parseJsonArray(m.outcomePrices);
  // Guard: we only handle binary Yes/No markets. Fail loud on anything else.
  if (!outcomes || outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  const noIdx = outcomes.findIndex((o) => o.toLowerCase() === "no");
  if (yesIdx === -1 || noIdx === -1) return null;

  let yesPriceBp: number | null = null;
  let noPriceBp: number | null = null;
  if (prices && prices.length === 2) {
    const y = Number(prices[yesIdx]);
    const n = Number(prices[noIdx]);
    if (Number.isFinite(y)) yesPriceBp = toBp(y);
    if (Number.isFinite(n)) noPriceBp = toBp(n);
  }

  // Resolution: umaResolutionStatus === "resolved" AND a clean 1/0 price collapse.
  let status: MarketCache["status"] = "OPEN";
  let resolvedOutcome: MarketCache["resolvedOutcome"] = null;
  const resolved = m.umaResolutionStatus === "resolved";
  if (resolved && prices && prices.length === 2) {
    const y = Number(prices[yesIdx]);
    const n = Number(prices[noIdx]);
    if (y === 1 && n === 0) {
      status = "RESOLVED";
      resolvedOutcome = "YES";
    } else if (y === 0 && n === 1) {
      status = "RESOLVED";
      resolvedOutcome = "NO";
    }
    // else: resolved flag but non-clean prices -> treat as still settling (leave OPEN).
  } else if (m.closed) {
    status = "CLOSED"; // trading halted, UMA not final yet (dispute window)
  }

  return {
    polymarketId: m.conditionId,
    question: m.question,
    category: m.category ?? null,
    yesPriceBp,
    noPriceBp,
    resolutionDeadline: m.endDate,
    status,
    resolvedOutcome,
  };
}

async function gammaGet(path: string): Promise<GammaMarket[]> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Gamma ${res.status} for ${path}`);
  return (await res.json()) as GammaMarket[];
}

// Blitz deck: active, not-closed markets resolving within `hours`, mapped to cache shape.
export async function fetchBlitzDeck(hours = 24, limit = 100): Promise<MarketCache[]> {
  const now = new Date();
  const max = new Date(now.getTime() + hours * 3_600_000);
  const qs = new URLSearchParams({
    active: "true",
    closed: "false",
    enableOrderBook: "true",
    end_date_min: now.toISOString(),
    end_date_max: max.toISOString(),
    order: "endDate",
    ascending: "true",
    limit: String(limit),
  });
  const raw = await gammaGet(`/markets?${qs.toString()}`);
  const maxMs = max.getTime();
  return raw
    .map(mapMarket)
    .filter((m): m is MarketCache => m !== null)
    .filter((m) => m.status === "OPEN" && m.yesPriceBp !== null && m.noPriceBp !== null)
    // Re-assert the <=24h window client-side (don't trust the param alone).
    .filter((m) => new Date(m.resolutionDeadline).getTime() <= maxMs);
}

// Resolution lookup for one market by conditionId.
export async function fetchResolution(conditionId: string): Promise<MarketCache | null> {
  const raw = await gammaGet(`/markets?condition_ids=${encodeURIComponent(conditionId)}`);
  // Only trust a row whose conditionId actually matches — never settle against the wrong
  // market if Gamma returns something unexpected (L1).
  const match = raw.find((m) => m.conditionId === conditionId);
  if (!match) return null;
  return mapMarket(match);
}
