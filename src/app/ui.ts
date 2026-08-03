// Shared UI helpers + types for the Hedge Fun screens (ported from app design).
"use client";

import { categoryOf, gameOf, type Category } from "@/lib/deck-mix";
import { STAKE_CENTS } from "@/lib/config";
import type { DeckCard, MeResponse } from "@/lib/api-types";

// The screens consume the API contract directly (src/lib/api-types.ts) — single source of truth,
// shared verbatim with the Android client. These aliases keep the existing screen imports working.
export type Card = DeckCard;
export type Me = MeResponse;

export type Screen = "deck" | "feed" | "gm" | "vault" | "invite" | "you" | "notifications" | "hedge";

// Price as Polymarket shows it: cents per share. bp/100 = cents (5150bp -> 51.5¢). Whole cents
// when integer, one decimal otherwise. Sides need NOT sum to 100¢ (spread is real) — no rounding.
export const cents = (bp: number) => {
  const c = bp / 100;
  return `${Number.isInteger(c) ? c : c.toFixed(1)}¢`;
};

export const num = (n: number) => n.toLocaleString("en-US");
export const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

// Virtual-$ payout (whole dollars) if this side wins: stake of `stakeCents` at price p (bp/10000)
// buys stake/p of $1 shares. Mirrors settle.ts share math (payout = stake*10000/priceBp). bp is the
// bought side's price; stakeCents defaults to the live STAKE_CENTS so callers pass just the price.
export const winPayout = (bp: number, stakeCents: number = STAKE_CENTS) => {
  const p = Math.max(0.02, bp / 10000);
  return Math.round(stakeCents / 100 / p);
};

// Category accent + display label. Single source of truth = deck-mix categoryOf, so the badge a
// card shows ALWAYS matches the category it was mixed by (no more display/mix disagreement).
const CAT_COLORS: Record<Category, { color: string; label: string; icon: string }> = {
  crypto: { color: "#ff8a3d", label: "Crypto", icon: "₿" },
  sports: { color: "#3d7bff", label: "Sports", icon: "🏆" },
  esports: { color: "#b14dff", label: "Esports", icon: "🎮" },
  overunder: { color: "#19c8ff", label: "Over / Under", icon: "📊" },
  politics: { color: "#94a3b8", label: "Politics", icon: "🏛" },
  weather: { color: "#38bdf8", label: "Weather", icon: "🌧" },
  other: { color: "#94a3b8", label: "Market", icon: "◎" },
};

// Display accent + label for a card, derived via the SAME classifier the deck mixer uses. For
// sports/esports we name the specific league/game (NBA, UFC, Dota 2, CS2…) when recognized,
// keeping the category's color + icon; otherwise the generic category label.
export function catOf(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): { color: string; label: string; icon: string } {
  const m = { question: card.question, outcomeYesLabel: card.outcomeYesLabel, outcomeNoLabel: card.outcomeNoLabel };
  const cat = categoryOf(m);
  const game = gameOf(m, cat); // reuse the category — no second classify pass
  return game ? { ...CAT_COLORS[cat], label: game } : CAT_COLORS[cat];
}

// Soccer cards get the auto pitch+grass under the free Classic skin (category art, not a sellable
// skin). Reuse the deck classifier's league naming: gameOf returns "Soccer" only for soccer — NFL /
// "american football" match earlier in its table, so the word "football" never misfires here.
export function isFootball(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): boolean {
  return gameOf({ question: card.question, outcomeYesLabel: card.outcomeYesLabel, outcomeNoLabel: card.outcomeNoLabel }) === "Soccer";
}

// Polymarket hands us raw "Over"/"Under" side labels with the threshold buried in the question
// ("Map 1 Total Rounds: Over/Under 21.5", "Norway vs France: Norway O/U 0.5"). On their own,
// "Over"/"Under" are jargon — a user can't tell over WHAT. We pull the line out of the question and
// fold it into the label ("Over 21.5" / "Under 21.5"), and surface a plain-language hint line.
const ouLabels = (s: string) => s.toLowerCase() === "over" || s.toLowerCase() === "under";

// The threshold number in an Over/Under question, or null. Matches "O/U 21.5" and "Over/Under 21.5".
function ouLine(question: string): string | null {
  const m = question.match(/(?:o\/u|over\/under|over or under)\s*([\d.]+)/i);
  return m ? m[1]! : null;
}

