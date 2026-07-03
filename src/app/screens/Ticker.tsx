"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { TickerResponse, TickerRow } from "@/lib/api-types";
import { deriveTickerEvents, type RowFlash, type TickerBaseline, type TickerEvent } from "@/lib/ticker-events";
import { kickoffLabel } from "../ui";

// Global live football ticker (бегущая строка). Polls /api/football/ticker (server-cached TxLine) and
// CSS-marquees the rows. On each 5s poll it diffs vs the previous one (deriveTickerEvents): a goal or a
// threshold odds move becomes a broadcast banner that pops to the front of the strip and fades; every
// O2.5 move also flashes the row arrow. React best-practices: banner derived during render (events[0]),
// transient cross-poll bookkeeping in refs, functional setState so deferred expiry never reads a stale
// list, memoized items/banner so frequent event ticks don't rebuild the whole strip.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

const POLL_MS = 5000;
const FLASH_MS = 2600; // per-row arrow/glow lifetime
const EVENT_MS = 7000; // broadcast banner lifetime
const SWING_OPTS = { swingMin: 3 }; // ponytail: 3pp threshold to broadcast a no-goal odds swing; tune if noisy/quiet
const FLASH_COLOR: Record<RowFlash, string> = { goal: "var(--gold)", up: "var(--yes)", down: "var(--no)" };

type ActiveEvent = TickerEvent & { id: number };

