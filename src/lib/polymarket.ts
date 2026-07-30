// Polymarket read-integration (Gamma API). Read-only — no orders, wallets, signatures.
// Base: https://gamma-api.polymarket.com
//
// Verified facts (blueprint, re-checked by scripts/verify-polymarket.ts):
//  - outcomes / outcomePrices / clobTokenIds are JSON-encoded STRINGS -> JSON.parse.
//  - end_date_min / end_date_max (snake_case, full ISO) filter by resolution time.
//  - Resolution signal = umaResolutionStatus === "resolved" + outcomePrices collapse to 1/0.
//  - conditionId is the stable id -> our polymarketId.

import {
  isContextPoor,
  isVagueEsports,
  withinCategoryHorizon,
  DECK_FETCH_HORIZON_HOURS,
  categoryOf,
  gameOf,
} from "./deck-mix";
import { evalMarketDepth } from "./depth";
import { ClobUnavailableError } from "./clob";

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
  yesPriceBp: number | null; // Gamma MID — reference only, never a quote and never POLYMARKET display (D10); a TXODDS row's synthetic odds ARE authoritative
  noPriceBp: number | null;
  // CLOB token ids (Gamma clobTokenIds[0/1]) — the handle every honest price comes from. A binary
  // market missing either id is NOT quotable: deck/hedge-index fetches drop it like any other
  // unusable row (mapMarket itself stays lenient so resolution detection never depends on them).
  yesTokenId: string | null;
  noTokenId: string | null;
  // Gamma enableOrderBook top-of-book for the YES token. Cheap pre-filter: the VWAP of a buy can
  // never beat the best ask, so a degenerate top-of-book proves gate-failure without a CLOB call.
  bestAskBp: number | null;
  // Depth-aware executable numbers (D10). Filled ONLY by fetches that run the depth gate
  // (fetchBlitzDeck); null on rows from fetchers whose callers evaluate depth themselves
  // (fetchMajorsMarkets / fetchSportsMarkets / fetchResolution).
  yesEffPriceBp: number | null; // VWAP to BUY STAKE_CENTS of YES, from the book
  noEffPriceBp: number | null;
  yesMaxStakeCents: number | null; // maxStakeWithinSlippage on the YES asks at the eligibility cap
  noMaxStakeCents: number | null;
  bookTsAt: string | null; // ISO — when the book behind the four eff numbers was read
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
  clobTokenIds?: string; // JSON string e.g. '["713210456792522125...", "521157195012..."]'
  bestBid?: string | number; // present when enableOrderBook=true (YES-token top of book)
  bestAsk?: string | number;
  spread?: string | number;
  closed?: boolean;
  active?: boolean;
  umaResolutionStatus?: string;
  // Hedge-index enrichment only (fetchMajorsMarkets): the slug carries the machine-parseable
  // strike+date+direction; liquidity/volume drive candidate ranking; events carry context.
  slug?: string;
  liquidityNum?: number;
  liquidity?: string | number;
  volumeNum?: number;
  volume?: string | number;
  events?: { slug?: string; ticker?: string; title?: string; series?: { title?: string }[] }[];
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

  // CLOB token ids, same JSON-string idiom as outcomes/outcomePrices. Kept NULLABLE here on
  // purpose: mapMarket also serves fetchResolution, and settlement must never fail just because a
  // (closed) market lost its token ids. Quotable-or-not is enforced by the fetch callers.
  const tokenIds = parseJsonArray(m.clobTokenIds);
  const yesTokenId = tokenIds && tokenIds.length === 2 && tokenIds[0] ? tokenIds[0] : null;
  const noTokenId = tokenIds && tokenIds.length === 2 && tokenIds[1] ? tokenIds[1] : null;
  const bestAsk = num(m.bestAsk);
  const bestAskBp = bestAsk !== null && Number.isFinite(bestAsk) ? toBp(bestAsk) : null;

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
    yesTokenId,
    noTokenId,
    bestAskBp,
    // Depth fields are filled by the depth-gating fetch (fetchBlitzDeck), never by the shape-map.
    yesEffPriceBp: null,
    noEffPriceBp: null,
    yesMaxStakeCents: null,
    noMaxStakeCents: null,
    bookTsAt: null,
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
// Exported for the S2 discovery FALLBACK (spec §2: "3 random open CONTESTED markets — reuse the
// price-contested gate") and reused by the D10 depth gate + the deck/feed serve paths, so the band
// lives in exactly ONE place. Since D10 it is applied to the EFFECTIVE (book-walked) price wherever
// a book exists; the Gamma mid only passes through it as an ingest-time pre-filter (fetchBlitzDeck)
// and as the TXODDS synthetic odds (authoritative there).
export function priceIsContested(yesBp: number, noBp: number): boolean {
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
//
// D10 (depth gate): a contested MID is not a tradable BOOK (the bid-1¢/ask-98¢ husk reads 49.5¢
// on the mid yet costs 98¢ to actually buy). So after the scan we OVER-FETCH (~2× want — the gate
// drops ~17%, measured live 2026-07-26, landing mostly on the crypto bucket), walk both books of
// every candidate, and gate on the EFFECTIVE price + fill BEFORE the interleave. Filtering after
// the interleave instead would shrink the deck below `want` and skew the mix toward whichever
// bucket's books survive best.
// What one candidate's trip through the depth gate means for the PERSISTED row (1b):
//  - "pass":   gate passed; the executable numbers are attached to the row (upserted verbatim).
//  - "reject": the gate EVALUATED the market and found it UNTRADABLE — a real book read that cannot
//              fill STAKE_CENTS within the cap, or Gamma's top-of-book proves the YES side unbuyable.
//              refresh-deck persists an explicit rejection stamp (eff null, capacity 0, bookTsAt now)
//              so an already-cached row stops serving within one tick instead of lingering on stale
//              eff prices until the display-staleness bound.
//  - "drop":   excluded from this run's deck but NEVER stamped. Three kinds, deliberately:
//              (a) contested-band failures — a deck-product verdict other pipelines legitimately
//                  disagree with (the hedge index serves wider bands off the SAME Market row;
//                  stamping would null out eff prices the hedge surfaces validly serve, and the two
//                  refreshes would fight over the row every tick). The serve-time band re-asserts
//                  itself per request, so these rows never reach a card anyway;
//              (b) CLOB outages — "can't PROVE tradability this run" is not untradability; stamping
//                  on an outage would empty the whole deck exactly when the CLOB is down;
//              (c) missing token ids — never evaluated at all.
type GateVerdict = "pass" | "reject" | "drop";

export interface BlitzDeckResult {
  deck: MarketCache[]; // gate survivors, round-robin interleaved (unchanged semantics)
  // polymarketIds the gate evaluated this run and found untradable ("reject" above). Only THESE get
  // the rejection stamp — never "dropped" rows, and never markets the run simply didn't reach
  // (fetchBlitzDeck breaks early once its buckets fill, so most valid in-window markets are never
  // evaluated on a given run; inferring rejection from absence would wrongly clear them).
  rejected: string[];
}

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

export async function fetchBlitzDeck(hours = DECK_FETCH_HORIZON_HOURS, want = 100): Promise<BlitzDeckResult> {
  const now = new Date();
  const nowMs = now.getTime();
  const maxMs = nowMs + hours * 3_600_000;
  const buckets: Record<Shape, MarketCache[]> = { named: [], overunder: [], crypto: [] };
  const overfetch = want * 2; // pre-gate candidate target (see header)

  // Which band each candidate came from. Needed AFTER collection: buckets fill band by band, so
  // truncating them to `want` at the interleave would take the earliest bands first and quietly
  // undo the whole point of sampling by horizon (measured: 6-24h contributed 0 cards until the
  // buckets were re-woven across bands below).
  const bandOf = new Map<string, number>();

  for (const [bandIdx, band] of HORIZON_BANDS.entries()) {
    const bandFromMs = nowMs + band.fromH * 3_600_000;
    const bandToMs = Math.min(nowMs + band.toH * 3_600_000, maxMs);
    if (bandFromMs >= bandToMs) continue; // band lies outside a caller-narrowed `hours`
    // Quota is against the OVER-FETCH target, not `want`: the depth gate below drops ~17% of
    // candidates, so a band that only ever collected its share of `want` would leave the deck short
    // after gating — and short in exactly the bands whose books are thinnest.
    const quota = Math.max(1, Math.round(overfetch * band.share));
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
          priceIsContested(m.yesPriceBp, m.noPriceBp) && // cheap MID pre-filter; the AUTHORITATIVE band runs on the eff price below
          !isContextPoor(m) && // drop bare Over/Under totals with no match named ("Games Total: O/U 4.5")
          !isVagueEsports(m) // drop esports we can't name a game for (bare "Esports" badge)
        ) {
          buckets[shapeOf(m)].push(m);
          bandOf.set(m.polymarketId, bandIdx);
          kept++;
        }
      }
      if (raw.length < GAMMA_PAGE) break; // last page of this band
      if (kept >= quota) break; // this band has contributed its share
    }
  }

  // Depth-gate BEFORE the round-robin interleave (see header). A market passes only when BOTH sides
  // quote, fill STAKE_CENTS within the eligibility cap, and the EFFECTIVE prices sit in the same
  // 1500..8500 contested band the mid pre-filter used — the band lives in priceIsContested, once.
  // Runs after ALL bands are collected, so the ~17% the gate drops is spread across horizons rather
  // than gutting whichever band happened to be scanned last.
  const candidates = [...buckets.named, ...buckets.overunder, ...buckets.crypto];
  const passed = new Set<string>();
  const rejected: string[] = [];
  await Promise.all(
    candidates.map(async (m) => {
      const v = await depthGateOne(m);
      if (v === "pass") passed.add(m.polymarketId);
      else if (v === "reject") rejected.push(m.polymarketId);
    }),
  );
  for (const s of Object.keys(buckets) as Shape[]) {
    const survivors = buckets[s].filter((m) => passed.has(m.polymarketId));
    // Re-weave each bucket across horizon bands. Without this the bucket stays band-ordered, and
    // since the interleave below takes the FIRST entries of each bucket, everything past the near
    // bands would be truncated away — the deck would look banded on paper and be all-blitz in fact.
    const byBand: MarketCache[][] = [];
    for (const m of survivors) {
      const bi = bandOf.get(m.polymarketId) ?? 0;
      (byBand[bi] ??= []).push(m);
    }
    const woven: MarketCache[] = [];
    for (let i = 0; ; i++) {
      let added = false;
      for (const list of byBand) {
        if (list?.[i]) {
          woven.push(list[i]);
          added = true;
        }
      }
      if (!added) break;
    }
    buckets[s] = woven;
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
  return { deck: out, rejected };
}

