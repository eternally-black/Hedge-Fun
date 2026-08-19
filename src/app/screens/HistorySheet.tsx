"use client";

import type { Me } from "../ui";
import { usePredictionHistory, useClosePosition, useExitQuotes, toPredictionRow } from "./usePredictionHistory";
import { PredictionRow } from "./PredictionRow";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// Prediction history bottom-sheet (opened by tapping the virtual-$ balance). Shows the user's
// open predictions (PENDING, awaiting resolution) first, then settled ones with P&L. Reads
// /api/history (via usePredictionHistory — shared with BalanceSheet). Visual matches the design's
// history rows.
export function HistorySheet({ me, api, onClose, onToast }: { me: Me | null; api: Api; onClose: () => void; onToast: (msg: string) => void }) {
  const { rows, pending, nowMs, refresh } = usePredictionHistory(api);
  const { close, closing } = useClosePosition(api, me, onToast, refresh);
  const exitQuotes = useExitQuotes(api, rows); // live value + P&L for the closable rows, 1s

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
        {/* The backdrop closes on click, but it only spans the DEVICE SURFACE — on desktop the app is
            a 402px phone mock and a click beside it lands on the page, not on this overlay. So the
            dismiss cannot live only there: this handle is a real button, and there is an X beside
            the title. Reported as "the sheet cannot be closed", which it could not, from outside. */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{ display: "block", margin: "0 auto 14px", padding: "6px 24px", background: "none", border: "none", cursor: "pointer" }}
        >
          <div style={{ width: 42, height: 5, borderRadius: 4, background: "var(--line)" }} />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>Your predictions</div>
          {pending > 0 && <div style={{ fontSize: 11, color: "var(--skip)", fontWeight: 700 }}>{pending} open</div>}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ margin: "0 0 0 auto", font: "inherit", width: 30, height: 30, borderRadius: 999, background: "var(--panel)", border: "1px solid var(--line)", color: "var(--muted)", fontSize: 15, lineHeight: 1, cursor: "pointer", flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        {!rows ? (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 24, fontSize: 13 }}>No predictions yet. Swipe a card to make your first call.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r) => (
              <PredictionRow key={r.id} row={toPredictionRow(r)} nowMs={nowMs} onClosePosition={() => close(r)} closing={closing === r.id} exitQuote={exitQuotes[r.id]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
