"use client";

import { useCallback, useEffect, useState } from "react";
import type { Me } from "../ui";
import { useRealCtx } from "../useRealCtx";
import { placeRealOrder } from "@/lib/real-client";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// One prediction-history row, mirrored from /api/history. Shared by the two sheets that show it
// (BalanceSheet + the legacy HistorySheet) so the shape + fetch + clock live in ONE place.
export type HistoryRowData = {
  id: string;
  marketId: string;
  question: string;
  sideLabel: string;
  side: "YES" | "NO";
  stakeCents: number;
  lockedPriceBp: number;
  status: "PENDING" | "WIN" | "LOSS" | "PUSH";
  pnlCents: number | null;
  resolutionDeadline: string;
  createdAt: string;
  closable?: boolean; // REAL position with a remainder the signer can actually sell
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

  const refresh = useCallback(async () => {
    try {
      const r = (await api("/api/history")) as { rows: HistoryRowData[]; pendingCount: number };
      setRows(r.rows);
      setPending(r.pendingCount);
    } catch (e) {
      console.error(e);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only run the per-second clock when a row is still counting down (PENDING + deadline in the
  // future). Once everything is settled (or past its deadline → frozen "Awaiting result"), the
  // countdown text never changes, so ticking would just re-render for nothing. Derived during render
  // from the `nowMs` state (NOT Date.now() — keep render pure) so the gate flips when rows arrive
  // and again when the clock ticks a row past its deadline.
  const needsTick = !!rows && rows.some(
    (r) => r.status === "PENDING" && new Date(r.resolutionDeadline).getTime() > nowMs,
  );
  useEffect(() => {
    if (!needsTick) return;
    // No synchronous setState here — nowMs is seeded by the lazy initializer, the interval drives it.
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [needsTick]);

  return { rows, pending, nowMs, refresh };
}

// Closing a REAL position from the history sheet. The sell is the same two-phase order protocol a
// swipe uses, in the other direction — the server derives the params from the position and the
// device signs them; nothing here decides a price. Lives beside the data hook because both sheets
// that render the list need it, and a second copy of a money action is a second thing to get wrong.
export function useClosePosition(
  api: Api,
  me: Me | null,
  onToast: (msg: string) => void,
  refresh: () => Promise<void>,
) {
  const { ctx } = useRealCtx(me);
  const [closing, setClosing] = useState<string | null>(null);

  const close = useCallback(
    async (row: HistoryRowData) => {
      // The signer is built from the logged-in wallet; without it there is nothing to sign with.
      if (!ctx) return onToast("Wallet not ready yet — try again in a moment");
      setClosing(row.id);
      try {
        const r = (await placeRealOrder(api, ctx, { marketId: row.marketId, side: row.side, dir: "EXIT" })) as {
          status: string;
        };
        // "posted" means the exchange took it but its trade records are not queryable yet — the
        // reconciler books it within minutes, so it is progress, not failure.
        onToast(
          r.status === "filled" || r.status === "partial"
            ? "Position closed"
            : r.status === "killed"
              ? "No buyers at that price — position kept"
              : "Sent — settling",
        );
      } catch (e) {
        const body = (e as { body?: { error?: string } }).body;
        onToast(body?.error === "no_position" ? "Nothing left to close" : "Couldn't close — try again");
      } finally {
        setClosing(null);
        await refresh();
      }
    },
    [api, ctx, onToast, refresh],
  );

  return { close, closing };
}
