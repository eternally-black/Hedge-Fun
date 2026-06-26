"use client";

import { useEffect, useMemo, useReducer } from "react";
import type { ResultRow } from "@/lib/api-types";
import { catOfResult, resultMeta } from "../ui";

// ─── Results Reveal — the dopamine peak ──────────────────────────────────────────────────────────
// Plays on app open, before the deck, replaying what resolved while the user was away. Three phases:
//   aggregate → featured cards (≤5, peak-end ordered) → summary.
// Persistent Skip ✕ exits to the deck at any point. Finishing (or skipping) is the parent's job via
// onDone/onSkip; only finishing should clear the unread badge (skip preserves it as a safety net).
//
// React notes:
//   • phase machine is a useReducer (atomic transitions), not a pile of useState.
//   • the 1.5s auto-advance lives in one effect keyed on phase+index, with a clean clearTimeout.
//   • peak-end order, aggregate totals, and coin-burst positions are useMemo'd so they're stable
//     across re-renders (coins must NOT re-randomize every frame, or they jump).

const AUTO_ADVANCE_MS = 1500;
const MAX_FEATURED = 5;

type Phase = "aggregate" | "cards" | "summary";
type State = { phase: Phase; i: number };
type Action = { t: "toCards" } | { t: "next"; last: number } | { t: "toSummary" };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "toCards": return { phase: "cards", i: 0 };
    case "next": return s.i >= a.last ? { phase: "summary", i: s.i } : { phase: "cards", i: s.i + 1 };
    case "toSummary": return { phase: "summary", i: s.i };
  }
}

