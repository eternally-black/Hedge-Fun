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

// Category accent + label. On web this is keyed off the deck-mix classifier; here we key off the
// API's own `category` string (same value set: crypto/esports/sports/overunder/politics/weather/other).
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

export function catOf(card: Pick<DeckCard, "category">): { color: string; label: string; icon: string } {
  return (card.category && CAT_COLORS[card.category]) || FALLBACK_CAT;
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

// One-line plain-language explainer under the question. Only Over/Under markets need it.
export function marketHint(card: Pick<DeckCard, "question" | "outcomeYesLabel" | "outcomeNoLabel">): string | null {
  if (ouLabels(card.outcomeYesLabel) && ouLabels(card.outcomeNoLabel)) {
    const line = ouLine(card.question);
    return line ? `Will the total be over or under ${line}?` : "Will the total go over or under the line?";
  }
  return null;
}

// Crypto Up/Down = the quick minute/15-min markets whose question carries an ABSOLUTE resolution
// time ("Bitcoin Up or Down - 9:05AM"). Detected by the Up/Down side labels.
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
