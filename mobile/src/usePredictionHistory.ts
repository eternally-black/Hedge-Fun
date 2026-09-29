// usePredictionHistory (native) — port of src/app/screens/usePredictionHistory.ts: the shared
// /api/history fetch + the gated 1s clock for PENDING countdowns, the live exit-quote poll for
// closable rows, the row-shape mapper, and the close-position action.
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ExitQuoteRow, ExitQuotesResponse, HistoryResponse, HistoryRow, MeResponse } from "@contract/api-types";
import { placeRealOrder } from "@contract/real-client";
import { useRealCtx } from "./useRealCtx";
import { QUOTE_POLL_MS } from "../lib/config";
import type { Api } from "./api";
import type { PredictionRowData } from "./components/PredictionRow";

// One prediction-history row, exactly as /api/history returns it (the contract type).
export type HistoryRowData = HistoryRow;

// The clock is GATED — it only ticks while at least one row is PENDING with a future deadline, so a
// list full of settled rows doesn't re-render every second for nothing.
export function usePredictionHistory(api: Api) {
  const [rows, setRows] = useState<HistoryRowData[] | null>(null);
  // Whether the LAST refresh failed. rows === null means "not loaded yet"; a swallowed failure used
  // to leave that spinner up for good, so the list needs to know "the call failed, offer a retry".
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Guards loadMore against concurrent calls — a double tap must not append the same page twice.
  const loadingMore = useRef(false);
  // A real timestamp (not 0) so the deadline-passed check is right even before the clock ticks.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const r = (await api("/api/history")) as HistoryResponse;
      setRows(r.rows);
      setPending(r.pendingCount);
      setNextCursor(r.nextCursor);
      setError(false);
    } catch (e) {
      console.error(e);
      // Rows already on screen stay (a dropped request is not news); an empty list replaces the
      // "Loading…" that would otherwise never end.
      setRows((cur) => cur ?? []);
      setError(true);
    }
  }, [api]);

  const loadMore = useCallback(async () => {
    if (loadingMore.current || nextCursor === null) return;
    loadingMore.current = true;
    try {
      const r = (await api(`/api/history?cursor=${encodeURIComponent(nextCursor)}`)) as HistoryResponse;
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

  // Derived from the `nowMs` state (not Date.now() — keep render pure) so the gate flips when rows
  // arrive and again when the clock ticks a row past its deadline.
  const needsTick = !!rows && rows.some(
    (r) => r.status === "PENDING" && new Date(r.resolutionDeadline).getTime() > nowMs,
  );
  useEffect(() => {
    if (!needsTick) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [needsTick]);

  return { rows, pending, nowMs, refresh, hasMore: nextCursor !== null, loadMore, error };
}

// Live mark-to-market for the closable rows on screen: what each position would fetch if sold right
// now. Polled every QUOTE_POLL_MS because a CLOB book moves several times a second, and "Close" is a
// decision made against the number in front of the user. Only CLOSABLE rows are asked for, and the
// poll stops when there are none, when the app is backgrounded, or when `active` says this list is
// not the one on screen.
export function useExitQuotes(api: Api, rows: HistoryRowData[] | null, active = true) {
  const [quotes, setQuotes] = useState<Record<string, ExitQuoteRow>>({});
  // Sorted + joined so the effect re-runs when the SET of closable rows changes, not on every
  // refresh that hands back an equal array.
  const ids = (rows ?? []).filter((r) => r.closable).map((r) => r.id).sort().join(",");

  useEffect(() => {
    if (!active || !ids) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => clearInterval(timer);
    const tick = async () => {
      try {
        const r = (await api(`/api/real/exit-quote?ids=${encodeURIComponent(ids)}`)) as ExitQuotesResponse;
        if (!alive) return;
        setQuotes(Object.fromEntries(r.quotes.map((q) => [q.betId, q])));
      } catch {
        // A failed poll keeps the last number rather than blanking the row.
      }
    };
    // Stop while backgrounded, one immediate read on return — the book moved while the app was away.
    const start = () => { stop(); timer = setInterval(() => void tick(), QUOTE_POLL_MS); };
    const onState = (state: string) => {
      if (state !== "active") return stop();
      void tick();
      start();
    };
    onState(AppState.currentState);
    const sub = AppState.addEventListener("change", onState);
    return () => { alive = false; stop(); sub.remove(); };
  }, [active, api, ids]);

  // Empty when nothing is closable: a leftover entry for a since-settled row is never read.
  return ids ? quotes : {};
}

// The history row in the shape every list of the user's own calls renders (PredictionRow).
export function toPredictionRow(r: HistoryRowData): PredictionRowData {
  return {
    id: r.id,
    question: r.question,
    side: r.side,
    sideLabel: r.sideLabel,
    status: r.status,
    hedge: r.source === "HEDGE",
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

// Closing a REAL position. The sell is the same two-phase order protocol a swipe uses, in the other
// direction — the server derives the params from the position and the device signs them; nothing
// here decides a price. One copy of a money action, shared by every list that offers it.
export function useClosePosition(
  api: Api,
  me: MeResponse | null,
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
        // "posted" = the exchange took it and the reconciler books it within minutes; "submitting" =
        // the device post had no answer and the server's sweep resolves it — progress, not failure.
        onToast(
          r.status === "filled" || r.status === "partial"
            ? "Position closed"
            : r.status === "killed"
              ? "No buyers at that price — position kept"
              : r.status === "submitting"
                ? "Sent — checking the outcome"
                : "Sent — settling",
        );
      } catch (e) {
        const body = (e as { body?: { error?: string } }).body;
        onToast(
          body?.error === "no_position"
            ? "Nothing left to close"
            : body?.error === "attempt_in_flight"
              ? "A close is already in progress — checking"
              : "Couldn't close — try again",
        );
      } finally {
        setClosing(null);
        await refresh();
      }
    },
    [api, ctx, onToast, refresh],
  );

  return { close, closing };
}
