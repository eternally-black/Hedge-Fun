// TxOdds TxLINE read-integration (football / World Cup). Runtime is PURE REST — no Solana, no
// wallets, no signatures. The one-time on-chain subscribe()+activate that mints the apiToken is a
// separate bootstrap (scripts/txline-bootstrap kept out of the app); here we only consume the token.
//
// Verified live on devnet 2026-06-29 (scripts in the recon sandbox, see memory hedgefun-txline-integration):
//  - Auth = 2 headers: Authorization: Bearer <guest jwt> + X-Api-Token: <apiToken>.
//    guest jwt is free/unauthenticated (POST {origin}/auth/guest/start, 30d) and refreshable on 401;
//    a FRESH jwt works with the existing apiToken (the token is the subscription credential, not the session).
//  - Data endpoints live under {origin}/api/... ; World Cup CompetitionId = 72.
//  - O/U total goals market = SuperOddsType "OVERUNDER_PARTICIPANT_GOALS", MarketPeriod null (full match),
//    MarketParameters "line=2.5", PriceNames ["over","under"]; Pct = demarginalized % (3dp, "NA" on quarter lines).
//  - Scores come as an event log; current goals = Stats["1"] + Stats["2"] (key = period*1000+base; 1=P1 goals, 2=P2 goals).
//  - /scores/snapshot/{id} & /odds/snapshot/{id} are JSON; /updates & /stream are SSE.

import type { TickerRow } from "./api-types";

const ORIGIN = process.env.TXODDS_API_BASE ?? "https://txline-dev.txodds.com";
const API_TOKEN = process.env.TXODDS_API_TOKEN ?? "";
export const WC_COMPETITION_ID = Number(process.env.TXODDS_WC_COMPETITION_ID ?? "72");

// TxLINE on-chain program (per network) — used only to build the "⛓ Solana-anchored" Solscan link
// on settled football results. TxLINE publishes daily Merkle roots of all scores to this program, so
// the score a bet settled on is anchored on Solana. (Full client-side Merkle proof verification is a
// documented follow-up; this links the anchor, it does not claim the proof was recomputed.)
const IS_DEVNET = ORIGIN.includes("-dev.");
const TXLINE_PROGRAM_ID = IS_DEVNET
  ? "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
  : "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA";
export function onchainAnchorRef(): string {
  const cluster = IS_DEVNET ? "devnet" : "mainnet-beta";
  return `https://solscan.io/account/${TXLINE_PROGRAM_ID}?cluster=${cluster}`;
}

// ─── raw TxLine shapes (only the fields we read) ───────────────────────────────────────────────
export interface TxFixture {
  FixtureId: number;
  StartTime: number; // unix ms
  Competition: string;
  CompetitionId: number;
  Participant1: string; // home
  Participant2: string; // away
}
interface TxOddsPayload {
  FixtureId: number;
  SuperOddsType: string;
  MarketPeriod: string | null;
  MarketParameters: string | null;
  InRunning: boolean;
  PriceNames: string[];
  Prices: number[];
  Pct: string[];
}
interface TxScoreRecord {
  FixtureId: number;
  GameState: string;
  Ts: number;
  Stats: Record<string, number>;
}

// ─── guest JWT (module-cached, refresh on 401) ─────────────────────────────────────────────────
let jwtCache: { token: string; at: number } | null = null;
const JWT_TTL_MS = 25 * 24 * 3_600_000; // 25d (token lasts 30d) — refresh well before expiry

async function getGuestJwt(force = false): Promise<string> {
  if (!force && jwtCache && Date.now() - jwtCache.at < JWT_TTL_MS) return jwtCache.token;
  const res = await fetch(`${ORIGIN}/auth/guest/start`, { method: "POST", cache: "no-store" });
  if (!res.ok) throw new Error(`TxLine guest/start ${res.status}`);
  const token = ((await res.json()) as { token: string }).token;
  jwtCache = { token, at: Date.now() };
  return token;
}

