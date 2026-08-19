"use client";

import { useState } from "react";
import { cents, usd, countdown } from "../ui";
import type { HistoryRowData } from "./usePredictionHistory";
import type { ExitQuoteRow } from "@/lib/api-types";

// One prediction-history row. Was verbatim-duplicated in HistorySheet + BalanceSheet; extracted to a
// single shared component (visuals unchanged). Right column: status + delta — PENDING shows the live
// countdown (or "Awaiting result" once the deadline passes); settled shows WON/LOST/PUSH + P&L.
export function HistoryRow({
  row,
  nowMs,
  onClosePosition,
  closing,
  exitQuote,
}: {
  row: HistoryRowData;
  nowMs: number;
  // Present only where a REAL position can be sold (the two history sheets). Absent = display only.
  onClosePosition?: (row: HistoryRowData) => void | Promise<void>;
  closing?: boolean;
  // Live mark-to-market for THIS position, re-polled every second (useExitQuotes). Absent while the
  // first poll is in flight, or when the server has no honest number (book down, no bids).
  exitQuote?: ExitQuoteRow;
}) {
  // Two taps, not one. A swipe is a deliberate gesture and spends without confirmation by design;
  // a button in a list is not, and this one sells a position at market. The arm resets itself so a
  // half-pressed row does not sit primed under someone's thumb.
  const [armed, setArmed] = useState(false);
  // Tap to expand. The row is a summary — a truncated question, a 7-character side label and a
  // price with no units are what fits on one line — and the detail underneath is where the same
  // position is stated in full. Local state, per row: nothing else needs to know.
  const [open, setOpen] = useState(false);
  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  const sideBg = row.side === "YES" ? "color-mix(in srgb,var(--yes) 18%,transparent)" : "color-mix(in srgb,var(--no) 18%,transparent)";

  // An open REAL position is worth something RIGHT NOW, and that is the number a person decides
  // "Close" against — so it takes the row's headline spot while it is live, with the countdown
  // moving down beside the entry price. Settled rows are unaffected: nothing left to sell.
  const live = row.status === "PENDING" && row.closable ? exitQuote : undefined;

  let statusText: string, statusColor: string, delta: string;
  if (live) {
    statusText = `≈ ${usd(live.proceedsCents)}`;
    statusColor = live.pnlCents >= 0 ? "var(--yes)" : "var(--no)";
    delta = `${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)}`; // usd() prints its own minus
  } else if (row.status === "PENDING") {
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

  const toggle = () => setOpen((o) => !o);
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14 }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        }}
        style={{ display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", cursor: "pointer" }}
      >
        <div style={{ minWidth: 34, height: 34, padding: "0 6px", borderRadius: 10, background: sideBg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--df)", fontSize: 12, color: sideColor, flexShrink: 0, maxWidth: 80, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {row.sideLabel.length > 8 ? row.sideLabel.slice(0, 7) + "…" : row.sideLabel}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Open, the question stops being clipped — that is half of what the tap is for. */}
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: open ? "normal" : "nowrap" }}>{row.question}</div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
            {cents(row.lockedPriceBp)} · {usd(row.stakeCents)} stake
            {live ? ` · now ${cents(live.priceBp)} · ⏱ ${countdown(row.resolutionDeadline, nowMs).text}` : ""}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: statusColor, textTransform: "uppercase" }}>{statusText}</div>
          <div style={{ fontFamily: "var(--nf)", fontSize: 12, color: statusColor }}>{delta}</div>
        </div>
        {/* Selling out is the other half of owning a position, and until now it existed only in the
            developer console — the app showed a real position with no way to leave it.
            The click is stopped: selling a position must never be a side effect of opening a row. */}
        {onClosePosition && row.closable ? (
          <button
            type="button"
            disabled={closing}
            onClick={(e) => {
              e.stopPropagation();
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
            {/* The confirm names the money: what comes back and whether that is a gain or a loss.
                "Sell now?" asked someone to approve a trade without telling them its price. Falls
                back to the bare question only when there is no live quote to state. */}
            {closing
              ? "Selling…"
              : armed
                ? live
                  ? `Sell ${usd(live.proceedsCents)} (${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)})?`
                  : "Sell now?"
                : "Close"}
          </button>
        ) : null}
        <div style={{ flexShrink: 0, color: "var(--muted)", fontSize: 10, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</div>
      </div>

      {open ? (
        <div style={{ borderTop: "1px solid var(--line)", padding: "10px 12px 12px", display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", fontSize: 11, lineHeight: 1.35 }}>
          <Detail k="Pick" v={row.sideLabel} color={sideColor} />
          <Detail k="Entry" v={`${cents(row.lockedPriceBp)} · ${usd(row.stakeCents)} stake`} />
          {live ? <Detail k="Market now" v={`${cents(live.priceBp)} per share`} /> : null}
          {live ? (
            <Detail
              k="Sell now for"
              v={`${usd(live.proceedsCents)} · ${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)}${live.partial ? " (book is thin)" : ""}`}
              color={live.pnlCents >= 0 ? "var(--yes)" : "var(--no)"}
            />
          ) : null}
          <Detail k="Placed" v={when(row.createdAt)} />
          <Detail k={row.status === "PENDING" ? "Resolves" : "Resolved"} v={when(row.resolutionDeadline)} />
          {row.settledAt ? <Detail k="Settled" v={when(row.settledAt)} /> : null}
          {row.status !== "PENDING" ? (
            <Detail k="Result" v={`${statusText} · ${delta}`} color={statusColor} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// One label/value pair of the expanded detail. Two grid cells, so every value lines up down the
// column no matter how long the labels get.
function Detail({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <>
      <div style={{ color: "var(--muted)" }}>{k}</div>
      <div style={{ color: color ?? "#fff", overflowWrap: "anywhere" }}>{v}</div>
    </>
  );
}
