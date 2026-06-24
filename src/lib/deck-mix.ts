// Deck mixing: classify a market into a prediction CATEGORY, then shuffle a candidate pool
// randomly with one hard rule — never more than MAX_RUN cards of the same category in a row.
// Gamma rarely sets `category`, so we derive it from the question + side labels (verified
// live 2026-06-24: crypto Up/Down, esports "Team vs Team", sports, Over/Under totals).

export const MAX_RUN = 2; // no more than 2 consecutive cards from one category

export type Category = "crypto" | "esports" | "sports" | "overunder" | "other";

// Keyword signals. Esports titles name the game; sports name leagues/competitions. Cheap and
// good enough for mixing — misclassification only weakens variety slightly, never breaks it.
const ESPORTS = /\b(dota|counter-?strike|cs2|cs:go|csgo|valorant|league of legends|lol\b|overwatch|honor of kings|mobile legends|rainbow six|rocket league|starcraft|king of glory|pubg)\b/i;
const SPORTS = /\b(nba|nfl|mlb|nhl|soccer|football|tennis|atp|wta|ufc|boxing|cricket|f1|formula|premier league|la liga|serie a|bundesliga|world cup|open|vs\.?|match|game \d)\b/i;

export function categoryOf(m: {
  question: string;
  category?: string | null;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
}): Category {
  const y = m.outcomeYesLabel.toLowerCase();
  // Crypto Up/Down minute markets — the dominant, repetitive shape we most want to break up.
  if ((y === "up" || (y === "yes" && /\b(bitcoin|ethereum|solana|btc|eth|sol|xrp|bnb|dogecoin|crypto|hyperliquid)\b/i.test(m.question)))) {
    return "crypto";
  }
  if (y === "over" || y === "under") return "overunder";
  const q = m.question;
  if (ESPORTS.test(q)) return "esports";
  if (SPORTS.test(q)) return "sports";
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