// GET {origin}/api{path} with both headers; one transparent JWT refresh + retry on 401.
async function txGet<T>(path: string): Promise<T> {
  if (!API_TOKEN) throw new Error("TXODDS_API_TOKEN not set — run the TxLine bootstrap (memory hedgefun-txline-integration)");
  for (let attempt = 0; attempt < 2; attempt++) {
    const jwt = await getGuestJwt(attempt === 1);
    const res = await fetch(`${ORIGIN}/api${path}`, {
      cache: "no-store",
      headers: { accept: "application/json", Authorization: `Bearer ${jwt}`, "X-Api-Token": API_TOKEN },
    });
    if (res.status === 401 && attempt === 0) continue; // stale jwt → refresh + retry once
    if (!res.ok) throw new Error(`TxLine ${res.status} for ${path}`);
    return (await res.json()) as T;
  }
  throw new Error(`TxLine 401 for ${path} (after refresh)`);
}

export async function fetchFixtures(): Promise<TxFixture[]> {
  return txGet<TxFixture[]>(`/fixtures/snapshot`);
}
export async function fetchOdds(fixtureId: number): Promise<TxOddsPayload[]> {
  return txGet<TxOddsPayload[]>(`/odds/snapshot/${fixtureId}`);
}
export async function fetchScores(fixtureId: number): Promise<TxScoreRecord[]> {
  return txGet<TxScoreRecord[]>(`/scores/snapshot/${fixtureId}`);
}

// Full-match Over/Under TOTAL GOALS lines we bet on (1.5/2.5/3.5 — the .5 lines with clean
// demarginalized %). Returns YES(over)/NO(under) prices in basis points. Used by market generation.
export const OU_LINES = ["1.5", "2.5", "3.5"] as const;
export const OU_KIND: Record<string, string> = { "1.5": "OU15", "2.5": "OU25", "3.5": "OU35" };
export const WIN_KIND: Record<"home" | "away", string> = { home: "WINH", away: "WINA" };
export interface OuMarket {
  line: string; // "1.5" | "2.5" | "3.5"
  overBp: number; // YES side (Over) price in bp
  underBp: number; // NO side (Under) price in bp
}
// Pure: extract O/U markets from an already-fetched odds snapshot (so callers fetch odds once).
export function parseOuMarkets(odds: TxOddsPayload[]): OuMarket[] {
  const out: OuMarket[] = [];
  for (const line of OU_LINES) {
    const o = odds.find(
      (x) =>
        x.SuperOddsType === "OVERUNDER_PARTICIPANT_GOALS" &&
        (x.MarketPeriod == null || x.MarketPeriod === "") &&
        x.MarketParameters === `line=${line}`,
    );
    if (!o) continue;
    const ov = o.Pct?.[0];
    const un = o.Pct?.[1];
    if (!ov || ov === "NA" || !un || un === "NA") continue;
    const overBp = Math.round(parseFloat(ov) * 100);
    const underBp = Math.round(parseFloat(un) * 100);
    if (Number.isFinite(overBp) && Number.isFinite(underBp)) out.push({ line, overBp, underBp });
  }
  return out;
}
export async function fetchOuMarkets(fixtureId: number): Promise<OuMarket[]> {
  return parseOuMarkets(await fetchOdds(fixtureId));
}

// Binary "{team} to win?" markets, derived from the full-match 1X2 demarginalized %: home YES =
// P(part1), away YES = P(part2); NO = the rest (draw or the other team). Skipped if 1X2 isn't
// offered or the % is NA. PriceNames are part1/draw/part2 — matched by name, positional [0]/[2] fallback.
export interface WinMarket {
  team: "home" | "away";
  winBp: number; // YES side ("team wins") price in bp; NO side = 10000 − winBp
}
export function parseWinMarkets(odds: TxOddsPayload[]): WinMarket[] {
  const o = odds.find(
    (x) => x.SuperOddsType === "1X2_PARTICIPANT_RESULT" && (x.MarketPeriod == null || x.MarketPeriod === ""),
  );
  if (!o) return [];
  const names = o.PriceNames ?? [];
  const idx = (want: RegExp, fallback: number) => {
    const i = names.findIndex((n) => want.test(n));
    return i >= 0 ? i : fallback;
  };
  const out: WinMarket[] = [];
  const push = (team: "home" | "away", raw: string | undefined) => {
    if (!raw || raw === "NA") return;
    const bp = Math.round(parseFloat(raw) * 100);
    if (Number.isFinite(bp) && bp > 0 && bp < 10000) out.push({ team, winBp: bp });
  };
  push("home", o.Pct?.[idx(/1$|home|part1/i, 0)]);
  push("away", o.Pct?.[idx(/2$|away|part2/i, 2)]);
  return out;
}

