"use client";

import { useEffect, useRef, useState } from "react";
import type { TickerResponse, TickerRow } from "@/lib/api-types";
import { kickoffLabel } from "../ui";

// Global live football ticker (бегущая строка). Polls /api/football/ticker (server-cached TxLine)
// and CSS-marquees the rows. The cache is real-time-ish via the 5s poll, so a goal/odds move shows
// within ~10s and flashes. React best-practices applied: items derived during render (not stored via
// effect), transient cross-poll bookkeeping in refs, functional setState, ternary conditionals.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
type FlashKind = "goal" | "up" | "down";

const POLL_MS = 5000;
const FLASH_MS = 2600;
const FLASH_COLOR: Record<FlashKind, string> = { goal: "var(--gold)", up: "var(--yes)", down: "var(--no)" };

export function Ticker({ api }: { api: Api }) {
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [flash, setFlash] = useState<Record<string, FlashKind>>({});
  // Transient cross-poll state — refs so the per-poll diff/timer bookkeeping never triggers a render
  // (rerender-use-ref-transient-values). Only `rows`/`flash` (what's actually drawn) are state.
  const prev = useRef(new Map<string, { score: string; ou: number | null }>());
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    let alive = true;

    const expireFlash = (id: string) => {
      const existing = timers.current.get(id);
      if (existing) window.clearTimeout(existing);
      timers.current.set(
        id,
        window.setTimeout(() => {
          setFlash((f) => {
            if (!(id in f)) return f;
            const rest = { ...f };
            delete rest[id];
            return rest;
          });
        }, FLASH_MS),
      );
    };

    const load = async () => {
      let res: TickerResponse;
      try {
        res = (await api("/api/football/ticker")) as TickerResponse;
      } catch {
        return; // best-effort: keep the last rows so a blip never blanks the strip
      }
      if (!alive) return;

      // Diff vs the previous poll to flash goals / odds moves — this is a reaction to async data
      // (an event), not derivable during render, so it lives here and writes transient state.
      const fresh: Record<string, FlashKind> = {};
      for (const r of res.rows) {
        const score = `${r.homeGoals ?? "-"}-${r.awayGoals ?? "-"}`;
        const p = prev.current.get(r.fixtureId);
        if (p) {
          if (p.score !== score && r.homeGoals != null) fresh[r.fixtureId] = "goal";
          else if (p.ou != null && r.over25Pct != null && r.over25Pct !== p.ou)
            fresh[r.fixtureId] = r.over25Pct > p.ou ? "up" : "down";
        }
        prev.current.set(r.fixtureId, { score, ou: r.over25Pct });
      }

      setRows(res.rows);
      const ids = Object.keys(fresh);
      if (ids.length > 0) {
        setFlash((f) => ({ ...f, ...fresh }));
        for (const id of ids) expireFlash(id);
      }
    };

    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    const pending = timers.current;
    return () => {
      alive = false;
      window.clearInterval(poll);
      for (const t of pending.values()) window.clearTimeout(t);
      pending.clear();
    };
  }, [api]);

  if (rows.length === 0) return null; // graceful: no live/upcoming football → no strip at all

  // Derived during render (rerender-derived-state-no-effect): duplicate the row set for a seamless
  // marquee loop, and scale duration to content so scroll speed stays steady as the count changes.
  const items = [...rows, ...rows];
  const durationS = Math.max(24, rows.length * 5);

  return (
    <div
      className="hf-ticker"
      aria-label="Live football"
      style={{ flex: "none", borderBottom: "1px solid var(--line)", background: "rgba(10,10,15,.6)" }}
    >
      <div className="hf-ticker-track" style={{ animationDuration: `${durationS}s` }}>
        {items.map((r, i) => (
          // i < rows.length = first copy, else the duplicate — a stable key per (fixture, copy) so
          // changing rows don't remount items / churn the marquee.
          <TickerItem key={`${r.fixtureId}-${i >= rows.length ? 1 : 0}`} row={r} flash={flash[r.fixtureId]} />
        ))}
      </div>
    </div>
  );
}

function TickerItem({ row, flash }: { row: TickerRow; flash?: FlashKind }) {
  const score = row.homeGoals == null ? null : `${row.homeGoals}–${row.awayGoals}`;
  const status = row.live ? row.phase || "LIVE" : row.ended ? "FT" : kickoffLabel(row.kickoff);
  const arrow = flash === "up" ? "▲" : flash === "down" ? "▼" : "";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 16px",
        fontSize: 12,
        borderRight: "1px solid var(--line)",
        background: flash === "goal" ? "color-mix(in srgb, var(--gold) 22%, transparent)" : "transparent",
        transition: "background .3s ease",
      }}
    >
      <span
        style={{
          fontFamily: "var(--nf)",
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: ".04em",
          color: row.live ? "var(--no)" : "var(--muted)",
        }}
      >
        {row.live ? "● " : ""}
        {status}
      </span>
      <span style={{ fontWeight: 700, color: "var(--text)" }}>
        {row.home}
        {score ? (
          <span style={{ fontFamily: "var(--nf)", margin: "0 6px" }}>{score}</span>
        ) : (
          <span style={{ margin: "0 6px", color: "var(--muted)" }}>vs</span>
        )}
        {row.away}
      </span>
      {row.over25Pct != null ? (
        <span style={{ fontFamily: "var(--nf)", fontSize: 11, color: arrow ? FLASH_COLOR[flash as FlashKind] : "var(--muted)" }}>
          O2.5 {Math.round(row.over25Pct)}% {arrow}
        </span>
      ) : null}
    </span>
  );
}
