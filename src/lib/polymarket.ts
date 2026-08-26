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
  isUnnamedMatch,
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
  yesPriceBp: number | null; // Gamma MID — reference only, never a quote and never POLYMARKET display (D10); a bookless source's stored odds ARE authoritative
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
  // The discipline this market is about ("Soccer", "MLB", "CS2"), named at INGEST from Gamma's own
  // tags (which the question text usually lacks) and stored, because serve time has no tags. null =
  // not a sports/esports market, or one we could not name — the deck refuses to serve the latter
  // (deck-mix.isUnnamedMatch).
  league: string | null;
  // When the thing being bet on BEGINS — kick-off for a match, null for crypto/Yes-No. Read from
  // Gamma's `gameStartTime`, NOT `startDate`: startDate is when the market was listed (a week
  // earlier), which is not a fact about the game and was never usable as one.
  startsAt: string | null; // ISO UTC
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
  startDate?: string; // ISO; when the MARKET was listed — not the match (see gameStartTime)
  // Kick-off, as "2026-08-19 16:00:00+00". Measured 2026-08-19 over 172 live sport markets: this is
  // EXACTLY equal to endDate on every one of them — so for a match, the "end date" Gamma advertises
  // is the start of the game, and the market resolves hours later, in-play trading and all.
  gameStartTime?: string;
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
  // Polymarket's own topic labels, e.g. ["Sports","Games","Soccer","King Cup"]. Present ONLY when
  // the request carries include_tag=true (see gammaGet callers) — the sole place a club-vs-club
  // match states its sport.
  tags?: { label?: string }[];
}

// Gamma writes kick-off as "2026-08-19 16:00:00+00" — a space instead of the T, and an offset with
// no minutes. Date.parse takes neither reliably, so normalise before trusting it; anything we cannot
// read comes back null rather than as an Invalid Date that would silently poison a comparison.
function gameStart(raw: string | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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

// Polymarket's football moneyline is ONE-SIDED: "Will CA Platense win on 2026-08-27?" with Yes/No
// outcomes — 100 of 100 sampled live 2026-08-26 — one market per team plus a draw market, all three
// under one event, "CA Platense vs. Instituto AC Cordoba". Yes/No is unusable downstream: the deck
// badges it as a shapeless card, and the S2 hedge needs two NAMED sides (the pickers list them, the
// matcher scores the user's team against them, the AGAINST bet takes one). Both names live in the
// EVENT, so that is where we read them: YES is the team the question asks about, NO is "<opponent> or
// draw" — exactly what the NO side pays on, draws included, which is also the honest hedge for a fan
// ("if they don't win, you're covered"). The draw market names no team, so its question never matches
// here, it keeps Yes/No, and the shape gate in fetchSportsMarkets drops it — nobody supports a draw.
//
// Deliberately NOT guessing: if the question names someone the event doesn't list, the labels stay as
// they were and the market simply never reaches S2. A wrong side name here would be a hedge pointed
// at the wrong team.
const WIN_QUESTION = /^will\s+(.+?)\s+win\b/i;

function teamKey(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
}

export function namedSidesFromEvent(question: string, eventTitle: string | undefined): { yes: string; no: string } | null {
  const q = WIN_QUESTION.exec(question.trim());
  if (!q || !eventTitle) return null;
  const sides = eventTitle.split(/\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean);
  if (sides.length !== 2) return null;
  const subject = teamKey(q[1]);
  const i = sides.findIndex((s) => teamKey(s) === subject);
  if (i === -1) return null;
  // ponytail: "or draw" is redundant in a sport that cannot draw — never false (NO pays on any
  // non-win), just wordy. Name the drawless sports here if a card ever reads badly.
  return { yes: sides[i], no: `${sides[1 - i]}${COMPOSITE_SIDE_SUFFIX}` };
}

// The NO side above names an OUTCOME SET ("Rodez Aveyron Football or draw"), not a team. It is the
// honest label for what that side buys, and the matcher is happy to score a query against it — but a
// team PICKER must not offer it as something to support. Both teams of a match have their own
// "Will X win?" market, so the pure YES labels already cover every supportable entity.
export const COMPOSITE_SIDE_SUFFIX = " or draw";

export function isCompositeSideLabel(label: string): boolean {
  return label.trim().toLowerCase().endsWith(COMPOSITE_SIDE_SUFFIX);
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
  let yesLabel = (outcomes[0] ?? "").trim();
  let noLabel = (outcomes[1] ?? "").trim();
  if (!yesLabel || !noLabel || yesLabel === noLabel) return null;

  // The market's own topic labels (Gamma include_tag=true) — the only place a club-vs-club match
  // states its sport. Read once: the naming below is gated on it, and `league` is derived from it.
  const tags = (m.tags ?? []).map((t) => t.label ?? "").filter(Boolean);
  const cat = categoryOf({ question: m.question ?? "", outcomeYesLabel: yesLabel, outcomeNoLabel: noLabel, tags });

  // Name the sides of a one-sided sports moneyline (see namedSidesFromEvent). Gated on the SPORT
  // classification on purpose: "Will Trump win Ohio?" under an event titled "Trump vs. Harris" is the
  // same shape and must keep its Yes/No — an election has no draw and no fan to hedge.
  if ((cat === "sports" || cat === "esports") && yesLabel.toLowerCase() === "yes" && noLabel.toLowerCase() === "no") {
    const named = namedSidesFromEvent(m.question ?? "", m.events?.[0]?.title);
    if (named) {
      yesLabel = named.yes;
      noLabel = named.no;
    }
  }

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
    // Named HERE, where the tags exist. A cached row keeps the name; nothing downstream can re-derive
    // it, because the question of a club-vs-club match never says which sport it is.
    league: gameOf({ question: m.question, outcomeYesLabel: yesLabel, outcomeNoLabel: noLabel, tags }, cat),
    // Kick-off ONLY. startDate is the listing date — months old on a long-dated market — and it used
    // to land here under the name "startsAt", which reads as a fact about the game and is not one.
    startsAt: gameStart(m.gameStartTime),
    resolutionDeadline: m.endDate,
    status,
    resolvedOutcome,
  };
}

