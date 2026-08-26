// S2 (life-event hedge) DB glue over the pure cores (s2match + nlu). Owns three surfaces:
//   • getPickers()  — the PRIMARY structured team/league lists (TTL-cached), built ONLY from entities
//                     that currently have an open, upcoming market (spec §2 "pickers primary").
//   • searchS2()    — the SECONDARY free-text path: deterministic match -> NLU edge (below threshold,
//                     D2) -> re-run -> discovery fallback. A team you SUPPORT -> an AGAINST suggestion
//                     on its nearest upcoming market. Fallback = 3 random contested markets (discovery).
//   • resolveDerivedSuggestion() — the accept/telemetry re-derivation path: given a suggestion id,
//                     re-build it from persisted state (S1 snapshot, or open S2/fallback markets) WITHOUT
//                     the original query, so /accept and /event stay idempotent for S2/FALLBACK too.
//
// Suggestions are NOT stored — they are re-derivable, exactly like S1. LLM never picks side/size/market
// (D1): here the LLM only re-seeds the DETERMINISTIC search with extracted entities.

import { prisma } from "../prisma";
import { s2SuggestionId, isHexSuggestionId } from "./id";
import { deriveForUser, type DerivedSuggestion } from "./suggest";
import {
  scoreMatch,
  opposingSide,
  backedSideForQuery,
  isNamedEntityShape,
  type S2Candidate,
  type S2Match,
} from "./s2match";
import { extractEntities } from "./nlu";
import { priceIsContested, isCompositeSideLabel } from "../polymarket";
import { authoritativePrices } from "../depth";
import type { BetSide, HedgeSuggestion, HedgePickersResponse } from "../api-types";
import {
  DECK_MIN_LEAD_MS,
  HEDGE_S2_STAKE_CENTS,
  S2_CONFIDENCE_THRESHOLD,
  HEDGE_FALLBACK_COUNT,
  HEDGE_FALLBACK_POOL_MAX,
  S2_SIDE_FLOOR_BP,
  S2_SIDE_CEIL_BP,
} from "../config";

// One open, upcoming, S2-eligible market with the fields the matcher + suggestion builder need.
// yesPriceBp/noPriceBp carry the AUTHORITATIVE price (see loadS2Candidates): the book-walked eff
// VWAP for POLYMARKET rows, the stored odds for a bookless source — never a bookless mid.
interface S2MarketRow {
  marketId: string;
  question: string;
  category: string | null;
  yesLabel: string;
  noLabel: string;
  yesPriceBp: number;
  noPriceBp: number;
  deadline: Date;
  leagueSlug: string | null;
  leagueLabel: string | null;
}

