"use client";

import { usePredictionHistory } from "./usePredictionHistory";
import { HistoryRow } from "./HistoryRow";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// Prediction history bottom-sheet (opened by tapping the virtual-$ balance). Shows the user's
// open predictions (PENDING, awaiting resolution) first, then settled ones with P&L. Reads
// /api/history (via usePredictionHistory — shared with BalanceSheet). Visual matches the design's
// history rows.
export function HistorySheet({ api, onClose }: { api: Api; onClose: () => void }) {
  const { rows, pending, nowMs } = usePredictionHistory(api);

  return (
    // Backdrop is a real button: click/Enter/Escape closes (matches the overlay-click-to-close).
    // ponytail: reset to a plain div via button-reset inline styles so it looks identical.
    <div
      role="button"
      tabIndex={0}
      aria-label="Close"
      onClick={onClose}
      // Escape closes from anywhere in the sheet; Enter/Space only when the backdrop itself is the
      // focus target (not bubbled up from an inner row/control).
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
        else if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onClose(); }
      }}
      style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(4,4,8,.6)", backdropFilter: "blur(8px)", display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "hfRise .28s ease", border: "none", cursor: "default" }}
    >
      <div onClick={(e) => e.stopPropagation()} className="hf-scroll" style={{ background: "var(--bg2)", borderRadius: "28px 28px 0 0", borderTop: "1px solid var(--line)", padding: "8px 18px 22px", maxHeight: "82%", overflowY: "auto" }}>
        <div style={{ width: 42, height: 5, borderRadius: 4, background: "var(--line)", margin: "0 auto 14px" }} />
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>Your predictions</div>
          {pending > 0 && <div style={{ fontSize: 11, color: "var(--skip)", fontWeight: 700 }}>{pending} open</div>}
        </div>

        {!rows ? (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 24, fontSize: 13 }}>No predictions yet. Swipe a card to make your first call.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r) => (
              <HistoryRow key={r.id} row={r} nowMs={nowMs} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