// Gamma 5xx is CONGESTION, not a verdict about the query — bounded retry, same idiom as clob.ts.
//
// Measured live 2026-08-19 against the exact URL the hedge index pages with (tag_id=235, offset=300):
// 30/30 sequential requests returned 200, while a 24-request burst (3 tags x 8 pages at once) drew
// 6 x 500 `{"type":"internal error"}`. So the 500 tracks CONCURRENCY, not offset.
// Which concurrent load trips it in prod is NOT established: within one poller tick the Gamma calls
// are sequential awaits (refreshDeck -> refreshHedgeIndex -> the settle sweep), so the poller does not
// collide with itself. The unverified candidates are the app's own Gamma reads on the same host and
// the second host in the two-host topology. The retry below does not depend on which it is; if these
// errors ever survive it, pinning that down is the next lever (a cross-process rate limit).
//
// Why this is NOT handled by breaking the paging loop: it would silently TRUNCATE the index. A 500 at
// offset=300 came back with 100 real markets on retry, and tag 235's pool is ~767 deep; the same burst
// re-run with this retry returned the identical 2143 markets across all three tags (0 unhealed), where
// "stop at the page that 500s" would have dropped whole tails of the pool with a green subsystem light.
// Missing hedge markets that nothing reports are worse than the loud error they'd replace.
//
// A REAL outage still throws after the attempts are spent, and a 4xx (a genuinely bad query) throws
// immediately — retrying can't heal a contract problem. Both keep subsystemFailed meaningful.
//
// 2026-08-26 — what this retry CANNOT heal, and why the walk below exists. The page that paged the
// on-call (tag_id=39, offset=700) is not congestion: past a certain offset the query itself is too
// slow for Gamma's own budget, so every attempt re-rolls the same loss on the same cold query. See
// gammaWalkByEndDate — the fix is to stop asking for deep offsets, not to ask again harder.
// Three retries, JITTERED. Both numbers are measured, not guessed (2026-08-19, 4 concurrent paging
// walkers): clob.ts's flat [250, 500] left 1 page unhealed per 3 runs, because every walker that
// took a 500 in the same burst also retried in the same millisecond and re-collided. Spreading the
// wait over 0.5–1.5x and adding a third step took that to 0 unhealed.
// The tick's 180 s heartbeat budget is safe: a page that exhausts its retries THROWS, ending the
// pass, so a total Gamma outage costs one page's backoff (~3 s) — never 39 pages' worth.
const GAMMA_MAX_RETRIES = 3;
const GAMMA_BACKOFF_MS = [250, 500, 1000];

