// Shared UI helpers + types for the Hedge Fun screens (ported from app design).
"use client";

import { categoryOf, type Category } from "@/lib/deck-mix";
import { STAKE_CENTS } from "@/lib/config";
import type { DeckCard, MeResponse } from "@/lib/api-types";

// The screens consume the API contract directly (src/lib/api-types.ts) — single source of truth,
// shared verbatim with the Android client. These aliases keep the existing screen imports working.
export type Card = DeckCard;
export type Me = MeResponse;

export type Screen = "deck" | "gm" | "vault" | "invite" | "you" | "leaderboard" | "notifications";

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

// Display accent + label for a card, derived via the SAME classifier the deck mixer uses.
export function catOf(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): { color: string; label: string; icon: string } {
  return CAT_COLORS[categoryOf({ question: card.question, outcomeYesLabel: card.outcomeYesLabel, outcomeNoLabel: card.outcomeNoLabel })];
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

// One-line plain-language explainer shown under the question. Only Over/Under markets need it (the
// rest are self-explanatory: a team name, Yes/No). Returns null when no hint helps.
export function marketHint(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): string | null {
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
  return CAT_COLORS[categoryOf({ question: r.question, outcomeYesLabel: "", outcomeNoLabel: "" })];
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

// Countdown to resolution, "4h 11m" or "11m 05s" near the wire.
export function countdown(iso: string, nowMs: number): { text: string; urgent: boolean } {
  const total = Math.max(0, Math.round((new Date(iso).getTime() - nowMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const text = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
  return { text, urgent: total < 3600 };
}
