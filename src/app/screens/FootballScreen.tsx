"use client";

import { useEffect, useState } from "react";
import type { TickerResponse, TickerRow } from "@/lib/api-types";
import { kickoffLabel } from "../ui";

// The World Cup hub: a read-only scoreboard of live/upcoming/recent matches with the market's Over-2.5
// read, fed by the same server-cached TxLINE snapshot as the global ticker. Betting happens in the
// Deck (World Cup Over/Under cards mix into the main swipe stream) — this screen is the destination
// that makes football first-class. React best-practices: rows are async state, list derived in render.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
const POLL_MS = 10_000;

export function FootballScreen({ api }: { api: Api }) {
  const [rows, setRows] = useState<TickerRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/football/ticker")
        .then((r) => {
          if (alive) setRows((r as TickerResponse).rows);
        })
        .catch(() => {
          /* best-effort; keep last rows */
        });
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [api]);

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 20px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>⚽ World Cup</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Live scores · Solana-anchored</div>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
        Swipe <b style={{ color: "var(--text)" }}>Over/Under goals</b> cards on these matches in the{" "}
        <b style={{ color: "var(--energy)" }}>Deck ⚡</b>.
      </div>

      {rows == null ? (
        <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)" }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13 }}>
          No World Cup matches right now. Check back near kickoff.
        </div>
      ) : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => (
            <MatchRow key={r.fixtureId} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function MatchRow({ row }: { row: TickerRow }) {
  const score = row.homeGoals == null ? "vs" : `${row.homeGoals}–${row.awayGoals}`;
  const status = row.live ? `● ${row.phase || "LIVE"}` : row.ended ? "FT" : kickoffLabel(row.kickoff);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "var(--panel)",
        border: "1px solid var(--line)",
        borderRadius: 14,
        padding: "11px 13px",
        fontSize: 13,
      }}
    >
      <span
        style={{
          fontFamily: "var(--nf)",
          fontSize: 10,
          fontWeight: 700,
          color: row.live ? "var(--no)" : "var(--muted)",
          width: 78,
          flexShrink: 0,
        }}
      >
        {status}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontWeight: 700 }}>
        {row.home}
        <span style={{ fontFamily: "var(--nf)", color: "var(--muted)", margin: "0 5px" }}>{score}</span>
        {row.away}
      </span>
      {row.over25Pct != null ? (
        <span style={{ fontFamily: "var(--nf)", fontSize: 11, color: "var(--muted)", flexShrink: 0 }}>
          O2.5 <b style={{ color: "var(--text)" }}>{Math.round(row.over25Pct)}%</b>
        </span>
      ) : null}
    </div>
  );
}