export function RevealOverlay({
  rows,
  shards,
  shardsPerArtifact,
  onDone,
  onSkip,
}: {
  rows: ResultRow[];
  shards: number;
  shardsPerArtifact: number;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, { phase: "aggregate", i: 0 });

  // Aggregate totals over ALL rows (the reveal shows the full net, even though only ≤5 cards play).
  const agg = useMemo(() => rows.reduce(
    (a, r) => ({
      net: a.net + r.deltaCents,
      won: a.won + (r.status === "WIN" ? 1 : 0),
      lost: a.lost + (r.status === "LOSS" ? 1 : 0),
      shards: a.shards + r.shards,
    }),
    { net: 0, won: 0, lost: 0, shards: 0 },
  ), [rows]);

  // Peak-end order: play at most MAX_FEATURED cards, ending on the biggest win so the sequence
  // climaxes. Pick the top WIN by delta as the finale; fill the rest with the most recent others.
  const featured = useMemo(() => peakEndOrder(rows, MAX_FEATURED), [rows]);

  const last = featured.length - 1;

  // Auto-advance through the featured cards. One timer per (phase, index); cleared on change/unmount.
  useEffect(() => {
    if (state.phase !== "cards") return;
    const id = window.setTimeout(() => dispatch({ t: "next", last }), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(id);
  }, [state.phase, state.i, last]);

  const tap = () => {
    if (state.phase === "aggregate") dispatch({ t: "toCards" });
    else if (state.phase === "cards") dispatch({ t: "next", last });
  };

  const netPositive = agg.net >= 0;
  const netStr = (netPositive ? "+$" : "−$") + Math.abs(Math.round(agg.net / 100)).toLocaleString("en-US");
  const netColor = netPositive ? "var(--yes)" : "var(--no)";
  const shardPct = Math.round((shards / shardsPerArtifact) * 100);
  const shardsLeft = Math.max(0, shardsPerArtifact - shards);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 88, overflow: "hidden", background: "var(--bg)" }}>
      {/* persistent skip — exits to the deck, badge preserved */}
      <div onClick={onSkip} style={{ position: "absolute", top: 14, right: 16, zIndex: 8, display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", border: "1px solid var(--line)", padding: "7px 13px 7px 14px", borderRadius: 24, cursor: "pointer", color: "var(--muted)", fontSize: 12, fontWeight: 700 }}>
        Skip <span style={{ fontSize: 15, lineHeight: 1 }}>✕</span>
      </div>

      {state.phase === "aggregate" && (
        <div onClick={tap} style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 30, textAlign: "center", cursor: "pointer", background: `radial-gradient(130% 55% at 50% 24%, color-mix(in srgb,${netColor} 22%,transparent), transparent 62%)` }}>
          <div style={{ fontSize: 11, letterSpacing: ".24em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700, animation: "hfBigIn .4s ease both" }}>While you were away</div>
          <div style={{ fontFamily: "var(--df)", fontSize: 84, lineHeight: 0.82, marginTop: 16, color: netColor, textShadow: `0 0 46px color-mix(in srgb,${netColor} 45%,transparent)`, animation: "hfBigIn .4s .05s ease both" }}>{netStr}</div>
          <div style={{ fontSize: 12, letterSpacing: ".04em", color: "var(--muted)", marginTop: 6, animation: "hfBigIn .4s .1s ease both" }}>net virtual P&amp;L · {rows.length} call{rows.length === 1 ? "" : "s"} settled</div>
          <div style={{ display: "flex", gap: 9, marginTop: 28, animation: "hfBigIn .4s .18s ease both" }}>
            <AggTile value={String(agg.won)} label="Won" color="var(--yes)" />
            <AggTile value={String(agg.lost)} label="Lost" color="var(--no)" />
            <AggTile value={`+${agg.shards} ◆`} label="Shards" color="var(--gold)" />
          </div>
          <div style={{ marginTop: 36, fontSize: 13, color: "var(--text)", fontWeight: 700, background: "var(--panel)", border: "1px solid var(--line)", padding: "12px 20px", borderRadius: 24, animation: "hfPulse 2s ease-in-out infinite" }}>Tap to relive your calls →</div>
        </div>
      )}

      {state.phase === "cards" && featured[state.i] && (
        <div onClick={tap} style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", cursor: "pointer" }}>
          <div style={{ display: "flex", gap: 5, justifyContent: "center", padding: "52px 46px 0" }}>
            {featured.map((_, k) => <div key={k} style={{ flex: 1, height: 3, borderRadius: 3, background: k <= state.i ? "var(--text)" : "var(--line)", transition: "background .3s" }} />)}
          </div>
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "14px 22px", minHeight: 0 }}>
            <RevealCard key={state.i} row={featured[state.i]!} />
          </div>
          <div style={{ textAlign: "center", paddingBottom: 30, color: "var(--muted)", fontSize: 12 }}>Tap anywhere to continue · {state.i + 1} / {featured.length}</div>
        </div>
      )}

      {state.phase === "summary" && (
        <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "64px 22px 26px", display: "flex", flexDirection: "column" }}>
          <div style={{ textAlign: "center", animation: "hfBigIn .4s ease both" }}>
            <div style={{ fontSize: 44 }}>🎉</div>
            <div style={{ fontFamily: "var(--df)", fontSize: 40, lineHeight: 1, marginTop: 6 }}>That&apos;s a wrap</div>
            <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>Everything&apos;s already credited to your balance.</div>
          </div>

          {/* Shard-chain card only when shards were actually collected this batch — no "+0" panel. */}
          {agg.shards > 0 && (
            <div style={{ marginTop: 22, background: "linear-gradient(150deg,color-mix(in srgb,var(--gold) 18%,var(--panel)),var(--panel))", border: "1px solid color-mix(in srgb,var(--gold) 36%,var(--line))", borderRadius: 18, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 20 }}>◆</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--gold)" }}>+{agg.shards} shard{agg.shards === 1 ? "" : "s"} collected</span>
                <span style={{ marginLeft: "auto", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, color: "var(--gold)" }}>{shards}/{shardsPerArtifact}</span>
              </div>
              <div style={{ marginTop: 10, height: 9, borderRadius: 6, background: "var(--panel2)", overflow: "hidden", border: "1px solid var(--line)" }}>
                <div style={{ height: "100%", width: `${shardPct}%`, background: "linear-gradient(90deg,#c98a1e,var(--gold))" }} />
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>{shardsLeft} more to forge your next artifact</div>
            </div>
          )}

          <div style={{ flex: 1, minHeight: 18 }} />
          <div onClick={onDone} style={{ marginTop: 18, background: "linear-gradient(135deg,var(--energy),color-mix(in srgb,var(--energy) 55%,#000))", color: "#fff", fontFamily: "var(--df)", fontSize: 26, textAlign: "center", padding: 16, borderRadius: 18, cursor: "pointer", boxShadow: "0 14px 30px -8px color-mix(in srgb,var(--energy) 60%,transparent)" }}>Continue →</div>
        </div>
      )}
    </div>
  );
}

