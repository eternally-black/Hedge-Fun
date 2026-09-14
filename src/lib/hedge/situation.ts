// Life-situation parser (B-P2) — PURE, deterministic, regex-only. Turns a free-text life-cost
// description ("$800 on flights this month", "плачу 1200 евро за аренду", "~1000 km/month") into
// { amountCents, currency, period, distanceKm }. No LLM, no network, no env — the NLU edge is a
// separate, optional layer; this is the always-on baseline that runs even when NLU_API_KEY is unset.
//
// WHY regex and not the LLM: the amount/period/distance triple is the sizing input, and sizing is a
// product rule (D1). A hallucinated amount would silently mis-size a hedge, so the deterministic
// path is authoritative and the LLM only ever ADDS entities/keywords on top.
//
// WHY a fixed FX table: sizing is a product rule, so ±10% on a non-USD amount does not change the
// decision. A live rate would add a network dependency to a pure module for no product benefit.

export type SituationPeriod = "month" | "week" | "year" | "once";

export interface ParsedSituation {
  amountCents: number | null;
  currency: string | null;
  period: SituationPeriod | null;
  distanceKm: number | null;
}

// ponytail: fixed FX table; sizing is a product rule so ±10% doesn't matter; swap for a live rate if it ever does
const FX_TO_USD: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27, UAH: 0.024, RUB: 0.011 };

// Currency token -> ISO code. Keys are matched case-insensitively against the captured token.
const CURRENCY_MAP: Record<string, string> = {
  $: "USD", usd: "USD", dollars: "USD", dollar: "USD", bucks: "USD",
  "дол": "USD", "дол.": "USD", "долл": "USD", "долл.": "USD", "долларов": "USD", "доларів": "USD", "баксов": "USD", "баксів": "USD",
  "€": "EUR", eur: "EUR", euros: "EUR", euro: "EUR", "евро": "EUR", "євро": "EUR",
  "£": "GBP", gbp: "GBP", pounds: "GBP", pound: "GBP",
  "₴": "UAH", uah: "UAH", "грн": "UAH", "гривен": "UAH", "гривень": "UAH",
  "₽": "RUB", rub: "RUB", "руб": "RUB", "руб.": "RUB", "рублей": "RUB",
};

// Symbol-first: "$800", "€ 1,200.50", "₴500". ("1,5k$" is number-first and handled below.)
const SYMBOL_FIRST = /(\$|€|£|₴|₽)\s*(\d[\d\s,.']*)(k|к)?/iu;
// Number-first: "800 usd", "1200 евро", "30к рублей", "1,5k$".
const NUMBER_FIRST =
  /(\d[\d\s,.']*)(k|к)?\s*(\$|€|£|₴|₽|usd|eur|gbp|uah|rub|dollars?|bucks|euros?|pounds?|грн|гривен|гривень|долл?\.?|долларов|доларів|баксов|баксів|евро|євро|руб\.?|рублей)(?![\p{L}])/iu;

// Period patterns, tried in order; the FIRST match wins and its captured unit decides the period.
const PERIOD_UNIT: Record<string, SituationPeriod> = {
  month: "month", mo: "month", monthly: "month", "месяц": "month", "мес": "month", "місяць": "month", "ежемесячно": "month", "щомісяця": "month",
  week: "week", wk: "week", weekly: "week", "неделю": "week", "тиждень": "week", "щотижня": "week",
  year: "year", yr: "year", yearly: "year", annually: "year", "год": "year", "рік": "year", "в год": "year", "на рік": "year",
};
const PERIOD_PATTERNS: RegExp[] = [
  /\b(?:per|a|each|every)\s+(month|mo|week|wk|year|yr)\b/iu,
  /\b(monthly|weekly|yearly|annually)\b/iu,
  /\bthis (month|week|year)\b/iu,
  /(?:^|[^\p{L}])(?:в|на|за|каждый|кожен|кожного)\s*(месяц|мес|неделю|год|місяць|тиждень|рік)(?![\p{L}])/iu,
  /(ежемесячно|щомісяця|щотижня|в год|на рік)/iu,
  /\/(month|week|mo)\b/iu,
];

const ONCE_RE = /\b(once|one-time|one time|разово|одноразово)\b/iu;

// Distance: "1000 km", "600 miles", "5 км", "10 километров".
const DISTANCE_RE =
  /(\d[\d\s,.]*)\s*(k)?\s*(km|км|kilomet(?:er|re)s?|километр\w*|кілометр\w*|miles?|mi|миль|міль)(?![\p{L}])/iu;

// Normalize a captured digit string to a float. Handles "1,200.50", "1.200,50", "1,5", "1 200".
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s']/g, "");
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  const lastSep = Math.max(lastComma, lastDot);
  if (lastSep < 0) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const after = cleaned.slice(lastSep + 1);
  const sepCount = (cleaned.match(/[,.]/g) ?? []).length;
  // Single separator followed by exactly 3 digits -> thousands separator ("1,200" -> 1200).
  if (sepCount === 1 && after.length === 3) {
    const n = Number(cleaned.replace(/[,.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  // Otherwise the last separator is a decimal point; strip all other separators.
  const intPart = cleaned.slice(0, lastSep).replace(/[,.]/g, "");
  const n = Number(`${intPart}.${after}`);
  return Number.isFinite(n) ? n : null;
}

function resolveCurrency(token: string): string | null {
  const t = token.toLowerCase();
  return CURRENCY_MAP[t] ?? null;
}

function parseMoney(text: string): { amountCents: number; currency: string } | null {
  // Symbol-first tried first, then number-first.
  const sym = SYMBOL_FIRST.exec(text);
  if (sym) {
    const num = parseNumber(sym[2] ?? "");
    if (num !== null) {
      const mult = sym[3] ? 1000 : 1;
      const currency = resolveCurrency(sym[1] ?? "");
      if (currency) {
        const fx = FX_TO_USD[currency] ?? 1;
        return { amountCents: Math.round(num * mult * fx * 100), currency };
      }
    }
  }
  const numFirst = NUMBER_FIRST.exec(text);
  if (numFirst) {
    const num = parseNumber(numFirst[1] ?? "");
    if (num !== null) {
      const mult = numFirst[2] ? 1000 : 1;
      const currency = resolveCurrency(numFirst[3] ?? "");
      if (currency) {
        const fx = FX_TO_USD[currency] ?? 1;
        return { amountCents: Math.round(num * mult * fx * 100), currency };
      }
    }
  }
  return null;
}

function parsePeriod(text: string): SituationPeriod | null {
  if (ONCE_RE.test(text)) return "once";
  for (const re of PERIOD_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const unit = (m[1] ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const period = PERIOD_UNIT[unit];
    if (period) return period;
  }
  return null;
}

function parseDistance(text: string): number | null {
  const m = DISTANCE_RE.exec(text);
  if (!m) return null;
  const num = parseNumber(m[1] ?? "");
  if (num === null) return null;
  const mult = m[2] ? 1000 : 1;
  const unit = (m[3] ?? "").toLowerCase();
  const isMiles = /^(miles?|mi|миль|міль)$/u.test(unit);
  const km = num * mult * (isMiles ? 1.609 : 1);
  return Math.round(km);
}

export function parseSituation(text: string): ParsedSituation {
  if (!text) return { amountCents: null, currency: null, period: null, distanceKm: null };
  const money = parseMoney(text);
  const period = parsePeriod(text);
  const distanceKm = parseDistance(text);
  return {
    amountCents: money ? money.amountCents : null,
    currency: money ? money.currency : null,
    period,
    distanceKm,
  };
}
