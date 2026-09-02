"use client";

import { useEffect, useRef, useState } from "react";
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
  startsAt?: string | null; // kick-off; equal to the deadline on a match — see below
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
  const armTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(armTimer.current), []);

  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  const settled = row.status !== "PENDING";
  // Live numbers belong to an open position that can still be sold — a settled row's money is done.
  const live = !settled && row.closable ? exitQuote : undefined;
  const deadlinePassed = !!row.resolutionDeadline && new Date(row.resolutionDeadline).getTime() <= nowMs;
  // For a match, the "deadline" IS the kick-off: Gamma's endDate equals gameStartTime on every live
  // sport market, and the thing then trades in-play for the length of the game and resolves after.
  // So once that clock runs out the game is ON, not overdue — saying "awaiting result soon" there
  // promised a result two hours early, which is exactly how a settled market reads when it is late.
  const kickoffClock =
    !!row.startsAt &&
    !!row.resolutionDeadline &&
    Math.abs(new Date(row.startsAt).getTime() - new Date(row.resolutionDeadline).getTime()) < 60_000;

  // Right column: what this call is worth. Two lines only when there IS money to state — settled
  // pays, or a live quote says what the position would fetch. A row that is merely waiting gets one
  // muted line: it was competing for width with the question and winning, and "⏳" stacked over
  // "AWAITING" said one thing twice.
  let headline: string | null = null, sub: string | null = null, accent = "var(--muted)";
  if (settled) {
    const m = resultMeta(row.status as "WIN" | "LOSS" | "PUSH");
    headline = deltaStr(row.status as "WIN" | "LOSS" | "PUSH", row.pnlCents ?? 0);
    sub = m.tag;
    accent = m.accent;
  } else if (live) {
    headline = `≈ ${usd(live.proceedsCents)}`;
    sub = `${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)}`; // usd() prints its own minus
    accent = live.pnlCents >= 0 ? "var(--yes)" : "var(--no)";
  }
  // A row that is only waiting gets NO right column: the wait is already stated in the subtitle
  // ("⏱ 7m 30s", or "awaiting result" once the clock is spent), and a second copy of it was taking
  // the width the question needed — "MGS Panserraikos vs. APS…" is not a market anyone recognises.

  // Subtitle: the discipline first (a card must say WHICH sport, and so must its row), then either
  // what the position costs and is worth NOW, or what the call was and how it landed.
  const lead = row.league ?? (row.category && row.category !== "other" ? cap(row.category) : null);
  const detail = settled
    ? `Your call ${row.sideLabel}${row.outcome ? ` · ${row.outcome}` : ""}`
    : `${cents(row.lockedPriceBp)} · ${usd(row.stakeCents)} stake${live ? ` · now ${cents(live.priceBp)}` : ""}${
        !row.resolutionDeadline
          ? ""
          : deadlinePassed
            ? kickoffClock ? " · in play" : " · ⏳ awaiting result"
            : ` · ⏱ ${kickoffClock ? "starts in " : ""}${countdown(row.resolutionDeadline, nowMs).text}`
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
            minWidth: 36, height: 36, maxWidth: 84, padding: "0 7px", borderRadius: 10, alignSelf: "flex-start",
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
        {headline ? (
          <div style={{ textAlign: "right", flexShrink: 0, alignSelf: "flex-start" }}>
            <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: accent, whiteSpace: "nowrap" }}>{headline}</div>
            {sub ? <div style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: accent, fontWeight: 700, marginTop: 2 }}>{sub}</div> : null}
            {row.shards ? <div style={{ fontSize: 10, color: "var(--gold)", marginTop: 2 }}>+{row.shards} ◆</div> : null}
          </div>
        ) : null}
        <div style={{ flexShrink: 0, alignSelf: "center", color: "var(--muted)", fontSize: 10, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</div>
      </div>

      {/* Selling out is the other half of owning a position, and it gets its own line: crammed into
          the header it took the width the question needed, and "MGS Panserraikos vs. APS…" is not a
          market anyone can identify. Outside the header, the click cannot toggle the row either. */}
      {onClosePosition && row.closable ? (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 13px 11px" }}>
          <button
            type="button"
            disabled={closing}
            onClick={() => {
              if (closing) return;
              if (!armed) {
                setArmed(true);
                armTimer.current = window.setTimeout(() => setArmed(false), 4000);
                return;
              }
              window.clearTimeout(armTimer.current);
              setArmed(false);
              void onClosePosition(row);
            }}
            style={{
              margin: 0, font: "inherit",
              padding: "7px 12px", borderRadius: 10,
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
        </div>
      ) : null}

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
          {row.resolutionDeadline ? (
            <Detail k={kickoffClock ? "Kick-off" : settled ? "Resolved" : "Resolves"} v={when(row.resolutionDeadline)} />
          ) : null}
          {row.settledAt ? <Detail k="Settled" v={when(row.settledAt)} /> : null}
          {row.outcome ? <Detail k="Outcome" v={row.outcome} /> : null}
          {settled && headline ? <Detail k="Result" v={`${sub ?? ""} · ${headline}`.trim()} color={accent} /> : null}
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
