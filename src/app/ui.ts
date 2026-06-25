// Shared UI helpers + types for the Hedge Fun screens (ported from app design).
"use client";

import { categoryOf, type Category } from "@/lib/deck-mix";

export type Card = {
  id: string;
  question: string;
  category: string | null;
  outcomeYesLabel: string;
  outcomeNoLabel: string;
  yesPriceBp: number;
  noPriceBp: number;
  resolutionDeadline: string;
};

export type Me = {
  user: { id: string; email: string | null; twitter: string | null; referralCode: string };
  balanceCents: number;
  points: { total: number; bonusFromX2: number };
  swipes: { used: number; cap: number };
  skips: { usedToday: number; nextIsFree: boolean; shardCost: number };
  shards: number;
  artifacts: number;
  streak: { level: number; state: string; recoverableUntil: string | null };
  loginMarkedToday: boolean;
  dev?: boolean; // dev test account: unlimited skips + deck reset
};

export type Screen = "deck" | "gm" | "vault" | "invite" | "you" | "leaderboard";

// Price as Polymarket shows it: cents per share. bp/100 = cents (5150bp -> 51.5¢). Whole cents
// when integer, one decimal otherwise. Sides need NOT sum to 100¢ (spread is real) — no rounding.
export const cents = (bp: number) => {
  const c = bp / 100;
  return `${Number.isInteger(c) ? c : c.toFixed(1)}¢`;
};

export const num = (n: number) => n.toLocaleString("en-US");
export const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

// Virtual-$ payout if this side wins: stake $100 at price p (cents/100) returns 100/p shares
// worth $1 each. Mirrors settle.ts share math. bp is the bought side's price.
export const winPayout = (bp: number) => {
  const p = Math.max(0.02, bp / 10000);
  return Math.round(100 / p);
};

// Category accent + display label. Single source of truth = deck-mix categoryOf, so the badge a
// card shows ALWAYS matches the category it was mixed by (no more display/mix disagreement).
const CAT_COLORS: Record<Category, { color: string; label: string }> = {
  crypto: { color: "#ff8a3d", label: "Crypto" },
  sports: { color: "#3d7bff", label: "Sports" },
  esports: { color: "#b14dff", label: "Esports" },
  overunder: { color: "#19c8ff", label: "Over / Under" },
  politics: { color: "#94a3b8", label: "Politics" },
  weather: { color: "#38bdf8", label: "Weather" },
  other: { color: "#94a3b8", label: "Market" },
};

// Display accent + label for a card, derived via the SAME classifier the deck mixer uses.
export function catOf(card: Pick<Card, "question" | "outcomeYesLabel" | "outcomeNoLabel">): { color: string; label: string } {
  return CAT_COLORS[categoryOf({ question: card.question, outcomeYesLabel: card.outcomeYesLabel, outcomeNoLabel: card.outcomeNoLabel })];
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