// Display labels for a card's two sides. For Over/Under markets, append the line ("Over 21.5"); for
// everything else, the raw label is already a real name (team/player/Yes), so pass it through.
export function sideLabels(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): { yes: string; no: string } {
  if (ouLabels(card.outcomeYesLabel) && ouLabels(card.outcomeNoLabel)) {
    const line = ouLine(card.question);
    if (line) {
      const over = `Over ${line}`, under = `Under ${line}`;
      // outcomes[0] (YES) is whichever of Over/Under Polymarket listed first — keep that mapping.
      return card.outcomeYesLabel.toLowerCase() === "over"
        ? { yes: over, no: under }
        : { yes: under, no: over };
    }
  }
  return { yes: card.outcomeYesLabel, no: card.outcomeNoLabel };
}

// ─── soccer: turn the betting-slip jargon into a sentence ──────────────────────────────────────
// Polymarket generates soccer questions from slugs, so the jargon is a FIXED, small grammar rather
// than free text — which is exactly why it can be converted instead of merely tolerated. Measured
// live 2026-08-03 over 420 deck-eligible soccer markets: 68 distinct question shapes, but 72% of
// them are one orthogonal Over/Under grammar and the rest is a short list of Yes/No families.
//
// The bar is NOT "shorter" or "more idiomatic" — it is READABLE BY SOMEONE WHO DOES NOT FOLLOW
// FOOTBALL. A first draft rendered "Second half draw?" as "Will the second half end level?", which
// only trades one dialect of jargon for another: "level" is a British commentary idiom. Banned for
// the same reason: "outscore", "clean sheet", "handicap", bare "corners" (say corner kicks), and
// "this team" where the question names the team. scripts/test-side-labels.ts asserts against them.

// Proof that a market is football, not merely shaped like one. Only soccer-EXCLUSIVE vocabulary
// counts: a bare "A vs. B: O/U 2.5" names no sport at all, and reading it as goals put "4 or more
// goals" on a tennis card and a football pitch on chess. Missing a hint is invisible; a confident
// wrong one is not.
const SOCCER_PROOF = /\b(soccer|football|premier league|la liga|serie a|bundesliga|ligue 1|champions league|world cup|epl|ucl|corners?|both teams to score|btts|clean sheet|own goal)\b/i;

interface SoccerOu {
  scope: "" | "first half" | "second half";
  subject: string | null; // one of the two teams, or null for a match total
  metric: "goals" | "corner kicks";
  line: number;
}

// "{A} vs. {B}: [<team> ][<1st|2nd> Half ]O/U <n>[ [Total ]Corners]". Returns null rather than
// guessing: an unrecognised subject or an unknown suffix means we say nothing at all.
function parseSoccerOu(question: string): SoccerOu | null {
  const m = question.match(/^(.+?)\s+vs\.?\s+(.+?):\s*(.*?)\bO\/U\s*([\d.]+)(.*)$/i);
  if (!m) return null;
  const [, home, away, prefix, num, suffix] = m;
  const line = parseFloat(num!);
  if (!Number.isFinite(line)) return null;
  const tail = (suffix ?? "").trim();
  const metric = /corners?/i.test(tail) ? "corner kicks" : "goals";
  if (tail && metric === "goals") return null; // suffix we don't understand -> don't invent a hint
  // "A vs. B: O/U n" names no sport, so a bare total is only read as GOALS at a plausible goal line
  // — the same bound, and the same reason, as the Soccer row in deck-mix's SPORT_GAMES. Without it
  // "Panthers vs. Cardinals: O/U 32.5" reads out as "33 or more goals". Soccer totals run 0.5-5.5
  // (88% at or under 2.5); NFL sits at 32.5+, MLB at 7.5+, and NHL owns the 5.5/6.5 band. The 4%
  // of soccer above the bound just fall back to the generic line — quiet beats confidently wrong.
  // ponytail: calibration knob, not a truth. Re-measure if a league moves its totals.
  // Corners are proof in themselves. Goals are not: only claim them when the question says
  // somewhere that this is football, otherwise stay quiet and let the generic line handle it.
  if (metric === "goals" && (!SOCCER_PROOF.test(question) || line > 4.5)) return null;
  let rest = (prefix ?? "").trim();
  let scope: SoccerOu["scope"] = "";
  const half = rest.match(/\b(1st|2nd|First|Second)\s+Half\b/i);
  if (half) {
    scope = /1st|first/i.test(half[1]!) ? "first half" : "second half";
    rest = rest.replace(half[0]!, "").trim();
  }
  let subject: string | null = null;
  if (rest) {
    if (rest === home!.trim()) subject = home!.trim();
    else if (rest === away!.trim()) subject = away!.trim();
    else return null;
  }
  return { scope, subject, metric, line };
}

