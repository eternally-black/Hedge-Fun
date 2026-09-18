"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ResultsResponse, ResultRow, StockAlertRow as StockAlertRowData } from "@/lib/api-types";
import { PredictionRow, type PredictionRowData } from "./PredictionRow";
import { StockAlertRow } from "./StockAlertRow";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
type PendingAck = {
  key: string;
  body: { scope: "bets" | "both"; mode: "PAPER" | "REAL"; betIds: string[]; stockAlerts?: { positionId: string; tierBp: number }[] };
  betCount: number;
  stockCount: number;
};

// The notifications inbox: a calm, scannable feed of every settled call, newest first, plus the
// "In profit" strip of tokenized-stock lots that crossed a profit tier. Opening it marks everything
// seen (clears the HUD bell) — stock alerts are acknowledged by the exact (position, tier) pairs the
// screen received, so a tier that fires while the list is open stays unread. "Replay" re-runs the
// dopamine reveal. Lean-back counterpart to the reveal overlay — both read /api/results.
export function NotificationsScreen({ api, onSeen, onReplay, onOpenStock, onAckFailed }: { api: Api; onSeen: (betCount: number, stockCount: number) => void; onReplay: () => void; onOpenStock?: () => void; onAckFailed: () => void }) {
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [stockAlerts, setStockAlerts] = useState<StockAlertRowData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [ackQueue, setAckQueue] = useState<PendingAck[]>([]);
  // Guards loadMore against concurrent calls — a double-tap on the button must not append the same
  // page twice (the cursor would advance past it and the rows would duplicate).
  const loadingMore = useRef(false);
  const aliveRef = useRef(false);
  const stagedAckKeys = useRef(new Set<string>());
  const startedAckKeys = useRef(new Set<string>());
  const stageAck = useCallback((ack: PendingAck) => {
    if (stagedAckKeys.current.has(ack.key)) return;
    stagedAckKeys.current.add(ack.key);
    setAckQueue((queue) => [...queue, ack]);
  }, []);

  // Load the feed, commit it, then acknowledge exactly the unseen rows delivered in that response.
  useEffect(() => {
    let alive = true;
    aliveRef.current = true;
    api("/api/results")
      .then((r) => {
        if (!alive) return;
        const res = r as ResultsResponse;
        const alerts = res.stockAlerts ?? [];
        setRows(res.rows);
        setStockAlerts(alerts);
        setNextCursor(res.nextCursor);
        const betIds = res.rows.filter((row) => !row.seen).map((row) => row.id);
        const unseenAlerts = alerts.filter((a) => !a.seen);
        if (betIds.length === 0 && unseenAlerts.length === 0) return;
        const stockAlerts = unseenAlerts.map((a) => ({ positionId: a.positionId, tierBp: a.tierBp }));
        stageAck({
          key: `initial:${res.mode}:${betIds.join(",")}:${stockAlerts.map((a) => `${a.positionId}/${a.tierBp}`).join(",")}`,
          body: { scope: "both", mode: res.mode, betIds, stockAlerts },
          betCount: betIds.length,
          stockCount: stockAlerts.length,
        });
      })
      .catch(console.error);
    return () => { alive = false; aliveRef.current = false; };
  }, [api, stageAck]);

  // ACK only after the rows above have committed. The started-key fence makes the optimistic badge
  // decrement and POST single-shot under React Strict Mode's effect replay.
  useEffect(() => {
    const ack = ackQueue[0];
    if (!ack || startedAckKeys.current.has(ack.key)) return;
    startedAckKeys.current.add(ack.key);
    onSeen(ack.betCount, ack.stockCount);
    api("/api/results/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ack.body),
    }).catch(console.error).finally(() => {
      onAckFailed();
      if (aliveRef.current) setAckQueue((queue) => queue.filter((item) => item.key !== ack.key));
    });
  }, [ackQueue, api, onSeen, onAckFailed]);

  // Fetches the next page and appends it. The cursor lives in state so the next call knows where
  // to continue; a null cursor means the server has no more rows.
  const loadMore = async () => {
    if (loadingMore.current || nextCursor === null) return;
    loadingMore.current = true;
    try {
      const r = (await api(`/api/results?cursor=${encodeURIComponent(nextCursor)}`)) as ResultsResponse;
      if (!aliveRef.current) return;
      setRows((cur) => [...(cur ?? []), ...r.rows]);
      setNextCursor(r.nextCursor);
      const betIds = r.rows.filter((row) => !row.seen).map((row) => row.id);
      if (betIds.length > 0) {
        stageAck({
          key: `page:${r.mode}:${betIds.join(",")}`,
          body: { scope: "bets", mode: r.mode, betIds },
          betCount: betIds.length,
          stockCount: 0,
        });
      }
    } catch (e) {
      if (aliveRef.current) console.error(e);
    } finally {
      loadingMore.current = false;
    }
  };

  if (!rows) {
    return <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>Loading…</div>;
  }

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>Results</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>Every call you&apos;ve made, settled.</div>
        {rows.length > 0 && (
          <button type="button" onClick={onReplay} aria-label="Replay results reveal" style={{ margin: 0, font: "inherit", marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, background: "color-mix(in srgb,var(--energy) 16%,var(--panel))", border: "1px solid color-mix(in srgb,var(--energy) 40%,var(--line))", padding: "8px 12px", borderRadius: 12, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>▸ Replay</button>
        )}
      </div>

      {stockAlerts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
            <div style={{ fontFamily: "var(--df)", fontSize: 18 }}>In profit</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>· {stockAlerts.length}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stockAlerts.map((a) => <StockAlertRow key={a.positionId} row={a} onOpen={onOpenStock} />)}
          </div>
        </div>
      )}

      {rows.length === 0 && stockAlerts.length === 0 ? (
        <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13 }}>
          Nothing settled yet. Swipe some cards — results land here once markets resolve.
        </div>
      ) : rows.length === 0 ? null : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Nothing here counts down — every row is decided — so one clock read is enough. */}
          {rows.map((n) => <PredictionRow key={n.id} row={toPredictionRow(n)} nowMs={0} />)}
          {nextCursor !== null && (
            <button
              type="button"
              onClick={() => void loadMore()}
              style={{ marginTop: 4, padding: "10px 14px", borderRadius: 12, font: "inherit", cursor: "pointer", background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--muted)", fontSize: 13, fontWeight: 700 }}
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// A settled result in the shape every list of the user's own calls renders (PredictionRow). The
// inbox has no deadline to show — the market is decided, and `outcome` says how.
function toPredictionRow(r: ResultRow): PredictionRowData {
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
    pnlCents: r.deltaCents,
    createdAt: r.createdAt,
    settledAt: r.settledAt,
    outcome: r.outcome,
    shards: r.shards,
  };
}
