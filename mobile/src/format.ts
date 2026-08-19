// Display helpers — a NATIVE PORT of the pure, deck-mix-free parts of src/app/ui.ts.
// Prices/labels/countdowns are derived from server data only; the economy is never re-derived.
import type { DeckCard, ResultRow } from "../lib/api-types";

// Price as Polymarket shows it: cents per share. bp/100 = cents (5150bp -> 51.5¢). Whole cents
// when integer, one decimal otherwise. Sides need NOT sum to 100¢ (spread is real) — no rounding.
export const cents = (bp: number) => {
  const c = bp / 100;
  return `${Number.isInteger(c) ? c : c.toFixed(1)}¢`;
};

export const num = (n: number) => n.toLocaleString("en-US");
export const usd = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

// Virtual-$ payout (whole dollars) if this side wins: stake at price p buys stake/p of $1 shares.
// Mirrors settle.ts share math (payout = stake*10000/priceBp). stakeCents comes from /api/me
// (me.stakeCents) — the client never hardcodes the stake.
export const winPayout = (bp: number, stakeCents: number) => {
  const p = Math.max(0.02, bp / 10000);
  return Math.round(stakeCents / 100 / p);
};

// Category accent + label. Web classifies locally (it imports deck-mix); this client deliberately
// does not port the classifier and binds to what the server sends instead. Both fields are now
// SERVER-DERIVED: Gamma's own `category` is null on every market, so before that every card here
// rendered the grey "Market" fallback. `league` names the specific competition when known.
const CAT_COLORS: Record<string, { color: string; label: string; icon: string }> = {
  crypto: { color: "#ff8a3d", label: "Crypto", icon: "₿" },
  sports: { color: "#3d7bff", label: "Sports", icon: "🏆" },
  esports: { color: "#b14dff", label: "Esports", icon: "🎮" },
  overunder: { color: "#19c8ff", label: "Over / Under", icon: "📊" },
  politics: { color: "#94a3b8", label: "Politics", icon: "🏛" },
  weather: { color: "#38bdf8", label: "Weather", icon: "🌧" },
  other: { color: "#94a3b8", label: "Market", icon: "◎" },
};

const FALLBACK_CAT = CAT_COLORS.other!;

export function catOf(card: Pick<DeckCard, "category" | "league">): { color: string; label: string; icon: string } {
  const base = (card.category && CAT_COLORS[card.category]) || FALLBACK_CAT;
  // A named league replaces only the LABEL — the colour and icon still say which category it is,
  // exactly as web's catOf does.
  return card.league ? { ...base, label: card.league } : base;
}

// Polymarket hands us raw "Over"/"Under" side labels with the threshold buried in the question.
// Pull the line out and fold it into the label ("Over 21.5" / "Under 21.5"), plus a plain hint.
const ouLabels = (s: string) => s.toLowerCase() === "over" || s.toLowerCase() === "under";

function ouLine(question: string): string | null {
  const m = question.match(/(?:o\/u|over\/under|over or under)\s*([\d.]+)/i);
  return m ? m[1]! : null;
}