// A .5 line is really "n+1 or more" — that is how a person says it. ONLY a .5 line: a whole line can
// push, and a quarter line (2.25) half-pushes at exactly 2, so "3 or more" would be a lie about the
// payout. Both fall back to "more than n". The feed only produces .5 today; this is the guard for
// the day it doesn't.
const atLeast = (n: number) => (n % 1 === 0.5 ? Math.ceil(n) : null);

function soccerOuHint(o: SoccerOu): string {
  const where = o.scope ? ` in the ${o.scope}` : " in the match";
  const k = atLeast(o.line);
  const amount = k !== null ? `${k} or more` : `more than ${o.line}`;
  if (!o.subject) return `Will there be ${amount} ${o.metric}${where}?`;
  return o.metric === "goals"
    ? `Will ${o.subject} score ${amount} goals${where}?`
    : `Will ${o.subject} take ${amount} corner kicks${where}?`;
}

// The Yes/No families, in mass order. "Second half draw?" is the one worth reading twice: it scores
// the second half as its OWN match, so 2-1 at the break finishing 3-2 makes the second half a 1-1
// draw. The hint has to say that, not restate the term.
const SOCCER_HINTS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/Both Teams to Score in First Half$/i, () => "Will both teams score in the first half?"],
  [/Both Teams to Score in Second Half$/i, () => "Will both teams score in the second half?"],
  [/Both Teams to Score$/i, () => "Will both teams score at least one goal?"],
  [/Second half draw\?$/i, () => "Will both teams score the same number of goals in the second half?"],
  [/Draw at halftime\?$/i, () => "Will the score be equal at half-time?"],
  [/^Will\s+.+?\s+vs\.?\s+.+?\s+end in a draw\?$/i, () => "Will the match finish with neither team winning?"],
  [/Total Corners Odd or Even\?$/i, () => "Will the total number of corner kicks be an odd or an even number?"],
  [/Team to Take First Corner$/i, () => "Which team takes the first corner kick of the match?"],
  [/Neither team to score first\?$/i, () => "Will the match end with neither team scoring?"],
  // Below here the SHAPE is not soccer-exclusive — NFL and NBA generate the same slugs — so the
  // wording carries no units. "win by 2 or more goals" on a baseball spread was a real bug.
  [/^(.+?)\s+to score first vs\.?\s+.+?\?$/i, (m) => `Will ${m[1]} score first?`],
  [/^(.+?)\s+leading at halftime\?$/i, (m) => `Will ${m[1]} be ahead at half-time?`],
  [/^(.+?)\s+to win the second half\?$/i, (m) => `Will ${m[1]} score more than their opponent in the second half?`],
  [/^Exact Score:\s*(.+?)\s+(\d+)\s*-\s*(\d+)\s+.+?\?$/i, (m) => `Will the match finish exactly ${m[2]}-${m[3]} to ${m[1]}?`],
  [/^Exact Score:\s*Any Other Score\?$/i, () => "Will the final score be none of the ones listed?"],
  // A handicap, spelled out. The user never sees the word.
  [/^Spread:\s*(.+?)\s*\(-([\d.]+)\)$/i, (m) => {
    const k = atLeast(parseFloat(m[2]!));
    return k !== null ? `Will ${m[1]} win by ${k} or more?` : `Will ${m[1]} win by more than ${m[2]}?`;
  }],
];

// Plain-language reading of a soccer question, or null if it isn't one we recognise.
export function soccerHint(question: string): string | null {
  const ou = parseSoccerOu(question);
  if (ou) return soccerOuHint(ou);
  for (const [re, say] of SOCCER_HINTS) {
    const m = question.match(re);
    if (m) return say(m);
  }
  return null;
}

