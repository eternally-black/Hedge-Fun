// Deck mixing: classify a market into a prediction CATEGORY, then shuffle a candidate pool
// randomly with one hard rule — never more than MAX_RUN cards of the same category in a row.
// Gamma rarely sets `category`, so we derive it from the question + side labels (verified
// live 2026-06-24: crypto Up/Down, esports "Team vs Team", sports, Over/Under totals).

export const MAX_RUN = 2; // no more than 2 consecutive cards from one category

export type Category = "crypto" | "esports" | "sports" | "overunder" | "politics" | "weather" | "other";

// Keyword signals (verified against live Gamma markets 2026-06-24). We match against the
// question AND the outcome labels, because named-binary markets carry the real category in the
// side names (e.g. "Boston Red Sox" / "Colorado Rockies") while the question is just a market
// type ("Spread: Boston Red Sox (-1.5)").
// "map ..." is an esports-only bet term (CS2/Dota/Valorant series play over maps; no traditional
// sport uses it). Catch the series-level lines too — "Map Handicap", "Map Advantage", "Total Maps" —
// not just numbered "Map 1", so a CS2 match with unknown teams still classifies esports and gets
// hidden by isUnnamedMatch instead of leaking to the deck as a bare "SPORTS" card.
const ESPORTS = /\b(dota|counter[- ]?strike|cs2|cs:go|csgo|valorant|league of legends|lol|overwatch|honor of kings|mobile legends|rainbow six|rocket league|starcraft|king of glory|pubg|esports|map \d|map handicap|map advantage|map spread|total maps|bo[135]\b)\b/i;
// Crypto: ticker/coin names, ETF flow markets, and the Up/Down shape.
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|bnb|dogecoin|doge|hyperliquid|cardano|ada|crypto|etf flows?|gas\b|gwei)\b/i;
// Sports: leagues + the "type" words that head named-binary sports markets (spread, handicap,
// innings, sets, totals, moneyline, who wins). The label-vs-label "Team A / Team B" shape lands
// here via these heads even when the question names no league.
// "exact score" earns its place: "Exact Score: A 3 - 0 B?" names no league and has no "vs", so it
// used to fall through to "other" — a match market on a 48h horizon wearing a generic badge.
const SPORTS = /\b(nba|nfl|mlb|nhl|soccer|football|baseball|basketball|hockey|tennis|atp|wta|ufc|mma|boxing|cricket|f1|formula|golf|nascar|premier league|la liga|serie a|bundesliga|ligue 1|champions league|world cup|grand prix|spread|handicap|innings?|moneyline|to win|exact score|set \d|game \d|\bvs\.?\b|\bv\.\b| at )\b/i;
// Politics / macro.
const POLITICS = /\b(election|president|senate|congress|fed\b|fomc|rate (cut|hike)|nominee|impeach|prime minister|parliament|referendum|vote|poll)\b/i;
// Weather.
const WEATHER = /\b(temperature|°f|°c|degrees|rain|snow|hurricane|storm|weather|high of|inches of)\b/i;

// The text every rule below reads: question + both side labels (a named binary carries the signal in
// its labels, not its question).
//
// Quoted spans are dropped first. Polymarket runs a whole genre of "mention" markets — `Will X say
// "World Cup" during the earnings call?` — where the quote is the phrase somebody utters, not the
// subject of the bet. Left in, it is indistinguishable from a topic signal: that example classifies
// sports and earns a football pitch. Same trap for `"Bitcoin"` in a quote landing on crypto.
// Measured 2026-08-03: ZERO markets inside either live window (deck 72h, hedge index 240h) contain a
// quoted span at all, so this changes nothing today. It is the guard, not the fix — those markets
// exist further out and drift into range on their own.
// `tags` are Polymarket's OWN topic labels for the market (Gamma `include_tag=true`), and they are
// the only place the discipline is stated for a club-vs-club match: "PFK Mash'al Mubarek vs. FC
// Andijon: O/U 1.5" carries no sport word anywhere in its text, while its tags read
// ["Sports","Games","Soccer","King Cup"]. Ingest passes them; anything reading a cached row does not
// have them (we store the NAME instead — MarketCache.league).
export type Classifiable = {
  question: string;
  category?: string | null;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
  tags?: string[];
};