// One candidate through the D10 eligibility gate. On "pass", the executable numbers are ATTACHED to
// the row (refresh-deck persists them verbatim). The contested band consumes the EFFECTIVE price,
// not the mid — POLYMARKET rows never serve a mid anymore (see authoritativePrices). The verdict
// drives refresh-deck's rejection stamping — see GateVerdict above for what may and may not stamp.
async function depthGateOne(m: MarketCache): Promise<GateVerdict> {
  // Not quotable without BOTH token ids — never evaluated, so never stamped.
  if (!m.yesTokenId || !m.noTokenId) return "drop";
  // Cheap top-of-book skip (Gamma's enableOrderBook bestAsk): a buy's VWAP can never beat the best
  // ask, so an ask above the band ceiling guarantees the eff price fails the band, and an ask of 0
  // guarantees nothing fills. Spares a CLOB round-trip on husks (bid 1¢/ask 98¢) and empty books.
  // The two halves verdict differently: an EMPTY ask side is untradable for every pipeline (stamp
  // it), while above-ceiling is only the deck's contested band talking (drop, never stamp).
  if (m.bestAskBp !== null) {
    if (m.bestAskBp <= 0) return "reject";
    if (m.bestAskBp > PRICE_CEIL_BP) return "drop";
  }
  let d;
  try {
    d = await evalMarketDepth(m.yesTokenId, m.noTokenId);
  } catch (e) {
    // CLOB unreachable and no cached book: can't PROVE tradability this run -> drop the market
    // (next poller tick retries), but do NOT stamp — an outage is not untradability, and stamping
    // here would clear every row's eff prices exactly when the CLOB is down.
    if (e instanceof ClobUnavailableError) return "drop";
    throw e;
  }
  // Evaluated and untradable (one/both sides can't fill the stake within the cap) -> the rejection
  // stamp. "Read and untradable" is now distinguishable from "never read" (bookTsAt set vs null).
  if (!d.tradable || d.yesEffPriceBp === null || d.noEffPriceBp === null) return "reject";
  // Tradable but outside the DECK's contested band -> drop WITHOUT stamping: the hedge index serves
  // wider bands off the same Market row, and the serve-time band filter already keeps this off cards.
  if (!priceIsContested(d.yesEffPriceBp, d.noEffPriceBp)) return "drop";
  m.yesEffPriceBp = d.yesEffPriceBp;
  m.noEffPriceBp = d.noEffPriceBp;
  m.yesMaxStakeCents = d.yesMaxStakeCents;
  m.noMaxStakeCents = d.noMaxStakeCents;
  m.bookTsAt = d.bookTsAtMs !== null ? new Date(d.bookTsAtMs).toISOString() : null;
  return "pass";
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

// ─── Hedge index (phase 2, workstream A) ─────────────────────────────────────────────────────────
// Tag-based discovery of the crypto majors for the hedge engine. Unlike fetchBlitzDeck (which mixes
// a fresh deck), this pulls EVERY open market under one major's tag slug (bitcoin=235, ethereum=39,
// solana=818 — verified live 2026-07-17) so the ingest can parse strike+date+direction from the slug
// and store MarketMeta. Carries the raw slug + liquidity/volume + event context alongside the mapped
// cache row. Read-only Gamma, same idioms as fetchBlitzDeck (offset paging, 100/page cap).

export interface MajorsMarketRaw {
  cache: MarketCache; // mapped row for upserting the Market cache
  slug: string | null; // machine-parseable strike/date/direction lives here
  liquidityNum: number | null; // USD liquidity (ranking)
  volumeNum: number | null; // USD volume (ranking)
  eventSlug: string | null;
  eventTicker: string | null;
  seriesTitle: string | null;
}

function num(...vals: (number | string | undefined)[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// Fetch all OPEN, future-resolving markets under one Gamma tag id. `maxPages` bounds the scan
// (default 8 = up to 800 markets/tag). Returns only markets mapMarket accepts (binary, has an id).
export async function fetchMajorsMarkets(
  tagId: number,
  opts: { maxPages?: number } = {},
): Promise<MajorsMarketRaw[]> {
  const maxPages = opts.maxPages ?? 8;
  const now = new Date();
  const out: MajorsMarketRaw[] = [];

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      tag_id: String(tagId),
      active: "true",
      closed: "false",
      end_date_min: now.toISOString(),
      order: "endDate",
      ascending: "true",
      limit: String(GAMMA_PAGE),
      offset: String(page * GAMMA_PAGE),
    });
    const raw = await gammaGet(`/markets?${qs.toString()}`);
    if (raw.length === 0) break;

    for (const r of raw) {
      const cache = mapMarket(r);
      if (!cache) continue;
      const ev = r.events?.[0];
      out.push({
        cache,
        slug: r.slug ?? null,
        liquidityNum: num(r.liquidityNum, r.liquidity),
        volumeNum: num(r.volumeNum, r.volume),
        eventSlug: ev?.slug ?? null,
        eventTicker: ev?.ticker ?? null,
        seriesTitle: ev?.series?.[0]?.title ?? ev?.title ?? null,
      });
    }
    if (raw.length < GAMMA_PAGE) break; // last page
  }
  return out;
}