// One-line plain-language explainer shown under the question. Soccer gets a real sentence (above);
// other Over/Under markets get the generic line — it can only name the threshold, because nothing
// in the question says over/under WHAT. Everything else is self-explanatory (a team name, Yes/No).
export function marketHint(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): string | null {
  // Soccer first: its O/U cards also carry Over/Under labels and would otherwise get the vague line.
  const soccer = soccerHint(card.question);
  if (soccer) return soccer;
  if (ouLabels(card.outcomeYesLabel) && ouLabels(card.outcomeNoLabel)) {
    const line = ouLine(card.question);
    return line ? `Will the total be over or under ${line}?` : "Will the total go over or under the line?";
  }
  return null;
}

// Visual for a result/inbox row. The reveal & inbox don't carry side labels, so classify by the
// question alone (deck-mix's categoryOf reads labels too, but question-only still hits the common
// signals). Falls back to the raw `category` string from the API only for the display label.
export function catOfResult(r: { question: string; category: string | null }): { color: string; label: string; icon: string } {
  const m = { question: r.question, outcomeYesLabel: "", outcomeNoLabel: "" };
  const cat = categoryOf(m);
  const game = gameOf(m, cat); // reuse the category — no second classify pass
  return game ? { ...CAT_COLORS[cat], label: game } : CAT_COLORS[cat];
}

// Settled-result presentation: accent color, badge glyph, tag word. WIN=lime, LOSS=red, PUSH=blue.
export function resultMeta(status: "WIN" | "LOSS" | "PUSH"): { accent: string; glyph: string; tag: string } {
  if (status === "WIN") return { accent: "var(--yes)", glyph: "✓", tag: "Won" };
  if (status === "LOSS") return { accent: "var(--no)", glyph: "✕", tag: "Lost" };
  return { accent: "var(--skip)", glyph: "↩", tag: "Void" };
}

// Signed dollar delta from cents, with a real minus glyph. Push shows "Refund".
export function deltaStr(status: "WIN" | "LOSS" | "PUSH", cents: number): string {
  if (status === "PUSH") return "Refund";
  const d = Math.round(cents / 100);
  return d >= 0 ? `+$${d.toLocaleString("en-US")}` : `−$${Math.abs(d).toLocaleString("en-US")}`;
}

export function bgGrad(color: string) {
  return `radial-gradient(120% 80% at 80% 0%, ${color}2e, transparent 55%), linear-gradient(170deg, var(--panel2), var(--panel))`;
}

// Countdown to resolution. `text` = the precise ⏱ cutoff timer ("4h 11m" or "11m 05s"). `relText` =
// a friendly, rounded "Resolves in ~N min" line for the quick crypto Up/Down cards (live —
// recomputed each tick, correct for any window, not just 15 min). Both derive from the same clock.
export function countdown(iso: string, nowMs: number): { text: string; urgent: boolean; relText: string } {
  const total = Math.max(0, Math.round((new Date(iso).getTime() - nowMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const text = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
  const mins = Math.round(total / 60);
  const relText =
    total < 60 ? "Resolves in <1 min"
      : mins < 60 ? `Resolves in ~${mins} min`
        : `Resolves in ~${Math.round(mins / 60)}h`;
  return { text, urgent: total < 3600, relText };
}

// Crypto Up/Down = the quick minute/15-min markets whose question carries an ABSOLUTE resolution
// time ("Bitcoin Up or Down - 9:05AM"). Detected by the Up/Down side labels.
export function isUpDown(card: Pick<Card, "outcomeYesLabel" | "outcomeNoLabel">): boolean {
  return card.outcomeYesLabel.toLowerCase() === "up" && card.outcomeNoLabel.toLowerCase() === "down";
}

// Display question: for Up/Down markets, strip the trailing absolute-time/zone suffix (a dash-led
// segment like "- 9:05AM" / "- July 1, 3PM ET", or a bare trailing "9:05AM") so the card shows the
// market, and the relative "Resolves in ~N min" line + ⏱ cutoff carry the time. Others pass through.
export function displayQuestion(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): string {
  if (!isUpDown(card)) return card.question;
  return card.question
    .replace(/\s*[-–—]\s*[^-–—]*\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|am|pm|et|edt|est|utc|gmt)\b[^-–—]*$/i, "")
    .replace(/\s*\b\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s+(?:et|edt|est|utc|gmt))?\s*$/i, "")
    .trim();
}
