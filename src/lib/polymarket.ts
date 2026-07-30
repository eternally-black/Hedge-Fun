// Polymarket read-integration (Gamma API). Read-only — no orders, wallets, signatures.
// Base: https://gamma-api.polymarket.com
//
// Verified facts (blueprint, re-checked by scripts/verify-polymarket.ts):
//  - outcomes / outcomePrices / clobTokenIds are JSON-encoded STRINGS -> JSON.parse.
//  - end_date_min / end_date_max (snake_case, full ISO) filter by resolution time.
//  - Resolution signal = umaResolutionStatus === "resolved" + outcomePrices collapse to 1/0.
//  - conditionId is the stable id -> our polymarketId.

import { isContextPoor, isVagueEsports, withinCategoryHorizon, DECK_FETCH_HORIZON_HOURS } from "./deck-mix";

const BASE = process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com";

export interface MarketCache {
  polymarketId: string;
  question: string;
  category: string | null;
  // Internal model stays binary YES/NO: side A (outcome index 0) = YES, side B (index 1) = NO.
  // The labels carry the REAL side names ("L1ga Team" / "4ikibamboni", "Over" / "Under",
  // "Yes" / "No") so the card shows the actual sides, not a forced Yes/No.
  outcomeYesLabel: string; // index-0 outcome label (the YES side)
  outcomeNoLabel: string; // index-1 outcome label (the NO side)
  yesPriceBp: number | null;
  noPriceBp: number | null;
  startsAt: string | null; // ISO UTC (startDate); null if absent (crypto/Yes-No have none)
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
  startDate?: string; // ISO; present on sports/esports (match kickoff), absent on crypto/Yes-No
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
  // Guard: only BINARY markets (exactly 2 outcomes). Polymarket binaries come in three
  // flavours, and we accept all of them by keeping the real side labels instead of forcing
  // Yes/No (verified live 2026-06-24): Yes/No, Up/Down, and NAMED (teams, players, Over/Under,
  // candidates — e.g. ["L1ga Team","4ikibamboni"], ["Over","Under"]). Internal model is binary:
  // outcome index 0 = the YES side, index 1 = the NO side; the labels carry the display names.
  // Multi-outcome markets (>2) are still rejected — we don't model n-way bets.
  if (!outcomes || outcomes.length !== 2) return null;
  const yesLabel = (outcomes[0] ?? "").trim();
  const noLabel = (outcomes[1] ?? "").trim();
  if (!yesLabel || !noLabel || yesLabel === noLabel) return null;

  let yesPriceBp: number | null = null;
  let noPriceBp: number | null = null;
  if (prices && prices.length === 2) {
    const y = Number(prices[0]);
    const n = Number(prices[1]);
    if (Number.isFinite(y)) yesPriceBp = toBp(y);
    if (Number.isFinite(n)) noPriceBp = toBp(n);
  }

