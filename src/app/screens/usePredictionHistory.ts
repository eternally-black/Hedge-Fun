"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Me } from "../ui";
import { useRealCtx } from "../useRealCtx";
import { placeRealOrder } from "@/lib/real-client";
import { QUOTE_POLL_MS } from "@/lib/config";
import type { ExitQuoteRow, ExitQuotesResponse } from "@/lib/api-types";
import type { PredictionRowData } from "./PredictionRow";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// One prediction-history row, mirrored from /api/history. Shared by the two sheets that show it
// (BalanceSheet + the legacy HistorySheet) so the shape + fetch + clock live in ONE place.
export type HistoryRowData = {
  id: string;
  marketId: string;
  question: string;
  category: string | null;
  league?: string | null;
  sideLabel: string;
  side: "YES" | "NO";
  stakeCents: number;
  lockedPriceBp: number;
  status: "PENDING" | "WIN" | "LOSS" | "PUSH";
  pnlCents: number | null;
  resolutionDeadline: string;
  startsAt?: string | null;
  createdAt: string;
  settledAt?: string | null;
  closable?: boolean; // REAL position with a remainder the signer can actually sell
};

// Shared /api/history fetch + the 1s "now" clock that drives the live PENDING countdown. Both sheets
// rendered an identical copy of this; extracted so there's a single source. The clock is GATED — it
// only ticks while at least one row is PENDING with a future deadline, so a sheet full of settled
// rows doesn't re-render every second for nothing.
export function usePredictionHistory(api: Api) {
  const [rows, setRows] = useState<HistoryRowData[] | null>(null);
  const [pending, setPending] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Guards loadMore against concurrent calls — a double-tap on the button must not append the same
  // page twice (the cursor would advance past it and the rows would duplicate).
  const loadingMore = useRef(false);
  // Start at a real timestamp (not 0) so the deadline-passed check in HistoryRow is correct even
  // before/without the ticking clock — a 0 here would make every "AWAITING" row read as still-live.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const r = (await api("/api/history")) as { rows: HistoryRowData[]; pendingCount: number; nextCursor: string | null };
      setRows(r.rows);
      setPending(r.pendingCount);
      setNextCursor(r.nextCursor);
    } catch (e) {
      console.error(e);
    }
  }, [api]);

  // Fetches the next page and appends it. The cursor lives in state so the next call knows where
  // to continue; a null cursor means the server has no more rows.
  const loadMore = useCallback(async () => {
    if (loadingMore.current || nextCursor === null) return;
    loadingMore.current = true;
    try {
      const r = (await api(`/api/history?cursor=${encodeURIComponent(nextCursor)}`)) as {
        rows: HistoryRowData[];
        pendingCount: number;
        nextCursor: string | null;
      };
      setRows((cur) => [...(cur ?? []), ...r.rows]);
      setPending(r.pendingCount);
      setNextCursor(r.nextCursor);
    } catch (e) {
      console.error(e);
    } finally {
      loadingMore.current = false;
    }
  }, [api, nextCursor]);

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

  return { rows, pending, nowMs, refresh, hasMore: nextCursor !== null, loadMore };
}

// Live mark-to-market for the closable rows on screen: what each position would fetch if sold right
// now, and whether that is a gain or a loss. Polled every second because a CLOB book moves several
// times a second — a P&L that only refreshes when the sheet opens is a number from the past, and
// "Close" is a decision made against the number in front of the user.
//
// Only CLOSABLE rows are asked for (a settled row has nothing to sell), and the poll stops entirely
// when there are none. A row the server has no honest number for is simply absent from the map.
export function useExitQuotes(api: Api, rows: HistoryRowData[] | null) {
  const [quotes, setQuotes] = useState<Record<string, ExitQuoteRow>>({});
  // Sorted + joined so the effect re-runs when the SET of closable rows changes, not on every
  // refresh that hands back an equal array.
  const ids = (rows ?? []).filter((r) => r.closable).map((r) => r.id).sort().join(",");

  useEffect(() => {
    if (!ids) return; // nothing sellable on screen — no poll, and the map below reads empty
    let alive = true;
    const tick = async () => {
      try {
        const r = (await api(`/api/real/exit-quote?ids=${encodeURIComponent(ids)}`)) as ExitQuotesResponse;
        if (!alive) return;
        setQuotes(Object.fromEntries(r.quotes.map((q) => [q.betId, q])));
      } catch {
        // A failed poll keeps the last number rather than blanking the row: one dropped request is
        // not news, and a value that flickers away and back is worse than a value one second old.
      }
    };
    void tick();
    const t = window.setInterval(tick, QUOTE_POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [api, ids]);

  // Empty when nothing is closable, rather than clearing state in the effect: a leftover entry for
  // a row that has since settled is never read (HistoryRow only marks up a closable row).
  return ids ? quotes : {};
}

// The history row in the shape every list of the user's own calls renders (PredictionRow). The
// sheet keeps `marketId` for the EXIT — the row itself never needs it.
export function toPredictionRow(r: HistoryRowData): PredictionRowData {
  return {
    id: r.id,
    question: r.question,
    side: r.side,
    sideLabel: r.sideLabel,
    status: r.status,
    league: r.league,
    category: r.category,
    stakeCents: r.stakeCents,
    lockedPriceBp: r.lockedPriceBp,
    pnlCents: r.pnlCents,
    createdAt: r.createdAt,
    resolutionDeadline: r.resolutionDeadline,
    startsAt: r.startsAt,
    settledAt: r.settledAt,
    closable: r.closable,
  };
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