// Current/final score for settlement. total goals = Stats["1"] + Stats["2"] (P1+P2 full-game goals).
// `ended` from the GameState phase; home/away null until the feed carries stats (pre-match).
export interface MatchScore {
  gameState: string;
  ended: boolean;
  abandoned: boolean; // postponed/abandoned/suspended — never settle on a partial score
  home: number | null;
  away: number | null;
}
export async function fetchMatchScore(fixtureId: number): Promise<MatchScore> {
  const scores = await fetchScores(fixtureId);
  const { home, away } = currentScore(scores);
  const gs = latestGameState(scores);
  const ph = phaseOf(gs);
  return { gameState: gs, ended: ph.ended, abandoned: ph.abandoned, home, away };
}

// ─── mapping helpers ───────────────────────────────────────────────────────────────────────────

// Current goals from the scores event-log: the most recent record carrying stats holds the running
// totals. key "1" = P1 total goals, "2" = P2 total goals (period 0 = full game).
function currentScore(scores: TxScoreRecord[]): { home: number | null; away: number | null } {
  const withStats = scores.filter((s) => s.Stats && (s.Stats["1"] != null || s.Stats["2"] != null));
  if (withStats.length === 0) return { home: null, away: null };
  const latest = withStats.reduce((a, b) => (b.Ts > a.Ts ? b : a));
  return { home: latest.Stats["1"] ?? 0, away: latest.Stats["2"] ?? 0 };
}

function latestGameState(scores: TxScoreRecord[]): string {
  if (scores.length === 0) return "";
  return scores.reduce((a, b) => (b.Ts > a.Ts ? b : a)).GameState ?? "";
}

// Map a raw GameState string to {live, ended, label}. Exact strings are tuned as live matches are
// observed; this covers the documented phases (NS/H1/HT/H2/F/ET…) and common word forms defensively.
function phaseOf(gs: string): { live: boolean; ended: boolean; abandoned: boolean; label: string } {
  const g = (gs || "").toLowerCase();
  if (/sched|^ns$|not.?start|pre/.test(g)) return { live: false, ended: false, abandoned: false, label: "" };
  // Abandoned / postponed / suspended / interrupted / cancelled — these must NEVER settle on a
  // partial score, so they're their own state (NOT ended). Checked BEFORE "ended" so e.g. the
  // substring in "suspended" can't match /ended/.
  if (/aban|cancel|postpon|interrupt|suspend/.test(g)) return { live: false, ended: false, abandoned: true, label: "—" };
  if (/^f$|^ft$|finish|full.?time|ended|fet|fpe/.test(g)) return { live: false, ended: true, abandoned: false, label: "FT" };
  if (/half.?time|^ht$/.test(g)) return { live: true, ended: false, abandoned: false, label: "HT" };
  if (/^h1$|first.?half|1st/.test(g)) return { live: true, ended: false, abandoned: false, label: "1H" };
  if (/^h2$|second.?half|2nd/.test(g)) return { live: true, ended: false, abandoned: false, label: "2H" };
  if (/et|extra/.test(g)) return { live: true, ended: false, abandoned: false, label: "ET" };
  if (/pen/.test(g)) return { live: true, ended: false, abandoned: false, label: "PENS" };
  // unknown but non-scheduled, non-ended → treat as live, show the raw token uppercased
  return { live: true, ended: false, abandoned: false, label: (gs || "").slice(0, 4).toUpperCase() };
}

// Demarginalized Over 2.5 goals probability (%), full-match line. null if not offered / quarter line.
function over25Pct(odds: TxOddsPayload[]): number | null {
  const ou = odds.find(
    (o) =>
      o.SuperOddsType === "OVERUNDER_PARTICIPANT_GOALS" &&
      (o.MarketPeriod == null || o.MarketPeriod === "") &&
      o.MarketParameters === "line=2.5",
  );
  if (!ou) return null;
  const p = ou.Pct?.[0]; // index 0 = "over"
  if (!p || p === "NA") return null;
  const n = parseFloat(p);
  return Number.isFinite(n) ? n : null;
}

