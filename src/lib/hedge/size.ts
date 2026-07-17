// Sizer — PURE core, rules NOT hedge math (D1, spec §2). Turns a hedged notional into a proposed
// paper stake in integer cents: majors at HEDGE_MAJOR_PCT_BP (within the 5–10% product band), the
// SPL proxy at HEDGE_PROXY_PCT_BP (~3%), then clamped to [HEDGE_MIN_STAKE_CENTS, HEDGE_MAX_STAKE_CENTS].
// The per-user Cash clamp is applied later, at accept time (needs the balance — not pure). DB-free.

import {
  HEDGE_MAJOR_PCT_BP,
  HEDGE_PROXY_PCT_BP,
  HEDGE_MIN_STAKE_CENTS,
  HEDGE_MAX_STAKE_CENTS,
} from "../config";

export type SizeKind = "S1_MAJOR" | "S1_PROXY";

// Proposed stake for a hedge, in integer cents. Returns 0 when the sized amount would fall below the
// min clamp (caller drops the suggestion — a sub-$1 hedge is noise). Never exceeds the max clamp.
export function sizeS1(notionalCents: number, kind: SizeKind): number {
  if (!(notionalCents > 0)) return 0;
  const pctBp = kind === "S1_MAJOR" ? HEDGE_MAJOR_PCT_BP : HEDGE_PROXY_PCT_BP;
  const raw = Math.round((notionalCents * pctBp) / 10_000);
  if (raw < HEDGE_MIN_STAKE_CENTS) return 0; // below the floor -> not worth suggesting
  return Math.min(raw, HEDGE_MAX_STAKE_CENTS);
}
