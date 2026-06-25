"use client";

import { useEffect, useState } from "react";
import { cents, usd, countdown } from "../ui";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

type Row = {
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

// Prediction history bottom-sheet (opened by tapping the virtual-$ balance). Shows the user's
// open predictions (PENDING, awaiting resolution) first, then settled ones with P&L. Reads
// /api/history. Visual matches the design's history rows.
export function HistorySheet({ api, onClose }: { api: Api; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pending, setPending] = useState(0);
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    api("/api/history")
      .then((d) => { const r = d as { rows: Row[]; pendingCount: number }; setRows(r.rows); setPending(r.pendingCount); })
      .catch(console.error);
  }, [api]);

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(4,4,8,.6)", backdropFilter: "blur(8px)", display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "hfRise .28s ease" }}>
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

function HistoryRow({ row, nowMs }: { row: Row; nowMs: number }) {
  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  const sideBg = row.side === "YES" ? "color-mix(in srgb,var(--yes) 18%,transparent)" : "color-mix(in srgb,var(--no) 18%,transparent)";

  // Right column: status + delta. Pending shows the countdown; settled shows WON/LOST + P&L.
  let statusText: string, statusColor: string, delta: string;
  if (row.status === "PENDING") {
    // After the deadline the market enters Polymarket's UMA resolution window — it's not settled
    // yet but the timer is at 0. Show "Awaiting result" instead of a frozen 0m 00s so it doesn't
    // look stuck. Before the deadline, show the live countdown.
    const deadlinePassed = new Date(row.resolutionDeadline).getTime() <= nowMs;
    if (deadlinePassed) {
      statusText = "AWAITING";
      statusColor = "var(--skip)";
      delta = "⏳ result soon";
    } else {
      statusText = "PENDING";
      statusColor = "var(--muted)";
      delta = "⏱ " + countdown(row.resolutionDeadline, nowMs).text;
    }
  } else if (row.status === "WIN") {
    statusText = "WON";
    statusColor = "var(--yes)";
    delta = `+${usd(row.pnlCents ?? 0)}`;
  } else if (row.status === "LOSS") {
    statusText = "LOST";
    statusColor = "var(--no)";
    delta = usd(row.pnlCents ?? 0); // already negative
  } else {
    statusText = "PUSH";
    statusColor = "var(--muted)";
    delta = "$0";
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "11px 12px" }}>
      <div style={{ minWidth: 34, height: 34, padding: "0 6px", borderRadius: 10, background: sideBg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--df)", fontSize: 12, color: sideColor, flexShrink: 0, maxWidth: 80, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
        {row.sideLabel.length > 8 ? row.sideLabel.slice(0, 7) + "…" : row.sideLabel}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.question}</div>
        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
          {cents(row.lockedPriceBp)} · {usd(row.stakeCents)} stake
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: statusColor, textTransform: "uppercase" }}>{statusText}</div>
        <div style={{ fontFamily: "var(--nf)", fontSize: 12, color: statusColor }}>{delta}</div>
      </div>
    </div>
  );
}