// Display labels for a card's two sides. For Over/Under markets, append the line; for everything
// else, the raw label is already a real name (team/player/Yes), so pass it through.
export function sideLabels(card: Pick<DeckCard, "question" | "outcomeYesLabel" | "outcomeNoLabel">): { yes: string; no: string } {
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
// PORT of the same block in src/app/ui.ts — keep the two in sync, or the clients disagree on what a
// card means. Polymarket generates soccer questions from slugs, so the jargon is a FIXED, small
// grammar: 72% of soccer cards are one Over/Under grammar, the rest a short list of Yes/No families.
// The bar is READABLE BY SOMEONE WHO DOES NOT FOLLOW FOOTBALL — no "level", "outscore", "clean
// sheet", "handicap", no bare "corners", and never "this team" where the question names the team.

// Proof that a market is football, not merely shaped like one. Only soccer-EXCLUSIVE vocabulary
// counts: a bare "A vs. B: O/U 2.5" names no sport at all, and reading it as goals put "4 or more
// goals" on a tennis card and a football pitch on chess. Missing a hint is invisible; a confident
// wrong one is not.
const SOCCER_PROOF = /\b(soccer|football|premier league|la liga|serie a|bundesliga|ligue 1|champions league|world cup|epl|ucl|corners?|both teams to score|btts|clean sheet|own goal)\b/i;

interface SoccerOu {
  scope: "" | "first half" | "second half";
  subject: string | null;
  metric: "goals" | "corner kicks";
  line: number;
}

function parseSoccerOu(question: string): SoccerOu | null {
  const m = question.match(/^(.+?)\s+vs\.?\s+(.+?):\s*(.*?)\bO\/U\s*([\d.]+)(.*)$/i);
  if (!m) return null;
  const [, home, away, prefix, num, suffix] = m;
  const line = parseFloat(num!);
  if (!Number.isFinite(line)) return null;
  const tail = (suffix ?? "").trim();
  const metric = /corners?/i.test(tail) ? "corner kicks" : "goals";
  if (tail && metric === "goals") return null; // unknown suffix -> don't invent a hint
  // "A vs. B: O/U n" names no sport, so a bare total is only read as GOALS at a plausible goal line
  // — same bound as deck-mix's Soccer row on web. Without it "Panthers vs. Cardinals: O/U 32.5"
  // reads out as "33 or more goals". Soccer totals run 0.5-5.5; NFL 32.5+, MLB 7.5+, NHL 5.5/6.5.
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

// A .5 line is really "n+1 or more". ONLY .5: a whole line can push and a quarter line (2.25)
// half-pushes at exactly 2, so "3 or more" would misstate the payout. Both fall back to "more than n".
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

// "Second half draw?" scores the second half as its OWN match: 2-1 at the break finishing 3-2 makes
// the second half a 1-1 draw. The hint says that rather than restating the term.
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
  [/^Spread:\s*(.+?)\s*\(-([\d.]+)\)$/i, (m) => {
    const k = atLeast(parseFloat(m[2]!));
    return k !== null ? `Will ${m[1]} win by ${k} or more?` : `Will ${m[1]} win by more than ${m[2]}?`;
  }],
];

export function soccerHint(question: string): string | null {
  const ou = parseSoccerOu(question);
  if (ou) return soccerOuHint(ou);
  for (const [re, say] of SOCCER_HINTS) {
    const m = question.match(re);
    if (m) return say(m);
  }
  return null;
}

// One-line plain-language explainer under the question. Soccer gets a real sentence; other
// Over/Under markets get the generic line (nothing in the question says over/under WHAT).
export function marketHint(card: Pick<DeckCard, "question" | "outcomeYesLabel" | "outcomeNoLabel">): string | null {
  // Soccer first: its O/U cards also carry Over/Under labels and would otherwise get the vague line.
  const soccer = soccerHint(card.question);
  if (soccer) return soccer;
  if (ouLabels(card.outcomeYesLabel) && ouLabels(card.outcomeNoLabel)) {
    const line = ouLine(card.question);
    return line ? `Will the total be over or under ${line}?` : "Will the total go over or under the line?";
  }
  return null;
}

// Crypto Up/Down = the quick minute/15-min markets whose question carries an ABSOLUTE resolution
// time ("Bitcoin Up or Down - 9:05AM"). Detected by the Up/Down side labels.
// A MATCH card's clock counts down to KICK-OFF, not to a payout: Gamma's endDate equals
// gameStartTime on every live sport market (measured 2026-08-19 over 172 of them), and the market
// then trades in-play for the length of the game and resolves after it. The card said "⏱ 1h 3m"
// and let the reader assume that was time-to-result, which is the same lie the history row told
// until it learned to say "in play".
export function isMatchClock(card: Pick<DeckCard, "resolutionDeadline" | "startsAt">): boolean {
  if (!card.startsAt) return false;
  return Math.abs(new Date(card.startsAt).getTime() - new Date(card.resolutionDeadline).getTime()) < 60_000;
}

export function isUpDown(card: Pick<DeckCard, "outcomeYesLabel" | "outcomeNoLabel">): boolean {
  return card.outcomeYesLabel.toLowerCase() === "up" && card.outcomeNoLabel.toLowerCase() === "down";
}

// Display question: for Up/Down markets, strip the trailing absolute-time/zone suffix so the card
// shows the market, and the relative "Resolves in ~N min" line + ⏱ cutoff carry the time.
export function displayQuestion(card: Pick<DeckCard, "question" | "outcomeYesLabel" | "outcomeNoLabel">): string {
  if (!isUpDown(card)) return card.question;
  return card.question
    .replace(/\s*[-–—]\s*[^-–—]*\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|am|pm|et|edt|est|utc|gmt)\b[^-–—]*$/i, "")
    .replace(/\s*\b\d{1,2}(?::\d{2})?\s*(?:am|pm)(?:\s+(?:et|edt|est|utc|gmt))?\s*$/i, "")
    .trim();
}

// Countdown to resolution. `text` = the precise ⏱ cutoff timer ("4h 11m" or "11m 05s"). `relText` =
// a friendly rounded "Resolves in ~N min" line for the quick crypto Up/Down cards.
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

// Settled-result presentation: accent color, badge glyph, tag word. WIN=lime, LOSS=red, PUSH=blue.
export function resultMeta(status: ResultRow["status"]): { accent: string; glyph: string; tag: string } {
  if (status === "WIN") return { accent: "#b6ff2e", glyph: "✓", tag: "Won" };
  if (status === "LOSS") return { accent: "#ff3b4e", glyph: "✕", tag: "Lost" };
  return { accent: "#4d9bff", glyph: "↩", tag: "Void" };
}

// Signed dollar delta from cents, with a real minus glyph. Push shows "Refund".
export function deltaStr(status: ResultRow["status"], c: number): string {
  if (status === "PUSH") return "Refund";
  const d = Math.round(c / 100);
  return d >= 0 ? `+$${d.toLocaleString("en-US")}` : `−$${Math.abs(d).toLocaleString("en-US")}`;
}