// Carries the status so the retry loop can tell congestion from a contract problem without
// re-parsing a message (clob.ts's ClobStatusError, same job).
export class GammaStatusError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Gamma ${status} for ${path}`);
    this.name = "GammaStatusError";
  }
}

// Exported for scripts/test-gamma-retry.ts — the retry is the thing under test, so it needs a seam
// to inject failures through instead of waiting for a live burst to misbehave.
export async function gammaGetOnce(path: string): Promise<GammaMarket[]> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000), // an upstream hang must not stall a poller tick into its 180 s heartbeat kill
  });
  if (!res.ok) throw new GammaStatusError(res.status, path);
  return (await res.json()) as GammaMarket[];
}

export async function gammaGetWithRetry(
  path: string,
  once: (p: string) => Promise<GammaMarket[]> = gammaGetOnce,
): Promise<GammaMarket[]> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= GAMMA_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = GAMMA_BACKOFF_MS[attempt - 1] * (0.5 + Math.random()); // de-sync colliding walkers
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      return await once(path);
    } catch (e) {
      // A non-429 4xx is a contract problem, not congestion — retrying can't heal it.
      if (e instanceof GammaStatusError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e as Error; // 429 / 5xx / timeout / transport -> bounded backoff, then give up
    }
  }
  throw new Error(`${lastErr?.message} (after ${GAMMA_MAX_RETRIES + 1} attempts)`);
}

async function gammaGet(path: string): Promise<GammaMarket[]> {
  return gammaGetWithRetry(path);
}

const GAMMA_PAGE = 100; // Gamma caps `limit` at 100/request regardless of what we ask.
const MAX_PAGES = 15; // backstop: never page forever (15 * 100 = 1500 markets scanned).

// ─── Walking a whole pool without deep offsets ───────────────────────────────────────────────────
// Gamma answers the FIRST few pages of /markets cheaply and the deep ones at the edge of its own
// timeout. Measured live 2026-08-26 against tag 39 (ethereum, 748 open markets), cold cache keys,
// sequential, 5 runs per offset:
//   offset   0 / 100 / 200 -> 0.19–0.46 s, 0 of 15 failed
//   offset 300 ... 700     -> 1.1–1.8 s,   6 of 25 failed, each killed at a hard ~2.15 s ceiling
//                             with HTTP 500 {"type":"internal error"}
// That cliff is the incident: the hedge index walked tag 39 to offset=700, the retry re-ran the SAME
// cold deep query four times (so four re-rolls of one ~25% loss, not four chances at a blip), and the
// throw took down the whole refresh — the remaining tags, the S2 sports pass and the s2Eligible
// demotion never ran, three ticks in a row.
//
// So: don't use offsets at all. Results are endDate-ascending and end_date_min is INCLUSIVE
// (verified live: end_date_min=2026-08-28T16:00:00Z returns all 23 markets whose endDate IS that
// instant), so each request takes ONE page at offset=0 and the next one re-anchors at the last row's
// endDate, deduping the re-read boundary rows by conditionId. The far tail then costs what the near
// head costs: cursor=2026-12-31T17:00:00Z at offset=0 returned in 0.30 s the rows the offset walk
// could only reach at offset=700 — a whole tag now walks in ~2.5 s instead of ~15 s.
//
// Dropping the offsets also fixes a SILENT LOSS that predates the 500s. Gamma's `order=endDate` has
// no tiebreaker, so tied rows come back in an arbitrary order that differs between requests, and any
// page boundary landing inside a tie group can skip rows. Measured live 2026-08-26 on tag 818, both
// methods run twice (each self-consistent: 0 drift): the offset walk and an early 3-page-window
// version of this walk returned DIFFERENT market sets — 2-3 rows each way, all inside one 22-market
// tie group at 2026-08-29T16:00:00Z. Re-anchoring at every page removes every boundary a tie can
// straddle, so nothing is lost while a tie group fits in one page.
//
// The one thing a time cursor cannot step over is a pile-up: MORE markets sharing one endDate than a
// page holds. It happens — the sports fetch has >300 markets ending at the same top of the hour. So
// a cursor that cannot advance pages DEEPER instead of giving up: deep offsets are a cost (and, in a
// pile-up, the tie-skip risk is Gamma's to own), truncation is a lie. Nothing else reaches for them.
//
// And a pile-up can outgrow the API itself. Gamma refuses offset > 2000 outright — verified live
// 2026-08-26: offset=2000 -> 200, offset=2001 -> 422. Saturday football clears that bar on its own:
// 2026-08-29T14:00:00Z holds >=2000 open markets under tag Sports, >=2000 under tag Soccer ALONE
// (kickoff is the endDate, and every match carries a dozen prop markets). No filter this endpoint
// offers can split one instant further, so those markets are simply unreachable — we step over the
// instant and SAY SO, rather than 422 the walk or spin on an offset Gamma will never serve.
//
// This also retires a silent truncation that was weeks away: the old maxPages=8 capped a tag at 800
// markets and tag 39 was already at 748 — the tail past the cap would have dropped out of the index
// with every light still green. Exhausting the request bound here is at least SAID out loud.
const WALK_REQUESTS = 20; // ~2000 markets/walk at 100 a page, minus the re-read boundary rows
const GAMMA_MAX_OFFSET = 2000; // past this Gamma answers 422, not a page (measured — see above)

export async function gammaWalkByEndDate(
  params: Record<string, string | string[]>, // an array repeats the key — Gamma ORs repeated params
  endDateMin: string,
  opts: { maxRequests?: number; get?: (p: string) => Promise<GammaMarket[]> } = {},
): Promise<GammaMarket[]> {
  const maxRequests = opts.maxRequests ?? WALK_REQUESTS;
  const get = opts.get ?? gammaGet;
  const seen = new Set<string>();
  const out: GammaMarket[] = [];
  let cursor = endDateMin;
  let offset = 0;
  let requests = 0;

  while (requests < maxRequests) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) for (const one of Array.isArray(v) ? v : [v]) qs.append(k, one);
    qs.set("end_date_min", cursor);
    qs.set("order", "endDate");
    qs.set("ascending", "true");
    qs.set("limit", String(GAMMA_PAGE));
    qs.set("offset", String(offset));
    const raw = await get(`/markets?${qs.toString()}`);
    requests++;
    let lastEnd: string | null = null;
    for (const r of raw) {
      if (r.endDate) lastEnd = r.endDate; // ascending, so the last one wins
      if (r.conditionId) {
        if (seen.has(r.conditionId)) continue; // the boundary instant is re-read by design
        seen.add(r.conditionId);
      }
      out.push(r);
    }
    if (raw.length < GAMMA_PAGE) return out; // short page = the pool ends here

    if (lastEnd !== null && lastEnd > cursor) {
      cursor = lastEnd; // re-anchor: the next page starts at this instant, ties and all
      offset = 0;
    } else if (offset + GAMMA_PAGE <= GAMMA_MAX_OFFSET) {
      offset += GAMMA_PAGE; // a pile-up on ONE instant — the only case that needs an offset
    } else {
      // The pile-up is bigger than Gamma will paginate. The rest of this instant cannot be read by
      // anyone; step past it (1 s is finer than any endDate Gamma publishes) so the walk continues.
      const next = Date.parse(cursor);
      if (!Number.isFinite(next)) return out;
      console.warn(`[gamma] ${cursor} holds more markets than Gamma will page (offset ceiling ${GAMMA_MAX_OFFSET}) — the rest of that instant is unreachable`);
      cursor = new Date(next + 1000).toISOString();
      offset = 0;
    }
  }
  console.warn(`[gamma] walk hit its ${maxRequests}-request bound at end_date_min=${cursor} (${out.length} markets) — pool truncated`);
  return out;
}

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
// and as a bookless source's stored odds (authoritative there).
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
        include_tag: "true", // the sport/game name lives ONLY here — see MarketCache.league
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
          !isUnnamedMatch(m) // a match card must say WHICH sport / which game — no generic "SPORTS"
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

// Fetch all OPEN, future-resolving markets under one Gamma tag id. `maxRequests` bounds the walk
// (default ~2000 markets/tag; the deepest major is at 764). Returns only markets mapMarket accepts.
export async function fetchMajorsMarkets(
  tagId: number,
  opts: { maxRequests?: number } = {},
): Promise<MajorsMarketRaw[]> {
  const out: MajorsMarketRaw[] = [];
  const raw = await gammaWalkByEndDate(
    { tag_id: String(tagId), active: "true", closed: "false" },
    new Date().toISOString(),
    { maxRequests: opts.maxRequests },
  );

  for (const r of raw) {
    const cache = mapMarket(r);
    // OPEN only, like fetchBlitzDeck and fetchSportsMarkets: Gamma's active/closed flags lag its
    // own resolution state, and a row read as RESOLVED here carries NO outcome — persisted, it
    // fails the poller's pending scan (status OPEN) AND planRedeem's outcome guard, so every bet
    // on it would sit PENDING forever with the stake held.
    if (!cache || cache.status !== "OPEN") continue;
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

// ─── What S2 asks Gamma for ──────────────────────────────────────────────────────────────────────
// Discovery used to scan the ENTIRE market universe for 10 days and keep the ~2% that are named
// matches. Measured 2026-08-26: that pool is 18k+ markets and does not end — the walk ran out of its
// budget ~2 hours into a 240-hour window, so the index only ever held tonight's fixtures, silently.
// Two Gamma filters fix that at the source, before a byte is downloaded:
//
//  - tag_id, one walk per sport. There is NO exclusion filter — `exclude_tag_id` is ignored and a
//    comma list is a 422 (both measured) — so "everything except X" is impossible and "only these"
//    is the only way to not fetch a sport at all. NFL and MLB are therefore simply absent from this
//    list: dead weight for this audience, and now never requested.
//  - sports_market_types, repeated (Gamma ORs repeated params; a comma list returns nothing). Every
//    match carries a dozen prop markets — corners, exact score, odd/even kills — and they were 76%
//    of what S2 indexed (measured on 443 live candidates: spreads 171, lol_odd_even_total_kills 44,
//    soccer_first_corner 18 …). A prop is also the WRONG instrument: "my team loses" pays on the
//    match result, not on the corner count or the handicap margin.
//
// Result, measured over the FULL 10 days: every walk FINISHES instead of truncating, ~11 s for the
// lot, and the index holds 3142 match markets (2188 of them football) where the universe scan
// reached 98. Coverage went from ~2 hours of fixtures to the whole horizon.
// What that costs downstream, so it is not a surprise: the sports pass now upserts ~2800 rows a run
// (was ~90), and every S2 read path — pickers, search, accept re-derivation — walks that same index.
//
// Football leads the list because it is what this audience actually watches. Its moneylines are
// Yes/No and only become two-sided because mapMarket names them off the event (see
// namedSidesFromEvent) — before that it reached the index only through corner props.
const S2_SPORT_TAGS: { tagId: number; name: string }[] = [
  { tagId: 100350, name: "Soccer" },
  { tagId: 64, name: "Esports" }, // umbrella: CS2, LoL, Dota 2, Valorant …
  { tagId: 28, name: "Basketball" },
  { tagId: 864, name: "Tennis" },
  { tagId: 517, name: "Cricket" },
  { tagId: 279, name: "UFC" },
  { tagId: 683, name: "Boxing" },
  { tagId: 100088, name: "Hockey" },
];
const S2_MARKET_TYPES = ["moneyline", "child_moneyline"]; // the match result, and the per-map one

// Fetch OPEN, future-resolving NAMED sports/esports markets within `hours` (default 10 days — the
// pickers want UPCOMING matches, a longer leash than the blitz deck). `maxRequests` bounds EACH
// tag's walk (the deepest, esports, took 7).
export async function fetchSportsMarkets(opts: { hours?: number; maxRequests?: number } = {}): Promise<SportsMarketRaw[]> {
  const hours = opts.hours ?? 240; // 10 days
  const now = new Date();
  const max = new Date(now.getTime() + hours * 3_600_000);
  const out: SportsMarketRaw[] = [];
  const raw: GammaMarket[] = [];
  const seen = new Set<string>(); // a market can carry two of our tags — index it once

  for (const tag of S2_SPORT_TAGS) {
    const rows = await gammaWalkByEndDate(
      {
        tag_id: String(tag.tagId),
        active: "true",
        closed: "false",
        enableOrderBook: "true",
        include_tag: "true", // same reason as the deck fetch — the league name comes from the tags
        end_date_max: max.toISOString(),
        sports_market_types: S2_MARKET_TYPES,
      },
      now.toISOString(),
      { maxRequests: opts.maxRequests ?? 60 },
    );
    for (const r of rows) {
      if (r.conditionId && seen.has(r.conditionId)) continue;
      if (r.conditionId) seen.add(r.conditionId);
      raw.push(r);
    }
  }

  for (const r of raw) {
    const cache = mapMarket(r);
    if (!cache || cache.status !== "OPEN" || cache.yesPriceBp === null || cache.noPriceBp === null) continue;
    if (shapeOf(cache) !== "named") continue; // entity-vs-entity only (the AGAINST-side needs two teams)
    // Classify against the market's TAGS, not the cache row. A club-vs-club market names no sport in
    // its own text — "Will Pau FC win on 2026-08-28?" against "Rodez Aveyron Football" — so a tagless
    // read calls it "other" and drops it. Measured while wiring football in: 10 matches survived the
    // tagless classifier out of ~2000, and the 10 were the ones whose club name happens to contain
    // the word "Football". The tag list is where Polymarket states the discipline.
    const tagged = {
      question: cache.question,
      outcomeYesLabel: cache.outcomeYesLabel,
      outcomeNoLabel: cache.outcomeNoLabel,
      tags: (r.tags ?? []).map((t) => t.label ?? "").filter(Boolean),
    };
    const cat = categoryOf(tagged);
    if (cat !== "sports" && cat !== "esports") continue;
    if (isContextPoor(cache) || isUnnamedMatch({ ...tagged, league: cache.league })) continue; // jargon totals / unnamed disciplines
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
      // The row's OWN name first: mapMarket read it off the market's tags, which is the only place a
      // club-vs-club match states its sport. gameOf on the cache alone sees no tags, so re-deriving
      // here is a downgrade — it is the fallback for rows cached before tagging, nothing more.
      league: cache.league ?? gameOf(tagged, cat),
    });
  }
  return out;
}
