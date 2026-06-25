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
const ESPORTS = /\b(dota|counter-?strike|cs2|cs:go|csgo|valorant|league of legends|lol|overwatch|honor of kings|mobile legends|rainbow six|rocket league|starcraft|king of glory|pubg|esports|map \d|bo[135]\b)\b/i;
// Crypto: ticker/coin names, ETF flow markets, and the Up/Down shape.
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|bnb|dogecoin|doge|hyperliquid|cardano|ada|crypto|etf flows?|gas\b|gwei)\b/i;
// Sports: leagues + the "type" words that head named-binary sports markets (spread, handicap,
// innings, sets, totals, moneyline, who wins). The label-vs-label "Team A / Team B" shape lands
// here via these heads even when the question names no league.
const SPORTS = /\b(nba|nfl|mlb|nhl|soccer|football|baseball|basketball|hockey|tennis|atp|wta|ufc|mma|boxing|cricket|f1|formula|golf|nascar|premier league|la liga|serie a|bundesliga|ligue 1|champions league|world cup|grand prix|spread|handicap|innings?|moneyline|to win|set \d|game \d|\bvs\.?\b|\bv\.\b| at )\b/i;
// Politics / macro.
const POLITICS = /\b(election|president|senate|congress|fed\b|fomc|rate (cut|hike)|nominee|impeach|prime minister|parliament|referendum|vote|poll)\b/i;
// Weather.
const WEATHER = /\b(temperature|°f|°c|degrees|rain|snow|hurricane|storm|weather|high of|inches of)\b/i;

export function categoryOf(m: {
  question: string;
  category?: string | null;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
}): Category {
  const y = m.outcomeYesLabel.toLowerCase();
  const n = m.outcomeNoLabel.toLowerCase();
  // The full text signal: question + both side labels (named-binary carries the signal in labels).
  const text = `${m.question} ${m.outcomeYesLabel} ${m.outcomeNoLabel}`;

  // 1) Up/Down + Over/Under are unambiguous label shapes — check first.
  if (y === "up" && n === "down") return "crypto"; // Up/Down markets are ~always crypto minutes
  if (y === "over" || y === "under" || n === "over" || n === "under") return "overunder";

  // 2) Content signals (question + labels). Order: esports/crypto/politics/weather before the
  //    broad sports net (which includes generic "vs"/"at" that could otherwise grab esports).
  if (ESPORTS.test(text)) return "esports";
  if (CRYPTO.test(text)) return "crypto";
  if (POLITICS.test(text)) return "politics";
  if (WEATHER.test(text)) return "weather";
  if (SPORTS.test(text)) return "sports";
  return "other";
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