export function Ticker({ api, onOpenMatch }: { api: Api; onOpenMatch: (row: TickerRow) => void }) {
  const [rows, setRows] = useState<TickerRow[]>([]);
  const [flash, setFlash] = useState<Record<string, RowFlash>>({});
  const [events, setEvents] = useState<ActiveEvent[]>([]);
  // Transient cross-poll state — refs so the per-poll diff/timer bookkeeping never triggers a render.
  const prev = useRef(new Map<string, TickerBaseline>());
  const flashTimers = useRef(new Map<string, number>());
  const eventTimers = useRef(new Map<number, number>());
  const idSeq = useRef(0);

  useEffect(() => {
    let alive = true;

    const expireFlash = (id: string) => {
      const existing = flashTimers.current.get(id);
      if (existing) window.clearTimeout(existing);
      flashTimers.current.set(
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

    const applyFlash = (f: Record<string, RowFlash>) => {
      const ids = Object.keys(f);
      if (ids.length === 0) return;
      setFlash((cur) => ({ ...cur, ...f }));
      for (const id of ids) expireFlash(id);
    };

    const emitEvents = (list: TickerEvent[]) => {
      if (list.length === 0) return;
      const active: ActiveEvent[] = list.map((e) => ({ ...e, id: ++idSeq.current }));
      setEvents((es) => [...active, ...es]); // newest-first → events[0] is the shown banner
      for (const e of active) {
        eventTimers.current.set(
          e.id,
          window.setTimeout(() => {
            setEvents((es) => es.filter((x) => x.id !== e.id)); // functional: never a stale list
            eventTimers.current.delete(e.id);
          }, EVENT_MS),
        );
      }
    };

    const load = async () => {
      let res: TickerResponse;
      try {
        res = (await api("/api/football/ticker")) as TickerResponse;
      } catch {
        return; // best-effort: keep the last rows so a blip never blanks the strip
      }
      if (!alive) return;
      // Diff vs the previous poll — a reaction to async data (an event), not derivable during render,
      // so it lives here. deriveTickerEvents mutates `prev` to the new baseline in the same pass.
      const { events: evs, flash: fl } = deriveTickerEvents(prev.current, res.rows, SWING_OPTS);
      setRows(res.rows);
      applyFlash(fl);
      emitEvents(evs);
    };

    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);

    // dev-only: press "g"/"o" to fabricate a goal / odds-swing banner and observe it render + fade.
    // ponytail: dev-only, guarded, never ships — real events come from the poll diff above.
    let onKey: ((e: KeyboardEvent) => void) | undefined;
    if (process.env.NODE_ENV !== "production") {
      onKey = (e) => {
        if (e.key === "g")
          emitEvents([{ fixtureId: "demo", kind: "goal", text: "⚽ GOAL · 2H — Argentina 2–1 France · O2.5 68%▲ · Argentina win 72%▲" }]);
        if (e.key === "o")
          emitEvents([{ fixtureId: "demo", kind: "swing", text: "📈 Brazil v Spain · O2.5 61%▲ · Spain win 55%▼" }]);
      };
      window.addEventListener("keydown", onKey);
    }

    const pendingFlash = flashTimers.current;
    const pendingEvent = eventTimers.current;
    return () => {
      alive = false;
      window.clearInterval(poll);
      if (onKey) window.removeEventListener("keydown", onKey);
      for (const t of pendingFlash.values()) window.clearTimeout(t);
      for (const t of pendingEvent.values()) window.clearTimeout(t);
      pendingFlash.clear();
      pendingEvent.clear();
    };
  }, [api]);

  // Derived during render: duplicate the row set for a seamless marquee loop and scale duration to
  // content. Memoized on rows/rows.length so frequent event/flash ticks don't re-alloc the 2×N array.
  const items = useMemo(() => [...rows, ...rows], [rows]);
  const durationS = useMemo(() => Math.max(18, rows.length * 4), [rows.length]);
  const banner = events[0] ?? null; // shown banner derived from state (rerender-derived-state-no-effect)

  if (rows.length === 0) return null; // graceful: no live/upcoming football → no strip at all

  return (
    <div
      className="hf-ticker"
      aria-label="Live football"
      style={{ flex: "none", borderBottom: "1px solid var(--line)", background: "rgba(10,10,15,.6)" }}
    >
      {banner ? <EventBanner key={banner.id} event={banner} /> : null}
      <div className="hf-ticker-track" style={{ animationDuration: `${durationS}s` }}>
        {items.map((r, i) => (
          // i < rows.length = first copy, else the duplicate — a stable key per (fixture, copy) so
          // changing rows don't remount items / churn the marquee.
          <TickerItem key={`${r.fixtureId}-${i >= rows.length ? 1 : 0}`} row={r} flash={flash[r.fixtureId]} onOpen={onOpenMatch} />
        ))}
      </div>
    </div>
  );
}

const EventBanner = memo(function EventBanner({ event }: { event: ActiveEvent }) {
  const accent = event.kind === "goal" ? "var(--gold)" : "var(--yes)";
  return (
    <div className="hf-ticker-event" style={{ borderLeftColor: accent }} aria-live="polite" role="status">
      <span style={{ fontFamily: "var(--nf)", fontSize: 12, fontWeight: 700, letterSpacing: ".02em", color: "var(--text)" }}>
        {event.text}
      </span>
    </div>
  );
});

const TickerItem = memo(function TickerItem({
  row,
  flash,
  onOpen,
}: {
  row: TickerRow;
  flash?: RowFlash;
  onOpen: (row: TickerRow) => void;
}) {
  const score = row.homeGoals == null ? null : `${row.homeGoals}–${row.awayGoals}`;
  const status = row.live ? row.phase || "LIVE" : row.ended ? "FT" : kickoffLabel(row.kickoff);
  const arrow = flash === "up" ? "▲" : flash === "down" ? "▼" : "";
  return (
    <button
      type="button"
      onClick={() => onOpen(row)}
      aria-label={`Bet ${row.home} vs ${row.away}`}
      title="Open markets"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 16px",
        margin: 0,
        font: "inherit",
        color: "var(--text)",
        cursor: "pointer",
        fontSize: 12,
        border: "none",
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
        <span style={{ fontFamily: "var(--nf)", fontSize: 11, color: arrow ? FLASH_COLOR[flash as RowFlash] : "var(--muted)" }}>
          O2.5 {Math.round(row.over25Pct)}% {arrow}
        </span>
      ) : null}
    </button>
  );
});
