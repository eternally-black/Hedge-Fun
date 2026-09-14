"use client";

import { useEffect, useRef, useState } from "react";
import type { ResultsResponse, ResultRow, StockAlertRow as StockAlertRowData } from "@/lib/api-types";
import { PredictionRow, type PredictionRowData } from "./PredictionRow";
import { StockAlertRow } from "./StockAlertRow";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The notifications inbox: a calm, scannable feed of every settled call, newest first, plus the
// "In profit" strip of tokenized-stock lots that crossed a profit tier. Opening it marks everything
// seen (clears the HUD bell) — stock alerts are acknowledged by the exact (position, tier) pairs the
// screen received, so a tier that fires while the list is open stays unread. "Replay" re-runs the
// dopamine reveal. Lean-back counterpart to the reveal overlay — both read /api/results.
export function NotificationsScreen({ api, onSeen, onReplay, onOpenStock }: { api: Api; onSeen: () => void; onReplay: () => void; onOpenStock?: () => void }) {
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [stockAlerts, setStockAlerts] = useState<StockAlertRowData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Guards loadMore against concurrent calls — a double-tap on the button must not append the same
  // page twice (the cursor would advance past it and the rows would duplicate).
  const loadingMore = useRef(false);

  // Load the feed, then mark seen. Marking is fire-and-forget (the badge already cleared locally
  // via onSeen); a failed mark just means the badge reappears on next /api/me — acceptable.
  useEffect(() => {
    let alive = true;
    api("/api/results")
      .then((r) => {
        if (!alive) return;
        const res = r as ResultsResponse;
        const alerts = res.stockAlerts ?? [];
        setRows(res.rows);
        setStockAlerts(alerts);
        setNextCursor(res.nextCursor);
        // Acknowledge what was DELIVERED: bets (all unseen) + exactly the stock alert pairs shown.
        const body = {
          scope: "both",
          stockAlerts: alerts.filter((a) => !a.seen).map((a) => ({ positionId: a.positionId, tierBp: a.tierBp })),
        };
        api("/api/results/seen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          .catch(() => { /* badge re-syncs from /api/me */ });
      })
      .catch(console.error);
    onSeen();
    return () => { alive = false; };
  }, [api, onSeen]);

  // Fetches the next page and appends it. The cursor lives in state so the next call knows where
  // to continue; a null cursor means the server has no more rows.
  const loadMore = async () => {
    if (loadingMore.current || nextCursor === null) return;
    loadingMore.current = true;
    try {
      const r = (await api(`/api/results?cursor=${encodeURIComponent(nextCursor)}`)) as ResultsResponse;
      setRows((cur) => [...(cur ?? []), ...r.rows]);
      setNextCursor(r.nextCursor);
    } catch (e) {
      console.error(e);
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