function AggTile({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div style={{ background: `color-mix(in srgb,${color} 14%,var(--panel))`, border: `1px solid color-mix(in srgb,${color} 36%,var(--line))`, borderRadius: 16, padding: "12px 18px" }}>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 24, color }}>{value}</div>
      <div style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function RevealCard({ row }: { row: ResultRow }) {
  const cat = catOfResult(row);
  const m = resultMeta(row.status);
  const isWin = row.status === "WIN";
  const isVoid = row.status === "PUSH";
  const badge = isWin ? "WON" : isVoid ? "REFUNDED" : "MISSED";
  const d = Math.round(row.deltaCents / 100);
  const deltaStr = isVoid ? "$100" : d >= 0 ? `+$${d}` : `−$${Math.abs(d)}`;
  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  // Gold shard line only when shards were actually collected. An over-cap win (shards=0) still won
  // the payout, so show that — never "+0 ◆ collected".
  const gotShards = isWin && row.shards > 0;
  const foot = gotShards
    ? `+${row.shards} ◆ shard${row.shards === 1 ? "" : "s"} collected`
    : isWin ? "Nice call — virtual payout banked"
    : isVoid ? "Market voided · your $100 stake was returned"
    : "So close — no payout this time";

  // Coin burst on a win — 14 coins, positions fixed once per card (useMemo keyed by row.id).
  const coins = useMemo(
    () => (isWin ? Array.from({ length: 14 }, (_, k) => ({
      key: k,
      left: `${8 + Math.random() * 84}%`,
      size: `${15 + Math.random() * 13}px`,
      cx: `${(Math.random() * 120 - 60).toFixed(0)}px`,
      anim: `hfCoin ${(1 + Math.random() * 0.7).toFixed(2)}s ${(Math.random() * 0.35).toFixed(2)}s ease-out forwards`,
    })) : []),
    [isWin, row.id], // eslint-disable-line react-hooks/exhaustive-deps -- positions fixed per card; isWin/id are the identity
  );

  return (
    <div style={{ position: "relative", width: 300, maxWidth: "100%", borderRadius: 26, padding: 20, background: `radial-gradient(120% 80% at 80% 0%, color-mix(in srgb,${m.accent} 16%,transparent), transparent 58%), linear-gradient(170deg, var(--panel2), var(--panel))`, border: `1px solid color-mix(in srgb,${m.accent} 45%, var(--line))`, boxShadow: isWin ? "0 0 52px -6px color-mix(in srgb,var(--yes) 65%,transparent)" : "0 22px 44px -20px rgba(0,0,0,.7)", animation: "hfFlipIn .5s cubic-bezier(.3,1.1,.5,1) both" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.35)", padding: "5px 10px", borderRadius: 18, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: cat.color }} />{cat.label}
        </div>
        <div style={{ marginLeft: "auto", fontFamily: "var(--df)", fontSize: 18, color: m.accent, letterSpacing: ".04em" }}>{badge}</div>
      </div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 16, lineHeight: 1.3 }}>{row.question}</div>
      <div style={{ fontFamily: "var(--df)", fontSize: 31, lineHeight: 1.03, color: "#fff", marginTop: 6 }}>{row.outcome}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>Your call</span>
        <span style={{ fontFamily: "var(--df)", fontSize: 15, color: sideColor, border: `2px solid ${sideColor}`, borderRadius: 8, padding: "1px 9px" }}>{row.side}</span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginTop: 12 }}>
        <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 34, color: m.accent, lineHeight: 1 }}>{deltaStr}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>{isVoid ? "returned" : isWin ? "virtual payout" : "virtual loss"}</div>
      </div>
      <div style={{ marginTop: 15, paddingTop: 14, borderTop: "1px solid var(--line)", fontSize: 12, color: gotShards ? "var(--gold)" : "var(--muted)", fontWeight: gotShards ? 700 : 500 }}>{foot}</div>

      {coins.length > 0 && (
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", borderRadius: 26 }}>
          {coins.map((c) => (
            <div key={c.key} style={{ position: "absolute", left: c.left, bottom: "40%", fontSize: c.size, ["--cx" as string]: c.cx, animation: c.anim }}>🪙</div>
          ))}
        </div>
      )}
    </div>
  );
}

// Peak-end ordering: ≤max cards ending on the biggest win. If there's a win, it goes last; the rest
// fill from the front by recency (rows arrive newest-first). Pure + tested (test-reveal-order.ts).
export function peakEndOrder(rows: ResultRow[], max: number): ResultRow[] {
  if (rows.length <= 1) return rows.slice();
  const wins = rows.filter((r) => r.status === "WIN");
  const finale = wins.length ? wins.reduce((b, r) => (r.deltaCents > b.deltaCents ? r : b)) : null;
  const rest = rows.filter((r) => r !== finale).slice(0, max - (finale ? 1 : 0));
  return finale ? [...rest, finale] : rest;
}