// Load the S2-eligible market index: NAMED sports/esports markets, OPEN, still far enough from
// resolution to be a usable hedge (same lead the accept path enforces). BOTH side prices must be
// within the S2 band [S2_SIDE_FLOOR_BP, S2_SIDE_CEIL_BP] — a read-time re-check (F2) so a live/decided
// price collapse (~99.5/0.5) is dropped even between refresh runs (before the refresh clear-pass has
// demoted s2Eligible). The band consumes the AUTHORITATIVE price (D10): the persisted eff VWAP for
// POLYMARKET rows — computed at STAKE_CENTS, which IS the fixed S2 stake, so the displayed payout is
// the one the accept's live re-quote honours — and the stored odds for a bookless source. A POLYMARKET row
// with no eff prices, or a book read older than the display-staleness bound, is dropped here even
// while still flagged s2Eligible: the mid is never a stand-in. Churns as the refresh poller updates
// MarketMeta (spec risk 4).
async function loadS2Candidates(nowMs: number): Promise<S2MarketRow[]> {
  const rows = await prisma.marketMeta.findMany({
    where: {
      s2Eligible: true,
      market: {
        is: {
          status: "OPEN",
          resolutionDeadline: { gt: new Date(nowMs + DECK_MIN_LEAD_MS) },
        },
      },
    },
    select: {
      leagueSlug: true,
      leagueLabel: true,
      market: {
        select: {
          id: true,
          question: true,
          category: true,
          outcomeYesLabel: true,
          outcomeNoLabel: true,
          yesPriceBp: true,
          noPriceBp: true,
          yesEffPriceBp: true,
          noEffPriceBp: true,
          bookTsAt: true,
          source: true,
          resolutionDeadline: true,
        },
      },
    },
  });

  const out: S2MarketRow[] = [];
  for (const r of rows) {
    const m = r.market;
    const p = authoritativePrices(m, nowMs);
    if (p.yes === null || p.no === null) continue; // no usable book read (POLYMARKET) -> not servable
    if (p.yes < S2_SIDE_FLOOR_BP || p.yes > S2_SIDE_CEIL_BP) continue;
    if (p.no < S2_SIDE_FLOOR_BP || p.no > S2_SIDE_CEIL_BP) continue;
    if (!isNamedEntityShape(m.outcomeYesLabel, m.outcomeNoLabel)) continue; // defensive: shape guard
    out.push({
      marketId: m.id,
      question: m.question,
      category: m.category,
      yesLabel: m.outcomeYesLabel,
      noLabel: m.outcomeNoLabel,
      yesPriceBp: p.yes,
      noPriceBp: p.no,
      deadline: m.resolutionDeadline,
      leagueSlug: r.leagueSlug,
      leagueLabel: r.leagueLabel,
    });
  }
  return out;
}

// ── pickers (TTL-cached) ───────────────────────────────────────────────────────────────────────────

let pickersCache: { at: number; data: HedgePickersResponse } | null = null;
const PICKERS_TTL_MS = 60_000; // 1 min — cheap freshness; the underlying index refreshes on poller cadence