// ─── S2 sports/esports index (phase 2, workstream A2) ──────────────────────────────────────────────
// Discovery of upcoming NAMED sports/esports markets for the life-event hedge (S2). Reuses the SAME
// Gamma idioms as fetchBlitzDeck (offset paging, mapMarket) and the SAME league knowledge as the deck
// (deck-mix categoryOf/gameOf) — no duplicated classification tables. Keeps only entity-vs-entity
// ("named") markets whose two side labels are the teams a user might support; the caller (the hedge
// index refresh) applies the S2 price band + upserts MarketMeta. Lists churn with the poller cadence
// (spec risk 4) — this is a live fetch, never a static import.

export interface SportsMarketRaw {
  cache: MarketCache; // mapped row for upserting the Market cache (so an accepted S2 hedge settles)
  slug: string | null;
  liquidityNum: number | null;
  volumeNum: number | null;
  eventSlug: string | null;
  eventTicker: string | null;
  seriesTitle: string | null;
  category: "sports" | "esports"; // from deck-mix categoryOf
  league: string | null; // from deck-mix gameOf (e.g. "NBA", "CS2"); null when not specifically known
}

// Fetch OPEN, future-resolving NAMED sports/esports markets within `hours` (default 10 days — the
// pickers want UPCOMING matches, a longer leash than the blitz deck). `maxPages` bounds the scan.
export async function fetchSportsMarkets(opts: { hours?: number; maxPages?: number } = {}): Promise<SportsMarketRaw[]> {
  const hours = opts.hours ?? 240; // 10 days
  const maxPages = opts.maxPages ?? 15;
  const now = new Date();
  const max = new Date(now.getTime() + hours * 3_600_000);
  const out: SportsMarketRaw[] = [];

  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      active: "true",
      closed: "false",
      enableOrderBook: "true",
      end_date_min: now.toISOString(),
      end_date_max: max.toISOString(),
      order: "endDate",
      ascending: "true",
      limit: String(GAMMA_PAGE),
      offset: String(page * GAMMA_PAGE),
    });
    const raw = await gammaGet(`/markets?${qs.toString()}`);
    if (raw.length === 0) break;

    for (const r of raw) {
      const cache = mapMarket(r);
      if (!cache || cache.status !== "OPEN" || cache.yesPriceBp === null || cache.noPriceBp === null) continue;
      if (shapeOf(cache) !== "named") continue; // entity-vs-entity only (the AGAINST-side needs two teams)
      const cat = categoryOf(cache);
      if (cat !== "sports" && cat !== "esports") continue;
      if (isContextPoor(cache) || isVagueEsports(cache)) continue; // drop jargon totals / unnamed esports
      const ev = r.events?.[0];
      out.push({
        cache,
        slug: r.slug ?? null,
        liquidityNum: num(r.liquidityNum, r.liquidity),
        volumeNum: num(r.volumeNum, r.volume),
        eventSlug: ev?.slug ?? null,
        eventTicker: ev?.ticker ?? null,
        seriesTitle: ev?.series?.[0]?.title ?? ev?.title ?? null,
        category: cat,
        league: gameOf(cache, cat),
      });
    }
    if (raw.length < GAMMA_PAGE) break; // last page
  }
  return out;
}
