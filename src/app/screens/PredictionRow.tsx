"use client";

import { useState } from "react";
import { cents, usd, countdown, deltaStr, resultMeta } from "../ui";
import type { ExitQuoteRow } from "@/lib/api-types";

// ONE row for every list of the user's own calls. There were two, drawn by two components that
// happened to show the same bet: the history sheet clipped the question to a single line and cut
// the side label to seven characters, the results inbox let the question breathe but replaced the
// side with a category emoji, and neither opened. Same bet, two answers to "what am I looking at".
//
// This is that row: the inbox's proportions (a question that wraps, a calm subtitle), the sheet's
// side pill (Yes / No / Over 2.5 — what the user actually picked, not what kind of market it is),
// and tap-to-open in both places. The lists still differ in WHAT they list — the sheet has open
// positions, the inbox has settled calls — but not in how a row reads.
export type PredictionRowData = {
  id: string;
  question: string;
  side: "YES" | "NO";
  sideLabel: string; // the real name of the side the user took ("Under 2.5", "Up", "Yes")
  status: "PENDING" | "WIN" | "LOSS" | "PUSH";
  league?: string | null; // "Soccer", "CS2" — leads the subtitle when known
  category?: string | null; // fallback when the market names no discipline ("crypto", "politics")
  stakeCents: number;
  lockedPriceBp: number; // entry price
  pnlCents: number | null; // null while open
  createdAt: string;
  resolutionDeadline?: string | null; // absent on a settled inbox row (the deadline is spent)
  settledAt?: string | null;
  outcome?: string | null; // "Resolved Up" — the settled row's human verdict
  shards?: number;
  closable?: boolean; // REAL position with a sellable remainder
};

export function PredictionRow({
  row,
  nowMs,
  exitQuote,
  onClosePosition,
  closing,
}: {
  row: PredictionRowData;
  nowMs: number;
  // Live mark-to-market for an open REAL position, re-polled every second (useExitQuotes).
  exitQuote?: ExitQuoteRow;
  // Present only where a position can actually be sold. Absent = a display-only list.
  onClosePosition?: (row: PredictionRowData) => void | Promise<void>;
  closing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Two taps, not one. A swipe is a deliberate gesture and spends without confirmation by design;
  // a button in a list is not, and this one sells a position at market. The arm resets itself so a
  // half-pressed row does not sit primed under someone's thumb.
  const [armed, setArmed] = useState(false);

  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  const settled = row.status !== "PENDING";
  // Live numbers belong to an open position that can still be sold — a settled row's money is done.
  const live = !settled && row.closable ? exitQuote : undefined;
  const deadlinePassed = !!row.resolutionDeadline && new Date(row.resolutionDeadline).getTime() <= nowMs;

  // Right column: what this call is worth. Settled says what it paid; open says what it would fetch
  // now (when we have a live quote), else how long is left.
  let headline: string, sub: string, accent: string;
  if (settled) {
    const m = resultMeta(row.status as "WIN" | "LOSS" | "PUSH");
    headline = deltaStr(row.status as "WIN" | "LOSS" | "PUSH", row.pnlCents ?? 0);
    sub = m.tag;
    accent = m.accent;
  } else if (live) {
    headline = `≈ ${usd(live.proceedsCents)}`;
    sub = `${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)}`; // usd() prints its own minus
    accent = live.pnlCents >= 0 ? "var(--yes)" : "var(--no)";
  } else if (deadlinePassed) {
    headline = "⏳";
    sub = "Awaiting";
    accent = "var(--skip)";
  } else {
    headline = row.resolutionDeadline ? countdown(row.resolutionDeadline, nowMs).text : "—";
    sub = "Pending";
    accent = "var(--muted)";
  }

  // Subtitle: the discipline first (a card must say WHICH sport, and so must its row), then either
  // what the position costs and is worth NOW, or what the call was and how it landed.
  const lead = row.league ?? (row.category && row.category !== "other" ? cap(row.category) : null);
  const detail = settled
    ? `Your call ${row.sideLabel}${row.outcome ? ` · ${row.outcome}` : ""}`
    : `${cents(row.lockedPriceBp)} · ${usd(row.stakeCents)} stake${live ? ` · now ${cents(live.priceBp)}` : ""}${
        row.resolutionDeadline && !deadlinePassed ? ` · ⏱ ${countdown(row.resolutionDeadline, nowMs).text}` : ""
      }`;

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
        style={{ display: "flex", gap: 11, padding: "12px 13px", cursor: "pointer" }}
      >
        <div
          style={{
            minWidth: 36, minHeight: 36, maxWidth: 84, padding: "0 7px", borderRadius: 10,
            background: `color-mix(in srgb,${sideColor} 18%,var(--panel2))`,
            display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center",
            fontFamily: "var(--df)", fontSize: 12, lineHeight: 1.05, color: sideColor, flexShrink: 0,
            overflow: "hidden",
          }}
        >
          {row.sideLabel.length > 11 ? row.sideLabel.slice(0, 10) + "…" : row.sideLabel}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* The question wraps — and open, it stops being clipped at all. */}
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.25, textWrap: "pretty", display: "-webkit-box", WebkitLineClamp: open ? "unset" : 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {row.question}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
            {lead ? <span style={{ color: "var(--muted)" }}>{lead} · </span> : null}
            {detail}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: accent }}>{headline}</div>
          <div style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: accent, fontWeight: 700, marginTop: 2 }}>{sub}</div>
          {row.shards ? <div style={{ fontSize: 10, color: "var(--gold)", marginTop: 2 }}>+{row.shards} ◆</div> : null}
        </div>
        {/* Selling out is the other half of owning a position. The click is stopped: selling must
            never be a side effect of opening a row to read it. */}
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
              margin: 0, font: "inherit", flexShrink: 0, alignSelf: "center",
              padding: "7px 10px", borderRadius: 10,
              background: armed ? "var(--gold)" : "transparent",
              color: armed ? "#1a1205" : "var(--muted)",
              border: "1px solid " + (armed ? "var(--gold)" : "var(--line)"),
              fontWeight: 700, fontSize: 11,
              cursor: closing ? "default" : "pointer",
              opacity: closing ? 0.5 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {/* The confirm names the money: what comes back and whether that is a gain or a loss. */}
            {closing
              ? "Selling…"
              : armed
                ? live
                  ? `Sell ${usd(live.proceedsCents)} (${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)})?`
                  : "Sell now?"
                : "Close"}
          </button>
        ) : null}
        <div style={{ flexShrink: 0, alignSelf: "center", color: "var(--muted)", fontSize: 10, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</div>
      </div>

      {open ? (
        <div style={{ borderTop: "1px solid var(--line)", padding: "10px 13px 12px", display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", fontSize: 11, lineHeight: 1.35 }}>
          {lead ? <Detail k="Market" v={lead} /> : null}
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
          {row.resolutionDeadline ? <Detail k={settled ? "Resolved" : "Resolves"} v={when(row.resolutionDeadline)} /> : null}
          {row.settledAt ? <Detail k="Settled" v={when(row.settledAt)} /> : null}
          {row.outcome ? <Detail k="Outcome" v={row.outcome} /> : null}
          {settled ? <Detail k="Result" v={`${sub} · ${headline}`} color={accent} /> : null}
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
