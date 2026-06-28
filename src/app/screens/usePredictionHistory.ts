"use client";

import { useEffect, useState } from "react";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// One prediction-history row, mirrored from /api/history. Shared by the two sheets that show it
// (BalanceSheet + the legacy HistorySheet) so the shape + fetch + clock live in ONE place.
export type HistoryRowData = {
  id: string;
  question: string;
  sideLabel: string;
  side: "YES" | "NO";
  stakeCents: number;
  lockedPriceBp: number;
  status: "PENDING" | "WIN" | "LOSS" | "PUSH";
  pnlCents: number | null;
  resolutionDeadline: string;
  createdAt: string;
};

// Shared /api/history fetch + the 1s "now" clock that drives the live PENDING countdown. Both sheets
// rendered an identical copy of this; extracted so there's a single source. The clock is GATED — it
// only ticks while at least one row is PENDING with a future deadline, so a sheet full of settled
// rows doesn't re-render every second for nothing.
export function usePredictionHistory(api: Api) {
  const [rows, setRows] = useState<HistoryRowData[] | null>(null);
  const [pending, setPending] = useState(0);
  // Start at a real timestamp (not 0) so the deadline-passed check in HistoryRow is correct even
  // before/without the ticking clock — a 0 here would make every "AWAITING" row read as still-live.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    api("/api/history")
      .then((d) => {
        if (!alive) return;
        const r = d as { rows: HistoryRowData[]; pendingCount: number };
        setRows(r.rows);
        setPending(r.pendingCount);
      })
      .catch(console.error);
    return () => { alive = false; };
  }, [api]);

  // Only run the per-second clock when a row is still counting down (PENDING + deadline in the
  // future). Once everything is settled (or past its deadline → frozen "Awaiting result"), the
  // countdown text never changes, so ticking would just re-render for nothing. Derived during render
  // (no effect-stored state) so the gate flips the moment the rows that decide it arrive.
  const needsTick = !!rows && rows.some(
    (r) => r.status === "PENDING" && new Date(r.resolutionDeadline).getTime() > Date.now(),
  );
  useEffect(() => {
    if (!needsTick) return;
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [needsTick]);

  return { rows, pending, nowMs };
}
