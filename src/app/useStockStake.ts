"use client";

import { useCallback, useState } from "react";
import { STOCK_MAX_STAKE_CENTS, STOCK_MIN_STAKE_CENTS, STOCK_STAKE_PRESETS_CENTS } from "@/lib/config";

// Versioned key holding a plain integer of CENTS. A future shape change takes a new suffix rather
// than a migration — a stake is a preference, and the default is a fine answer for a stale value.
const KEY = "hf_stock_stake:v1";
const DEFAULT_CENTS: number = STOCK_STAKE_PRESETS_CENTS[0];

// The ONE place an amount becomes a stake, for every surface that sizes a stock buy. Two input
// shapes, because there are two sources: a NUMBER is already cents (a preset chip, or the value read
// back from storage), a STRING is DOLLARS exactly as the user typed them into the custom chip
// ("5", "1.50", "0.5").
//
// Out of range returns null rather than the nearest bound, deliberately: quietly turning a
// fat-fingered "600" into $500 spends money nobody asked to spend. The caller refuses instead — the
// chip flashes and keeps the previous stake, a stored value falls back to the default.
export function clampStakeCents(raw: unknown): number | null {
  let cents: number;
  if (typeof raw === "number") {
    cents = Math.round(raw);
  } else if (typeof raw === "string") {
    // A plain decimal ONLY. Number() on its own also accepts "0x10", "1e3", "Infinity" and blank
    // strings — every one of which would become a stake the user never typed.
    const t = raw.trim();
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null;
    cents = Math.round(Number(t) * 100);
  } else {
    return null;
  }
  // NaN fails both comparisons, so this is also the malformed-input gate.
  return cents >= STOCK_MIN_STAKE_CENTS && cents <= STOCK_MAX_STAKE_CENTS ? cents : null;
}

// The last stake the user chose, remembered per browser. Someone who buys $50 at a time should not
// have to say so on every card — the deck and the portfolio row read the same number.
export function useStockStake(): { stakeCents: number; setStakeCents: (c: number) => void } {
  const [stakeCents, setStake] = useState<number>(() => {
    // Lazy: read once, on the first client render. `typeof window` keeps SSR out of it; the catch is
    // for a browser that has storage blocked (Safari private mode throws on access).
    if (typeof window === "undefined") return DEFAULT_CENTS;
    try {
      return clampStakeCents(Number(window.localStorage.getItem(KEY))) ?? DEFAULT_CENTS;
    } catch {
      return DEFAULT_CENTS;
    }
  });

  const setStakeCents = useCallback((c: number) => {
    const next = clampStakeCents(c);
    if (next === null) return; // backstop — the chips validate before they ever call this
    setStake(next);
    try {
      window.localStorage.setItem(KEY, String(next));
    } catch {
      /* storage blocked — the stake still holds for this session */
    }
  }, []);

  return { stakeCents, setStakeCents };
}
