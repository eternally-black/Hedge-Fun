// The last stake the user chose, remembered on the device — native twin of src/app/useStockStake.ts.
// The deck chips and the portfolio Buy row read the same number. Storage is SecureStore only because
// it is the store the app already uses (refCode.ts); a stake is a preference, not a secret.
import { useCallback, useEffect, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { STOCK_MAX_STAKE_CENTS, STOCK_MIN_STAKE_CENTS, STOCK_STAKE_PRESETS_CENTS } from "../lib/config";

const KEY = "hf_stock_stake_v1"; // SecureStore keys: alphanumeric, '.', '-', '_' only
const DEFAULT_CENTS: number = STOCK_STAKE_PRESETS_CENTS[0];

// The ONE place an amount becomes a stake. A NUMBER is already cents (a preset chip, a stored
// value); a STRING is DOLLARS as typed into the custom chip ("5", "1.50", ".5"). Out of range → null,
// never the nearest bound: quietly turning "600" into $500 spends money nobody asked to spend.
export function clampStakeCents(raw: unknown): number | null {
  let cents: number;
  if (typeof raw === "number") {
    cents = Math.round(raw);
  } else if (typeof raw === "string") {
    const t = raw.trim();
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null; // plain decimals only (no "1e3", "0x10", "")
    cents = Math.round(Number(t) * 100);
  } else {
    return null;
  }
  return cents >= STOCK_MIN_STAKE_CENTS && cents <= STOCK_MAX_STAKE_CENTS ? cents : null; // NaN fails both
}

export function useStockStake(): { stakeCents: number; setStakeCents: (c: number) => void } {
  const [stakeCents, setStake] = useState<number>(DEFAULT_CENTS);

  // Read once on mount; the default is a fine answer for a missing or malformed value.
  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(KEY)
      .then((v) => {
        const c = clampStakeCents(Number(v));
        if (alive && v !== null && c !== null) setStake(c);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const setStakeCents = useCallback((c: number) => {
    const next = clampStakeCents(c);
    if (next === null) return; // backstop — the chips validate before they ever call this
    setStake(next);
    SecureStore.setItemAsync(KEY, String(next)).catch(() => undefined); // the stake still holds for this session
  }, []);

  return { stakeCents, setStakeCents };
}