function signalText(m: Classifiable): string {
  const q = m.question.replace(/["“][^"”]*["”]/g, " ");
  return `${q} ${m.outcomeYesLabel} ${m.outcomeNoLabel} ${(m.tags ?? []).join(" ")}`;
}

export function categoryOf(m: Classifiable): Category {
  const y = m.outcomeYesLabel.toLowerCase();
  const n = m.outcomeNoLabel.toLowerCase();
  const text = signalText(m);

  // 1) Up/Down is an unambiguous crypto shape — keep it first.
  if (y === "up" && n === "down") return "crypto"; // Up/Down markets are ~always crypto minutes

  // 2) THEME beats bet-TYPE. An Over/Under market is still about a CS2 map or an NBA game — the
  //    subject matters more to the user than the wager shape. So check content signals first; a
  //    market only lands in "overunder" if it's a bare total with no recognizable subject.
  //    (e.g. "Map 1 Total Rounds: O/U 21.5" -> esports; "Norway vs France: Norway O/U 0.5" -> sports.)
  if (ESPORTS.test(text)) return "esports";
  if (CRYPTO.test(text)) return "crypto";
  if (POLITICS.test(text)) return "politics";
  if (WEATHER.test(text)) return "weather";
  if (SPORTS.test(text)) return "sports";

  // 3) Bare Over/Under total with no subject signal.
  if (y === "over" || y === "under" || n === "over" || n === "under") return "overunder";
  return "other";
}

// ---- Per-category resolution horizon -------------------------------------------------------
// The fix for "a wall of crypto vs. enough variety": crypto Up/Down resolve by the minute and are
// plentiful, so they stay strictly blitz (<=24h) — that keeps the deck FRESH without reordering.
// Sports/esports resolve at match end (often 1-3 days out) and are SPARSE, so they get a longer
// leash (<=72h) — that's what keeps the deck DIVERSE instead of crypto-only. Bare Over/Under totals
// track crypto's tightness; weather/politics/other sit in between. Tune the policy here.
export const DECK_HORIZON_HOURS: Record<Category, number> = {
  crypto: 24,
  overunder: 24,
  weather: 48,
  politics: 48,
  other: 48,
  sports: 72,
  esports: 72,
};

// Outer scan/serve bound = the widest per-category horizon. fetchBlitzDeck pulls THIS window from
// Gamma and the deck route reads it from cache; both then narrow each market to ITS category's
// horizon via withinCategoryHorizon, so a 50h crypto market is dropped while a 50h match is kept.
export const DECK_FETCH_HORIZON_HOURS = Math.max(...Object.values(DECK_HORIZON_HOURS));

// True when a market resolves within ITS category's horizon (not a flat window). `nowMs` is passed
// so a whole deck is filtered against one clock. Pass a precomputed `cat` to skip a categoryOf pass.
export function withinCategoryHorizon(
  m: { question: string; category?: string | null; outcomeYesLabel: string; outcomeNoLabel: string },
  deadlineMs: number,
  nowMs: number,
  cat: Category = categoryOf(m),
): boolean {
  return deadlineMs <= nowMs + DECK_HORIZON_HOURS[cat] * 3_600_000;
}

// Specific league/discipline label for a sports/esports market, derived from the same text signal
// (question + side labels). Returns the display name (e.g. "NBA", "UFC", "Dota 2", "CS2") or null
// when nothing specific is recognized — callers then fall back to the generic "Sports"/"Esports".
// Ordered: first regex that hits wins. Covers the main live leagues/games (per product decision).
const SPORT_GAMES: [RegExp, string][] = [
  [/\b(nba|basketball)\b/i, "NBA"],
  [/\b(nfl|american football)\b/i, "NFL"],
  [/\b(mlb|baseball|innings?)\b/i, "MLB"],
  [/\b(nhl|hockey)\b/i, "NHL"],
  [/\b(ufc|mma|octagon)\b/i, "UFC"],
  [/\bboxing\b/i, "Boxing"],
  [/\b(f1|formula\s*1|grand prix|nascar)\b/i, "F1"],
  [/\b(tennis|atp|wta|grand slam|wimbledon|us open|roland garros|australian open)\b/i, "Tennis"],
  // T20/ODI/wickets are here so cricket is claimed BEFORE the soccer row can grab it on the word
  // "premier league": "Kuwait Kerala Premier League T20" is cricket, and used to badge as Soccer.
  [/\b(cricket|t20|odi|test match|wickets?|ipl)\b/i, "Cricket"],
  [/\b(golf|pga|masters)\b/i, "Golf"],
  // Soccer last among sports — its league names are many; the generic word catches the rest.
  //
  // Real Polymarket soccer names NO league: the question is "FSK Bukovyna Chernivtsi vs. FK LNZ
  // Cherkasy: O/U 9.5 Total Corners" and the league lives only in the slug (ukr1-…), which the
  // Market cache does not carry. Measured live 2026-08-03: the league words alone matched 0 of 600
  // soccer markets resolving inside the deck's 72h window, so soccer cards were badging as a
  // generic "Sports" and never got the pitch art (see ui.isFootball -> skins.tsx).
  //
  // So we also match the bet VOCABULARY, which is soccer-exclusive (corners, both teams to score,
  // clean sheet, own goal, draws — no other sport here has a draw), plus the match-shape words.
  // Being the LAST row is what makes that safe: anything reaching here already failed NBA / NFL /
  // MLB / NHL / UFC / Boxing / F1 / Tennis / Cricket / Golf.
  //
  // A bare "A vs. B: O/U 2.5" is deliberately NOT claimed. It was, briefly, at a "plausible goal
  // line" (<=4.5) — which bought ~40 points of recall and quietly badged tennis, esports and any
  // other discipline missing from this table: "Alcaraz vs. Sinner: O/U 3.5" got a football pitch.
  // A bare total names no sport, and no line bound can invent one; the earlier NBA/NFL/MLB/NHL
  // measurement simply didn't cover the disciplines that aren't in this table at all. Missing a
  // badge is invisible; a pitch on a tennis card is a visible lie. So: only vocabulary that is
  // soccer-exclusive counts.
  // ponytail: costs recall (~90% -> ~50% of soccer named). The honest way to win it back is a
  // league signal in the data — Gamma's slug carries it (ukr1-…) but Market doesn't store it.
  [/\b(soccer|football|premier league|la liga|serie a|bundesliga|ligue 1|champions league|world cup|epl|ucl|corners?|both teams to score|btts|clean sheet|own goal|end in a draw|exact score)\b/i, "Soccer"],
];
const ESPORT_GAMES: [RegExp, string][] = [
  [/\b(dota\s*2?|dota)\b/i, "Dota 2"],
  [/\b(counter[- ]?strike|cs2|cs:go|csgo)\b/i, "CS2"], // Gamma's tag is "counter strike 2" — spaced
  [/\bvalorant\b/i, "Valorant"],
  [/\b(league of legends|\blol\b)\b/i, "LoL"],
  [/\boverwatch\b/i, "Overwatch"],
  [/\brocket league\b/i, "Rocket League"],
  [/\b(rainbow six|r6)\b/i, "Rainbow Six"],
  [/\bpubg\b/i, "PUBG"],
  [/\bmobile legends\b/i, "Mobile Legends"],
  [/\b(honor of kings|king of glory)\b/i, "Honor of Kings"],
  [/\bstarcraft\b/i, "StarCraft"],
];

// `cat` lets callers that already classified the market pass it in to skip a redundant
// categoryOf() pass (catOf/catOfResult do exactly that). Omit it and we classify here.
export function gameOf(m: Classifiable, cat: Category = categoryOf(m)): string | null {
  if (cat !== "sports" && cat !== "esports") return null;
  const text = signalText(m); // same quoted-span rule as categoryOf — see signalText
  const table = cat === "esports" ? ESPORT_GAMES : SPORT_GAMES;
  for (const [re, name] of table) if (re.test(text)) return name;
  return null;
}

// A "match" signal in the question: two participants (Team vs Team, A @ B) or a named subject. An
// Over/Under question carries this when it names who's playing; "Games Total: O/U 4.5" and
// "Map 1 Total Rounds: O/U 21.5" do NOT — they're bare totals the user can't make sense of.
const MATCH = /\bvs\.?\b|\bv\.\b|\s@\s|\s+at\s+|\bversus\b/i;

// Context-poor: an Over/Under total with no recognizable match/subject in the question. These cards
// are jargon ("over/under WHAT?") — we keep them out of the deck. NON-Over/Under markets are never
// poor (a team name or Yes/No is self-explanatory). The check reads the question + labels only, so
// it's the same signal the deck card shows.
export function isContextPoor(m: {
  question: string;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
}): boolean {
  const y = m.outcomeYesLabel.toLowerCase();
  const n = m.outcomeNoLabel.toLowerCase();
  const isOverUnder = y === "over" || y === "under" || n === "over" || n === "under";
  if (!isOverUnder) return false; // teams / Yes/No / Up-Down are self-explanatory
  // O/U is fine IF the question names the match (participants). No match signal -> poor.
  return !MATCH.test(m.question);
}

// A match card MUST name its discipline — which sport, or which game for esports. Product rule, no
// exceptions: a bare "SPORTS" badge over "PFK Mash'al Mubarek vs. FC Andijon" tells the user nothing
// they can act on. So anything classified sports/esports that we cannot name is not served at all.
//
// This is affordable now only because the name comes from Polymarket's own tags at ingest
// (MarketCache.league): measured live 2026-08-19 over the 72h window, 1098 of 1098 sports/esports
// markets were named. `league` is that stored name; rows cached before tagging (null) fall back to
// the question-only classifier and drop if that can't name them either — they come back named on the
// next refresh-deck.
export function isUnnamedMatch(m: Classifiable & { league?: string | null }): boolean {
  const cat = categoryOf(m);
  if (cat !== "sports" && cat !== "esports") return false;
  return !(m.league ?? gameOf(m, cat));
}

// Mutable xorshift PRNG seeded from a number — deterministic given a seed (testable), random
// in practice because callers seed from the clock. No Math.random (banned in some contexts).
function rng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

// Shuffle `items` and emit up to `limit`, never placing >MAX_RUN of the same category in a
// row. Greedy: shuffle the pool, then repeatedly take the first item whose category wouldn't
// make a run of >MAX_RUN; if every remaining item would (only one category left), accept it
// (can't do better). Returns the mixed list.
export function shuffleNoRun<T>(
  items: T[],
  category: (x: T) => string,
  limit: number,
  seed = 1,
): T[] {
  // Fisher–Yates with the seeded rng.
  const pool = items.slice();
  const rand = rng(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const out: T[] = [];
  let lastCat: string | null = null;
  let run = 0;
  while (out.length < limit && pool.length > 0) {
    // Prefer the first shuffled item that doesn't extend a run past MAX_RUN.
    let idx = pool.findIndex((x) => !(category(x) === lastCat && run >= MAX_RUN));
    if (idx === -1) idx = 0; // only the run-category is left — unavoidable, take it
    const [picked] = pool.splice(idx, 1);
    const cat = category(picked);
    run = cat === lastCat ? run + 1 : 1;
    lastCat = cat;
    out.push(picked);
  }
  return out;
}
