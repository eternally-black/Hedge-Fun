"use client";

import { useState } from "react";
import { cents, usd, countdown } from "../ui";
import type { HistoryRowData } from "./usePredictionHistory";

// One prediction-history row. Was verbatim-duplicated in HistorySheet + BalanceSheet; extracted to a
// single shared component (visuals unchanged). Right column: status + delta — PENDING shows the live
// countdown (or "Awaiting result" once the deadline passes); settled shows WON/LOST/PUSH + P&L.
export function HistoryRow({
  row,
  nowMs,
  onClosePosition,
  closing,
}: {
  row: HistoryRowData;
  nowMs: number;
  // Present only where a REAL position can be sold (the two history sheets). Absent = display only.
  onClosePosition?: (row: HistoryRowData) => void | Promise<void>;
  closing?: boolean;
}) {
  // Two taps, not one. A swipe is a deliberate gesture and spends without confirmation by design;
  // a button in a list is not, and this one sells a position at market. The arm resets itself so a
  // half-pressed row does not sit primed under someone's thumb.
  const [armed, setArmed] = useState(false);
  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  const sideBg = row.side === "YES" ? "color-mix(in srgb,var(--yes) 18%,transparent)" : "color-mix(in srgb,var(--no) 18%,transparent)";

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
      {/* Selling out is the other half of owning a position, and until now it existed only in the
          developer console — the app showed a real position with no way to leave it. */}
      {onClosePosition && row.closable ? (
        <button
          type="button"
          disabled={closing}
          onClick={() => {
            if (closing) return;
            if (!armed) {
              setArmed(true);
              window.setTimeout(() => setArmed(false), 4000);
              return;
            }
            setArmed(false);
            void onClosePosition(row);
          }}
          style={{
            margin: 0,
            font: "inherit",
            flexShrink: 0,
            padding: "7px 10px",
            borderRadius: 10,
            background: armed ? "var(--gold)" : "transparent",
            color: armed ? "#1a1205" : "var(--muted)",
            border: "1px solid " + (armed ? "var(--gold)" : "var(--line)"),
            fontWeight: 700,
            fontSize: 11,
            cursor: closing ? "default" : "pointer",
            opacity: closing ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {closing ? "Selling…" : armed ? "Sell now?" : "Close"}
        </button>
      ) : null}
    </div>
  );
}