export async function getPickers(): Promise<HedgePickersResponse> {
  if (pickersCache && Date.now() - pickersCache.at < PICKERS_TTL_MS) return pickersCache.data;

  const rows = await loadS2Candidates(Date.now());
  const byLeague = new Map<string, { slug: string; label: string; teams: Set<string> }>();
  for (const r of rows) {
    if (!r.leagueSlug || !r.leagueLabel) continue; // only markets with a recognised league land in a picker
    let g = byLeague.get(r.leagueSlug);
    if (!g) {
      g = { slug: r.leagueSlug, label: r.leagueLabel, teams: new Set() };
      byLeague.set(r.leagueSlug, g);
    }
    // A composite side ("Rodez Aveyron Football or draw" — the NO side of a one-sided football
    // moneyline) is an outcome set, not a team, so it is never offered as something to support. Its
    // team is listed anyway: the same match's other market carries that club as its own YES side.
    if (r.yesLabel.trim() && !isCompositeSideLabel(r.yesLabel)) g.teams.add(r.yesLabel.trim());
    if (r.noLabel.trim() && !isCompositeSideLabel(r.noLabel)) g.teams.add(r.noLabel.trim());
  }
  const leagues = [...byLeague.values()]
    .map((g) => ({ slug: g.slug, label: g.label, teams: [...g.teams].sort((a, b) => a.localeCompare(b)) }))
    .filter((l) => l.teams.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  const data: HedgePickersResponse = { leagues };
  pickersCache = { at: Date.now(), data };
  return data;
}

// ── suggestion builders (deterministic) ─────────────────────────────────────────────────────────────

// The AGAINST suggestion for a supported entity: bet the OPPOSITE side of the market it plays in.
// Returns null if that side has no price (can't lock a hedge). matchConfidence is display-only (search).
function buildS2Suggestion(row: S2MarketRow, supportedSide: BetSide, matchConfidence?: number): HedgeSuggestion | null {
  const side = opposingSide(supportedSide);
  const priceBp = side === "YES" ? row.yesPriceBp : row.noPriceBp;
  if (priceBp == null) return null;
  const sideLabel = side === "YES" ? row.yesLabel : row.noLabel;
  const matchedEntity = supportedSide === "YES" ? row.yesLabel : row.noLabel;
  const sid = s2SuggestionId({ marketId: row.marketId, kind: "S2", side, proposedStakeCents: HEDGE_S2_STAKE_CENTS });
  return {
    id: row.marketId,
    question: row.question,
    category: row.category,
    outcomeYesLabel: row.yesLabel,
    outcomeNoLabel: row.noLabel,
    yesPriceBp: row.yesPriceBp,
    noPriceBp: row.noPriceBp,
    resolutionDeadline: row.deadline.toISOString(),
    suggestionId: sid,
    kind: "S2",
    side,
    sideLabel,
    proposedStakeCents: HEDGE_S2_STAKE_CENTS,
    hedgedAsset: "", // no crypto asset in a life-event hedge
    hedgedNotionalCents: 0, // no position notional to size against
    isProxy: false,
    avgBuyCostNarrative: null,
    isDiscovery: false,
    matchedEntity,
    league: row.leagueLabel,
    matchConfidence,
  };
}

// A discovery fallback card from ANY open contested market. NOT a hedge — isDiscovery flags it so the
// client labels it honestly. Canonical side = YES so the id is stable + re-derivable on accept.
function buildFallbackSuggestion(row: {
  id: string;
  question: string;
  category: string | null;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
  yesPriceBp: number;
  noPriceBp: number;
  resolutionDeadline: Date;
}): HedgeSuggestion {
  const sid = s2SuggestionId({ marketId: row.id, kind: "FALLBACK", side: "YES", proposedStakeCents: HEDGE_S2_STAKE_CENTS });
  return {
    id: row.id,
    question: row.question,
    category: row.category,
    outcomeYesLabel: row.outcomeYesLabel,
    outcomeNoLabel: row.outcomeNoLabel,
    yesPriceBp: row.yesPriceBp,
    noPriceBp: row.noPriceBp,
    resolutionDeadline: row.resolutionDeadline.toISOString(),
    suggestionId: sid,
    kind: "fallback",
    side: "YES",
    sideLabel: row.outcomeYesLabel,
    proposedStakeCents: HEDGE_S2_STAKE_CENTS,
    hedgedAsset: "",
    hedgedNotionalCents: 0,
    isProxy: false,
    avgBuyCostNarrative: null,
    isDiscovery: true,
    matchedEntity: null,
    league: null,
  };
}

// ── free-text search (deterministic-first; NLU edge below threshold; discovery fallback) ─────────────

// Build the matcher candidate set from the open index: two ENTITY candidates per market (the two side
// labels), one LEAGUE candidate per distinct league, and the market QUESTION (spec §3: candidates =
// team names, league labels, market questions). Only ENTITY matches become AGAINST suggestions.
function buildMatchCandidates(rows: S2MarketRow[]): S2Candidate[] {
  const cands: S2Candidate[] = [];
  const seenLeague = new Set<string>();
  for (const r of rows) {
    cands.push({ ref: `e|${r.marketId}|YES`, label: r.yesLabel, kind: "entity" });
    cands.push({ ref: `e|${r.marketId}|NO`, label: r.noLabel, kind: "entity" });
    if (r.leagueSlug && r.leagueLabel && !seenLeague.has(r.leagueSlug)) {
      seenLeague.add(r.leagueSlug);
      cands.push({ ref: `l|${r.leagueSlug}`, label: r.leagueLabel, kind: "league" });
    }
    cands.push({ ref: `q|${r.marketId}`, label: r.question, kind: "question" });
  }
  return cands;
}

// For a matched entity label, find its NEAREST upcoming market (soonest deadline) and build the
// AGAINST suggestion. Handles the same team appearing in several upcoming markets.
// The naming a market entity does NOT mean backing it (F19): the side is decided by the QUERY's
// polarity relative to that entity (backedSideForQuery), never by a blind inversion — "Barcelona will
// not win" backs the opponent, so its hedge is Barcelona's own side. Without this a negative query got
// the identical suggestion to "Barcelona will win" and doubled the user's exposure. `query` is the
// user's ORIGINAL text even on the NLU re-query path: the extractor returns entities, not polarity.
function buildNearestAgainst(rows: S2MarketRow[], entityLabel: string, confidence: number, query: string): HedgeSuggestion | null {
  const target = entityLabel.trim().toLowerCase();
  let best: { row: S2MarketRow; entitySide: BetSide } | null = null;
  for (const r of rows) {
    let entitySide: BetSide | null = null;
    if (r.yesLabel.trim().toLowerCase() === target) entitySide = "YES";
    else if (r.noLabel.trim().toLowerCase() === target) entitySide = "NO";
    if (!entitySide) continue;
    if (!best || r.deadline.getTime() < best.row.deadline.getTime()) best = { row: r, entitySide };
  }
  if (!best) return null;
  return buildS2Suggestion(best.row, backedSideForQuery(query, best.entitySide), confidence);
}

export interface S2SearchOutcome {
  suggestions: HedgeSuggestion[];
  isDiscovery: boolean;
  matchedEntity: string | null;
  usedNlu: boolean;
}

// Keep the best distinct-entity matches at/above threshold, most-confident first.
function passingEntityMatches(matches: S2Match[]): S2Match[] {
  return matches.filter((m) => m.kind === "entity" && m.score >= S2_CONFIDENCE_THRESHOLD);
}

export async function searchS2(query: string): Promise<S2SearchOutcome> {
  const nowMs = Date.now();
  const rows = await loadS2Candidates(nowMs);
  const candidates = buildMatchCandidates(rows);

  let matches = passingEntityMatches(scoreMatch(query, candidates));
  let usedNlu = false;

  // NLU edge (D2): only when the deterministic pass fell below threshold AND a key is configured.
  if (matches.length === 0) {
    const nlu = await extractEntities(query);
    usedNlu = nlu.usedNlu;
    if (nlu.result && (nlu.result.entities.length > 0 || nlu.result.keywords.length > 0)) {
      const requery = [...nlu.result.entities, ...nlu.result.keywords].join(" ");
      matches = passingEntityMatches(scoreMatch(requery, candidates));
    }
  }

  // Build AGAINST suggestions for the top distinct entities (each -> its nearest upcoming market).
  const suggestions: HedgeSuggestion[] = [];
  const usedEntities = new Set<string>();
  for (const m of matches) {
    const key = m.label.trim().toLowerCase();
    if (usedEntities.has(key)) continue;
    const built = buildNearestAgainst(rows, m.label, m.score, query);
    if (built) {
      suggestions.push(built);
      usedEntities.add(key);
    }
    if (suggestions.length >= 3) break;
  }

  if (suggestions.length === 0) {
    // Discovery fallback: 3 random open contested markets, honestly flagged (never a hedge).
    const fb = await searchFallback(nowMs);
    return { suggestions: fb, isDiscovery: true, matchedEntity: null, usedNlu };
  }
  return { suggestions, isDiscovery: false, matchedEntity: suggestions[0].matchedEntity ?? null, usedNlu };
}

// ── discovery fallback pool ──────────────────────────────────────────────────────────────────────

// The bounded contested pool the fallback draws from. Bounded + deterministically ordered so accept
// re-derivation (which enumerates the whole pool) stays cheap and matches whatever 3 were shown.
// Contested is judged on the AUTHORITATIVE price (D10): the persisted eff VWAP for POLYMARKET rows —
// computed at STAKE_CENTS, the fallback's fixed stake, so the shown payout is the accept's — the
// stored odds for a bookless source. A POLYMARKET row with no (fresh-enough) book read drops out here; the
// mid is never a stand-in (a bid-1¢/ask-98¢ husk reads contested on the mid — exactly the leak).
async function loadFallbackPool(nowMs: number) {
  const rows = await prisma.market.findMany({
    where: {
      status: "OPEN",
      yesPriceBp: { not: null },
      noPriceBp: { not: null },
      resolutionDeadline: { gt: new Date(nowMs + DECK_MIN_LEAD_MS) },
    },
    select: {
      id: true,
      question: true,
      category: true,
      outcomeYesLabel: true,
      outcomeNoLabel: true,
      yesPriceBp: true,
      noPriceBp: true,
      yesEffPriceBp: true,
      noEffPriceBp: true,
      bookTsAt: true,
      source: true,
      resolutionDeadline: true,
    },
    orderBy: { resolutionDeadline: "asc" },
    take: HEDGE_FALLBACK_POOL_MAX,
  });
  const out: {
    id: string;
    question: string;
    category: string | null;
    outcomeYesLabel: string;
    outcomeNoLabel: string;
    yesPriceBp: number;
    noPriceBp: number;
    resolutionDeadline: Date;
  }[] = [];
  for (const r of rows) {
    const p = authoritativePrices(r, nowMs);
    if (p.yes === null || p.no === null || !priceIsContested(p.yes, p.no)) continue;
    out.push({
      id: r.id,
      question: r.question,
      category: r.category,
      outcomeYesLabel: r.outcomeYesLabel,
      outcomeNoLabel: r.outcomeNoLabel,
      yesPriceBp: p.yes,
      noPriceBp: p.no,
      resolutionDeadline: r.resolutionDeadline,
    });
  }
  return out;
}

// Clock-seeded xorshift (no Math.random). Determinism doesn't matter for accept — any pool member
// re-derives — but seeding from the clock churns the shown discovery cards between requests.
function seededPick<T>(items: T[], n: number, seed: number): T[] {
  const pool = items.slice();
  let s = seed >>> 0 || 0x9e3779b9;
  const rand = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

async function searchFallback(nowMs: number): Promise<HedgeSuggestion[]> {
  const pool = await loadFallbackPool(nowMs);
  return seededPick(pool, HEDGE_FALLBACK_COUNT, nowMs).map(buildFallbackSuggestion);
}

// ── accept / telemetry re-derivation ────────────────────────────────────────────────────────────

// Enumerate every open S2 market's TWO against-suggestions (support side A -> against B, and vice
// versa) so /accept can match ANY S2 id the client holds, WITHOUT the original free text.
async function deriveS2ForAccept(): Promise<DerivedSuggestion[]> {
  const rows = await loadS2Candidates(Date.now());
  const items: DerivedSuggestion[] = [];
  for (const r of rows) {
    for (const supportedSide of ["YES", "NO"] as const) {
      const suggestion = buildS2Suggestion(r, supportedSide);
      if (suggestion) items.push({ address: "", enumKind: "S2", suggestion });
    }
  }
  return items;
}

// Enumerate the whole fallback pool so /accept can match any FALLBACK id that was shown as discovery.
async function deriveFallbackForAccept(): Promise<DerivedSuggestion[]> {
  const pool = await loadFallbackPool(Date.now());
  return pool.map((r) => ({ address: "", enumKind: "FALLBACK" as const, suggestion: buildFallbackSuggestion(r) }));
}

// Resolve a suggestion id back to its derived form for /accept + /event. Tries S1 (the caller's cached
// wallet snapshot), then the open S2 markets, then the fallback pool. Null => stale (the route 404s).
export async function resolveDerivedSuggestion(userId: string, sid: string): Promise<DerivedSuggestion | null> {
  const { items } = await deriveForUser(userId, { cacheOnly: true });
  const s1 = items.find((i) => i.suggestion.suggestionId === sid);
  if (s1) return s1;

  const s2 = await deriveS2ForAccept();
  const m2 = s2.find((i) => i.suggestion.suggestionId === sid);
  if (m2) return m2;

  const fb = await deriveFallbackForAccept();
  return fb.find((i) => i.suggestion.suggestionId === sid) ?? null;
}

// ── telemetry re-derivation cache (F14) ──────────────────────────────────────────────────────────
// /api/hedge/event fires impression/dismiss at up to 60/min/user, and each call re-derived the ENTIRE
// suggestion universe (per-user S1 snapshot + every open S2 market's two sides + the ≤300-row fallback
// pool) just to resolve ONE id. That is far too heavy for a fire-and-forget endpoint. A few-second
// in-process cache of the derived id→suggestion maps collapses a telemetry burst to one derivation per
// window, and a cheap 32-hex shape pre-check rejects malformed ids before any DB work. The stored
// event fields (kind/side/market/address/proposedStake) are all pure functions of the id, so a slightly
// stale map is harmless. /accept deliberately does NOT use this — it re-reads the live market + band.
const DERIVE_CACHE_TTL_MS = 5_000;
const S1_CACHE_MAX_USERS = 1_000; // bound the per-user map so a long-lived process can't leak
let s2MapCache: { at: number; map: Map<string, DerivedSuggestion> } | null = null;
let fbMapCache: { at: number; map: Map<string, DerivedSuggestion> } | null = null;
const s1MapCache = new Map<string, { at: number; map: Map<string, DerivedSuggestion> }>();

function toSidMap(items: DerivedSuggestion[]): Map<string, DerivedSuggestion> {
  return new Map(items.map((i) => [i.suggestion.suggestionId, i]));
}

async function cachedS2Map(): Promise<Map<string, DerivedSuggestion>> {
  if (s2MapCache && Date.now() - s2MapCache.at < DERIVE_CACHE_TTL_MS) return s2MapCache.map;
  const map = toSidMap(await deriveS2ForAccept());
  s2MapCache = { at: Date.now(), map };
  return map;
}

async function cachedFallbackMap(): Promise<Map<string, DerivedSuggestion>> {
  if (fbMapCache && Date.now() - fbMapCache.at < DERIVE_CACHE_TTL_MS) return fbMapCache.map;
  const map = toSidMap(await deriveFallbackForAccept());
  fbMapCache = { at: Date.now(), map };
  return map;
}

async function cachedS1Map(userId: string): Promise<Map<string, DerivedSuggestion>> {
  const hit = s1MapCache.get(userId);
  if (hit && Date.now() - hit.at < DERIVE_CACHE_TTL_MS) return hit.map;
  const { items } = await deriveForUser(userId, { cacheOnly: true });
  if (s1MapCache.size >= S1_CACHE_MAX_USERS) {
    // Sweep expired entries (and, if still full, this is a cheap bounded reset) before inserting.
    const cutoff = Date.now() - DERIVE_CACHE_TTL_MS;
    for (const [k, v] of s1MapCache) if (v.at < cutoff) s1MapCache.delete(k);
    if (s1MapCache.size >= S1_CACHE_MAX_USERS) s1MapCache.clear();
  }
  const map = toSidMap(items);
  s1MapCache.set(userId, { at: Date.now(), map });
  return map;
}

// Cached twin of resolveDerivedSuggestion for the telemetry path. Same result (unknown/malformed id →
// null → the route 404s), but backed by the short-TTL maps above and short-circuited on a bad shape.
export async function resolveDerivedSuggestionCached(userId: string, sid: string): Promise<DerivedSuggestion | null> {
  if (!isHexSuggestionId(sid)) return null;
  const s1 = (await cachedS1Map(userId)).get(sid);
  if (s1) return s1;
  const s2 = (await cachedS2Map()).get(sid);
  if (s2) return s2;
  return (await cachedFallbackMap()).get(sid) ?? null;
}