// ─── ticker snapshot (module-cached) ───────────────────────────────────────────────────────────
// Read-only display data → a short shared TTL cache keeps TxLine off the per-request path and bounds
// load to ~1 build / TTL regardless of traffic. (The deck/settlement path will use the DB cache + poller.)
// ponytail: in-memory cache, no table; add the FootballFixture table when the deck needs persistence.
// TickerRow shape lives in api-types.ts (the shared web/RN contract).

const SNAP_TTL_MS = 8_000;
const MAX_FIXTURES = 24; // cap per-build odds/scores fan-out
let snapCache: { at: number; rows: TickerRow[] } = { at: 0, rows: [] };
let inFlight: Promise<TickerRow[]> | null = null;

async function buildSnapshot(): Promise<TickerRow[]> {
  const fixtures = (await fetchFixtures())
    .filter((f) => f.CompetitionId === WC_COMPETITION_ID)
    .sort((a, b) => a.StartTime - b.StartTime)
    .slice(0, MAX_FIXTURES);

  const rows = await Promise.all(
    fixtures.map(async (f): Promise<TickerRow> => {
      const [scores, odds] = await Promise.all([
        fetchScores(f.FixtureId).catch(() => [] as TxScoreRecord[]),
        fetchOdds(f.FixtureId).catch(() => [] as TxOddsPayload[]),
      ]);
      const { home, away } = currentScore(scores);
      const ph = phaseOf(latestGameState(scores));
      // Derive live/ended from score + kickoff, not GameState alone: the feed can report
      // "scheduled" while a match is clearly in play (kickoff passed, score present). But it can ALSO
      // stay "scheduled" AFTER a match ends (the end is never reported), so a score alone can't mean
      // "live" — otherwise a finished match shows "Live" forever. Gate on a generous in-play window
      // (90' + HT + ET + stoppage ≈ 3h): within it ⇒ live; a scored fixture PAST it with a stuck
      // GameState ⇒ treat as ended (show FT), not perpetually live.
      const started = Date.now() >= f.StartTime;
      const sinceKick = Date.now() - f.StartTime;
      const inPlayWindow = started && sinceKick < 3 * 3_600_000;
      const ended = ph.ended || (home != null && started && !inPlayWindow);
      const live = !ended && !ph.abandoned && (ph.live || inPlayWindow);
      // 1X2 win probabilities from the same already-fetched odds (no extra call). winBp → % to match
      // over25Pct's scale so the ticker can cite both markets in one event line.
      const wins = parseWinMarkets(odds);
      const winPct = (team: "home" | "away") => {
        const w = wins.find((x) => x.team === team);
        return w ? w.winBp / 100 : null;
      };
      return {
        fixtureId: String(f.FixtureId),
        competition: f.Competition,
        home: f.Participant1,
        away: f.Participant2,
        homeGoals: home,
        awayGoals: away,
        live,
        ended,
        phase: ended ? "FT" : ph.abandoned ? "ABD" : live ? ph.label || "LIVE" : "",
        kickoff: new Date(f.StartTime).toISOString(),
        over25Pct: over25Pct(odds),
        homeWinPct: winPct("home"),
        awayWinPct: winPct("away"),
      };
    }),
  );

  // Order: live first, then upcoming (nearest kickoff), then recently ended.
  const rank = (r: TickerRow) => (r.live ? 0 : r.ended ? 2 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.kickoff.localeCompare(b.kickoff));
}

export async function getTickerSnapshot(): Promise<TickerRow[]> {
  if (Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.rows;
  if (inFlight) return inFlight; // coalesce concurrent misses into one upstream build
  inFlight = buildSnapshot()
    .then((rows) => {
      snapCache = { at: Date.now(), rows };
      return rows;
    })
    .finally(() => {
      inFlight = null;
    });
  // On a build error, serve the last good rows rather than throwing the ticker offline.
  try {
    return await inFlight;
  } catch {
    return snapCache.rows;
  }
}
