// Deterministic strike-market parser (D1: no LLM). Extracts { asset, strike, direction, date } from
// a Polymarket majors market's slug/question by regex — the machine-parseable subset that qualifies
// for S1 matching. Verified live 2026-07-17 against Gamma tag feeds (bitcoin/ethereum/solana):
//   above:  "bitcoin-above-62600-on-july-17-2026-2pm-et"  "Bitcoin above 62,600 on July 17, 2PM ET?"
//   reach:  "will-solana-reach-100-on-july-17"            (UP — YES wins on a rise)
//   hit:    "will-bitcoin-hit-150k-by-december-31-2026"   (UP, k = ×1000)
//   dip:    "will-bitcoin-dip-to-57k-on-july-17"          (DOWN — YES wins on a fall)
//   below:  "<asset>-below-<strike>-on-<date>"            (DOWN)
// PURE / DB-free — unit-tested in scripts/test-hedge-cores.ts. Up/Down daily markets have NO strike
// (they resolve vs the day's open), so they parse as asset-only (parseOk=false) and are SKIPPED — the
// coverage log counts them so we can measure. Strikes are integer CENTS (money rule): $150k → 15_000_000.

export type HedgeAsset = "BTC" | "ETH" | "SOL";
export type ParsedDirection = "UP" | "DOWN"; // which side (YES / index 0) benefits from an UP move

export interface ParsedMarket {
  asset: HedgeAsset | null;
  strikeCents: number | null;
  direction: ParsedDirection | null;
  hasDate: boolean;
  parseOk: boolean; // asset + strike + direction + date all present -> S1-eligible
}

// Normalize slug OR question to one hyphen-delimited lowercase form so the same regexes hit both:
//   "Bitcoin above 62,600 on July 17, 2PM ET?" -> "bitcoin-above-62600-on-july-17-2pm-et-"
function norm(s: string): string {
  return s.toLowerCase().replace(/,/g, "").replace(/[^a-z0-9.]+/g, "-");
}

// First asset keyword wins (hyphen boundaries so "btc-updown"/"sol-updown" match, "eth" inside a
// word does not). Ethereum before Bitcoin/Solana is arbitrary — a slug names exactly one major.
const ASSET_PATTERNS: [RegExp, HedgeAsset][] = [
  [/(?:^|-)(bitcoin|btc)(?:-|$)/, "BTC"],
  [/(?:^|-)(ethereum|eth)(?:-|$)/, "ETH"],
  [/(?:^|-)(solana|sol)(?:-|$)/, "SOL"],
];

// A direction keyword immediately followed (optionally via "-to") by the strike number, optional
// "k" (×1000). UP = the YES side wins on a rise; DOWN = the YES side wins on a fall.
const UP_STRIKE = /(?:above|over|exceeds?|reach(?:es)?|hits?|greater-than|at-least)(?:-to)?-(\d+(?:\.\d+)?)(k)?(?:-|$)/;
const DOWN_STRIKE = /(?:below|under|beneath|dips?|drops?|falls?|less-than)(?:-to)?-(\d+(?:\.\d+)?)(k)?(?:-|$)/;

// A month name anywhere = a machine-readable date is present (the exact resolution INSTANT comes
// from Gamma's endDate downstream; this gate just enforces the spec's "strike + date" requirement).
const DATE_RE = /(?:^|-)(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:-|$)/;

function assetOf(text: string): HedgeAsset | null {
  for (const [re, a] of ASSET_PATTERNS) if (re.test(text)) return a;
  return null;
}

// strike (dollars) -> integer cents, applying the optional "k" (×1000) multiplier.
function strikeToCents(num: string, kSuffix: string | undefined): number {
  const dollars = parseFloat(num) * (kSuffix ? 1000 : 1);
  return Math.round(dollars * 100);
}

function directionStrike(text: string): { direction: ParsedDirection; strikeCents: number } | null {
  const up = UP_STRIKE.exec(text);
  if (up) return { direction: "UP", strikeCents: strikeToCents(up[1], up[2]) };
  const down = DOWN_STRIKE.exec(text);
  if (down) return { direction: "DOWN", strikeCents: strikeToCents(down[1], down[2]) };
  return null;
}

// Parse a majors market. `slug` is preferred (no commas, canonical); `question` is the fallback.
export function parseStrikeMarket(input: { slug?: string | null; question?: string | null }): ParsedMarket {
  const slug = input.slug ? norm(input.slug) : "";
  const q = input.question ? norm(input.question) : "";

  const asset = assetOf(slug) ?? assetOf(q);
  const ds = directionStrike(slug) ?? directionStrike(q);
  const hasDate = DATE_RE.test(slug) || DATE_RE.test(q);

  const direction = ds?.direction ?? null;
  const strikeCents = ds?.strikeCents ?? null;
  const parseOk = asset !== null && strikeCents !== null && direction !== null && hasDate;

  return { asset, strikeCents, direction, hasDate, parseOk };
}