  // Resolution: umaResolutionStatus === "resolved" AND a clean 1/0 price collapse. The WINNING
  // side is whichever index collapsed to 1 — YES if index 0, NO if index 1 (works for any
  // labels, since we settle by side index, not by the literal word).
  let status: MarketCache["status"] = "OPEN";
  let resolvedOutcome: MarketCache["resolvedOutcome"] = null;
  const resolved = m.umaResolutionStatus === "resolved";
  if (resolved && prices && prices.length === 2) {
    const y = Number(prices[0]);
    const n = Number(prices[1]);
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
    outcomeYesLabel: yesLabel,
    outcomeNoLabel: noLabel,
    yesPriceBp,
    noPriceBp,
    startsAt: m.startDate ?? null, // pure shape-map; the not-started gate lives in fetchBlitzDeck + deck route
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

const GAMMA_PAGE = 100; // Gamma caps `limit` at 100/request regardless of what we ask.
const MAX_PAGES = 15; // backstop: never page forever (15 * 100 = 1500 markets scanned).

// Degenerate-price gate: drop cards priced so lopsided they're not worth swiping.
// A sports/esports match that's live or over collapses to ~99.95%/0.05% ("100% / 0%"),
// which is a dead swipe and a meaningless paper bet. We filter by PRICE, not by start time:
// Gamma's startDate is when trading OPENED (always in the past for near-term markets, even
// for crypto), so it can't tell "match not started" from "match live" — verified live
// 2026-06-24. Price collapse is the direct, shape-agnostic signal. Keep 15%..85% (1500..8500bp)
// so even moderately skewed lines are dropped; only genuinely contested markets reach the deck.
const PRICE_FLOOR_BP = 1500; // 15%
const PRICE_CEIL_BP = 8500; // 85%
function priceIsContested(yesBp: number, noBp: number): boolean {
  return yesBp >= PRICE_FLOOR_BP && yesBp <= PRICE_CEIL_BP && noBp >= PRICE_FLOOR_BP && noBp <= PRICE_CEIL_BP;
}

// Classify a binary market by its side labels, so the deck can balance the mix.
type Shape = "crypto" | "overunder" | "named";
function shapeOf(m: MarketCache): Shape {
  const y = m.outcomeYesLabel.toLowerCase();
  const n = m.outcomeNoLabel.toLowerCase();
  if ((y === "up" && n === "down") || (y === "yes" && n === "no")) return "crypto"; // gen Yes/No + Up/Down
  if (y === "over" || y === "under") return "overunder";
  return "named"; // teams, players, candidates
}

// Blitz deck: active, not-closed binary markets, each kept only within ITS category's horizon
// (crypto/OU <=24h, sports/esports <=72h — see DECK_HORIZON_HOURS), balanced by shape.
//
// What this has to handle:
//  - Gamma ignores limit>100, so we PAGINATE by offset.
//  - The near queue is saturated with minutes-long markets, so a single endDate-ascending scan
//    never reaches anything longer-dated — see HORIZON_BANDS below for the incident this caused.
//    We therefore sample each band with its own query and quota.
//  - Within a band, sorted by endDate, crypto Up/Down still dominates; sports & esports are sparse.
//    So we drop each market past its own category horizon (keeps crypto blitz-fresh while letting
//    sparse sports/esports through), bucket by shape, then INTERLEAVE round-robin (named,
//    over/under, crypto, ...) — the deck always carries teams/sports, not a monolith of crypto.
//    Buckets fill band by band, so each one already spans horizons before the interleave runs.
// ─── Horizon bands ────────────────────────────────────────────────────────────────────────────────
// The deck is sampled from SEVERAL time windows with per-band quotas, not from the front of one
// endDate-ascending scan.
//
// Why (diagnosed on prod 2026-07-30, deck effectively empty): Polymarket's near queue is SATURATED
// with minutes-long markets — 15-minute crypto Up/Down across ~8 assets plus in-play football
// totals. Ordered by endDate from `now`, the first 1500 rows (our MAX_PAGES ceiling) were ALL
// resolving inside the hour, so the scan never reached anything longer-dated. Every refresh
// therefore cached 100 markets that expired within minutes, and after the DECK_MIN_LEAD_MS serve
// buffer the deck held ~26 cards out of a 157k-row cache. The shape interleave below could not
// help: it balances what the scan brought back, and the scan kept bringing back the same short
// slice. This degraded gradually as Polymarket added live markets — nothing "broke".
//
// Quotas fix it structurally: each band is its own query, so a saturated near band can never crowd
// out the far ones. The near band keeps the blitz feel; the far bands guarantee the deck still has
// playable cards several minutes from now.
const HORIZON_BANDS: { fromH: number; toH: number; share: number }[] = [
  { fromH: 0, toH: 1, share: 0.3 }, // blitz: crypto Up/Down, in-play totals
  { fromH: 1, toH: 6, share: 0.25 },
  { fromH: 6, toH: 24, share: 0.25 }, // crypto/OU category horizon ends at 24h
  { fromH: 24, toH: 72, share: 0.2 }, // sports/esports only (their horizon runs to 72h)
];

export async function fetchBlitzDeck(hours = DECK_FETCH_HORIZON_HOURS, want = 100): Promise<MarketCache[]> {
  const now = new Date();
  const nowMs = now.getTime();
  const maxMs = nowMs + hours * 3_600_000;
  const buckets: Record<Shape, MarketCache[]> = { named: [], overunder: [], crypto: [] };

  for (const band of HORIZON_BANDS) {
    const bandFromMs = nowMs + band.fromH * 3_600_000;
    const bandToMs = Math.min(nowMs + band.toH * 3_600_000, maxMs);
    if (bandFromMs >= bandToMs) continue; // band lies outside a caller-narrowed `hours`
    const quota = Math.max(1, Math.round(want * band.share));
    let kept = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({
        active: "true",
        closed: "false",
        enableOrderBook: "true",
        end_date_min: new Date(bandFromMs).toISOString(),
        end_date_max: new Date(bandToMs).toISOString(),
        order: "endDate",
        ascending: "true",
        limit: String(GAMMA_PAGE),
        offset: String(page * GAMMA_PAGE),
      });
      const raw = await gammaGet(`/markets?${qs.toString()}`);
      if (raw.length === 0) break;

      for (const r of raw) {
        if (kept >= quota) break; // band quota filled — stop mid-page, don't overshoot by a page
        const m = mapMarket(r);
        if (
          m &&
          m.status === "OPEN" &&
          m.yesPriceBp !== null &&
          m.noPriceBp !== null &&
          new Date(m.resolutionDeadline).getTime() <= maxMs && // re-assert outer window client-side
          withinCategoryHorizon(m, new Date(m.resolutionDeadline).getTime(), nowMs) && // per-category cap
          priceIsContested(m.yesPriceBp, m.noPriceBp) && // drop decided/live matches (100%/0%)
          !isContextPoor(m) && // drop bare Over/Under totals with no match named ("Games Total: O/U 4.5")
          !isVagueEsports(m) // drop esports we can't name a game for (bare "Esports" badge)
        ) {
          buckets[shapeOf(m)].push(m);
          kept++;
        }
      }
      if (raw.length < GAMMA_PAGE) break; // last page of this band
      if (kept >= quota) break; // this band has contributed its share
    }
  }

  // Round-robin interleave: named first each round so sports/esports lead, then OU, then crypto.
  const order: Shape[] = ["named", "overunder", "crypto"];
  const out: MarketCache[] = [];
  for (let i = 0; out.length < want; i++) {
    let added = false;
    for (const s of order) {
      if (buckets[s][i]) {
        out.push(buckets[s][i]);
        added = true;
        if (out.length >= want) break;
      }
    }
    if (!added) break; // all buckets exhausted
  }
  return out;
}

// Resolution lookup for one market by conditionId.
//
// closed=true is LOAD-BEARING: Gamma's /markets defaults to returning only NON-closed markets,
// but a resolved market is closed=true — so the bare query returns 0 rows and we'd never settle
// it (bet stuck "Awaiting resolution" forever). Verified live 2026-06-25: a resolved XRP Up/Down
// market returned rows=0 without the param, rows=1 (uma=resolved, prices ["1","0"]) with it.
// We only call this to DETECT resolution, so excluding still-open markets here is correct: an
// open market resolves to null -> {kind:"open"} -> no-op, exactly as before.
export async function fetchResolution(conditionId: string): Promise<MarketCache | null> {
  const raw = await gammaGet(`/markets?closed=true&condition_ids=${encodeURIComponent(conditionId)}`);
  // Only trust a row whose conditionId actually matches — never settle against the wrong
  // market if Gamma returns something unexpected (L1).
  const match = raw.find((m) => m.conditionId === conditionId);
  if (!match) return null;
  return mapMarket(match);
}
