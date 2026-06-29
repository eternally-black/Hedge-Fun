"use client";

import { useEffect, useState } from "react";
import type { BetSide, FootballMarketCard, FootballMatchResponse, TickerResponse, TickerRow } from "@/lib/api-types";
import { type Me, kickoffLabel } from "../ui";
import { MarketCard, useMarketBet } from "./MarketCard";

// The World Cup hub: a live/upcoming/recent scoreboard fed by the same server-cached TxLINE snapshot
// as the global ticker. Tapping a match opens its relevant binary markets ("{team} to win?" + Over/
// Under goals), rendered as feed-style blocks and bet with the SAME points-off flow as the лента
// (useMarketBet → /api/feed/bet). Football O/U cards also still mix into the main Deck — this view
// just lets you go deep on one match without fragmenting the deck.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
const POLL_MS = 10_000;

export function FootballScreen({
  api,
  me,
  onRefreshMe,
  onToast,
  onTopup,
}: {
  api: Api;
  me: Me | null;
  onRefreshMe: () => void;
  onToast: (msg: string) => void;
  onTopup: () => void;
}) {
  const [rows, setRows] = useState<TickerRow[] | null>(null);
  const [selected, setSelected] = useState<TickerRow | null>(null);

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

  if (selected) {
    return (
      <MatchDetail
        api={api}
        me={me}
        row={selected}
        onBack={() => setSelected(null)}
        onRefreshMe={onRefreshMe}
        onToast={onToast}
        onTopup={onTopup}
      />
    );
  }

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 20px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>⚽ World Cup</div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Live scores · Solana-anchored</div>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
        <b style={{ color: "var(--text)" }}>Tap a match</b> to bet its win &amp; goals markets — or catch the cards in the{" "}
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
            <MatchRow key={r.fixtureId} row={r} onOpen={() => setSelected(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MatchRow({ row, onOpen }: { row: TickerRow; onOpen: () => void }) {
  const score = row.homeGoals == null ? "vs" : `${row.homeGoals}–${row.awayGoals}`;
  const status = row.live ? `● ${row.phase || "LIVE"}` : row.ended ? "FT" : kickoffLabel(row.kickoff);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", font: "inherit", cursor: "pointer",
        background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "11px 13px", fontSize: 13, color: "var(--text)",
      }}
    >
      <span style={{ fontFamily: "var(--nf)", fontSize: 10, fontWeight: 700, color: row.live ? "var(--no)" : "var(--muted)", width: 78, flexShrink: 0 }}>
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
      <span aria-hidden="true" style={{ color: "var(--muted)", flexShrink: 0, fontSize: 16 }}>›</span>
    </button>
  );
}

// One match's betting view: the relevant binary markets (win + goals) as feed-style blocks. Markets
// come from /api/football/match (cached TXODDS rows); betting reuses the лента's points-off flow.
function MatchDetail({
  api,
  me,
  row,
  onBack,
  onRefreshMe,
  onToast,
  onTopup,
}: {
  api: Api;
  me: Me | null;
  row: TickerRow;
  onBack: () => void;
  onRefreshMe: () => void;
  onToast: (msg: string) => void;
  onTopup: () => void;
}) {
  const [cards, setCards] = useState<FootballMarketCard[] | null>(null);
  const { placed, placeBet, seedPlaced } = useMarketBet({ api, me, onRefreshMe, onToast, onTopup });
  // Shared 15s clock for the cards' countdowns (Date.now() out of render; lazy init = correct first paint).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    api(`/api/football/match?fixtureId=${encodeURIComponent(row.fixtureId)}`)
      .then((r) => {
        if (!alive) return;
        const cs = (r as FootballMatchResponse).cards;
        setCards(cs);
        // Pre-mark markets the user already bet (carried by the endpoint) so they show locked.
        seedPlaced(cs.flatMap((c) => (c.placedSide ? ([[c.id, c.placedSide]] as [string, BetSide][]) : [])));
      })
      .catch(() => {
        if (alive) setCards([]);
      });
    return () => {
      alive = false;
    };
  }, [api, row.fixtureId, seedPlaced]);

  const score = row.homeGoals == null ? "vs" : `${row.homeGoals}–${row.awayGoals}`;
  const status = row.live ? `● ${row.phase || "LIVE"}` : row.ended ? "FT" : kickoffLabel(row.kickoff);

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 24px" }}>
      <button
        type="button"
        onClick={onBack}
        style={{ background: "none", border: "none", padding: "4px 0", margin: 0, font: "inherit", cursor: "pointer", color: "var(--muted)", fontSize: 13 }}
      >
        ‹ All matches
      </button>

      {/* match header */}
      <div style={{ marginTop: 6, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 16, padding: "12px 14px" }}>
        <div style={{ fontFamily: "var(--nf)", fontSize: 10, fontWeight: 700, letterSpacing: ".04em", color: row.live ? "var(--no)" : "var(--muted)" }}>
          {status}
        </div>
        <div style={{ marginTop: 4, fontFamily: "var(--df)", fontSize: 22, lineHeight: 1.1 }}>
          {row.home}
          <span style={{ fontFamily: "var(--nf)", color: "var(--muted)", margin: "0 8px" }}>{score}</span>
          {row.away}
        </div>
      </div>

      {cards == null ? (
        <div style={{ textAlign: "center", marginTop: 60, color: "var(--muted)" }}>Loading markets…</div>
      ) : cards.length === 0 ? (
        <div style={{ textAlign: "center", marginTop: 60, color: "var(--muted)", fontSize: 13 }}>
          No betting markets for this match right now — the data feed isn&apos;t publishing odds for it.
        </div>
      ) : (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          {cards.map((c) => (
            <div key={c.id} style={{ height: 300, padding: "6px 0", boxSizing: "border-box" }}>
              {/* liveBetting: football deadlines are a synthetic settle mark, so don't lead-time-gate in-play markets */}
              <MarketCard card={c} placedSide={placed.get(c.id)} nowMs={nowMs} onBet={placeBet} liveBetting />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
