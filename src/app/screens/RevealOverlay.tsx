"use client";

import { memo, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ResultRow } from "@/lib/api-types";
import { catOfResult, resultMeta, usd } from "../ui";
import { STAKE_CENTS } from "@/lib/config";
import { useCardSwipe } from "../useCardSwipe";
import { PREVIEW_SCALE, PREVIEW_Y, RISE_MS } from "../DeckCard";

// ─── Results Reveal — the dopamine peak ──────────────────────────────────────────────────────────
// Plays on app open, before the deck, replaying what resolved while the user was away. Three phases:
//   aggregate → featured cards (≤5, peak-end ordered) → summary.
// USER-PACED: no auto-advance. Cards are a COMPACT centered deck-stack with the SAME mechanic as the
// blitz deck — the next card sits scaled-back behind the top one; the top card rises out of the stack
// on entry (hfCardRise) and swipes off in any direction (or a tap) to advance. The user is never
// rushed. The ✕ in the corner exits to the deck at any point. Finishing vs skipping is the parent's
// job (onDone/onSkip); only finishing clears the unread badge.
//
// React notes:
//   • phase machine is a useReducer (atomic transitions), not a pile of useState.
//   • gesture is the shared useCardSwipe hook + the deck's entering→rise pattern (one source, no reinvention).
//   • peak-end order, aggregate totals, and coin-burst positions are useMemo'd so they're stable
//     across re-renders (coins must NOT re-randomize every frame, or they jump).

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

  // Advance to the next card / phase. Driven by a tap OR a swipe in any direction — never a timer.
  const next = () => dispatch({ t: "next", last });

  const netPositive = agg.net >= 0;
  const netStr = (netPositive ? "+$" : "−$") + Math.abs(Math.round(agg.net / 100)).toLocaleString("en-US");
  const netColor = netPositive ? "var(--yes)" : "var(--no)";
  const shardPct = Math.round((shards / shardsPerArtifact) * 100);
  const shardsLeft = Math.max(0, shardsPerArtifact - shards);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 88, overflow: "hidden", background: "var(--bg)" }}>
      {/* persistent close — exits to the deck, badge preserved. A bold ✕ in a circle (no "Skip"
          label, no bare X that reads as the Twitter glyph on a dark field). */}
      <div onClick={onSkip} aria-label="Close" style={{ position: "absolute", top: 14, right: 16, zIndex: 8, width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.45)", backdropFilter: "blur(6px)", border: "1px solid var(--line)", cursor: "pointer", color: "var(--text)", fontSize: 20, fontWeight: 800, lineHeight: 1 }}>
        ✕
      </div>

      {state.phase === "aggregate" && (
        <div onClick={() => dispatch({ t: "toCards" })} style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 30, textAlign: "center", cursor: "pointer", background: `radial-gradient(130% 55% at 50% 24%, color-mix(in srgb,${netColor} 22%,transparent), transparent 62%)` }}>
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
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 5, justifyContent: "center", padding: "52px 46px 0" }}>
            {featured.map((_, k) => <div key={k} style={{ flex: 1, height: 3, borderRadius: 3, background: k <= state.i ? "var(--text)" : "var(--line)", transition: "background .3s" }} />)}
          </div>
          {/* A COMPACT centered deck-stack — same mechanic as the blitz deck (next card sits
              scaled-back behind the top one; swiping the top off rises the next out of the stack),
              just sized to a fixed card instead of filling the screen. */}
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0, padding: "10px 0" }}>
            <div style={{ position: "relative", width: 300, maxWidth: "calc(100% - 44px)", height: 420, maxHeight: "100%" }}>
              {featured[state.i + 1] && <RevealCardPreview key={`p${state.i}`} row={featured[state.i + 1]!} />}
              {/* keyed by index so each card remounts (fresh rise + a fresh swipe hook state) */}
              <RevealCard key={state.i} row={featured[state.i]!} onAdvance={next} />
            </div>
          </div>
          <div style={{ textAlign: "center", padding: "14px 0 30px", color: "var(--muted)", fontSize: 12 }}>Swipe or tap to continue · {state.i + 1} / {featured.length}</div>
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

// ── RevealCardFace — the card VISUALS, pure + memoized (mirrors DeckCard's CardFace). Used by both
//    the interactive top card and the preview behind it, so the next card is fully rendered (not a
//    stub) — exactly how the blitz deck does its stack. No gesture, no positioning, no coin burst
//    (that's a sibling layer in RevealCard so it can overflow above the card).
const RevealCardFace = memo(function RevealCardFace({ row }: { row: ResultRow }) {
  const cat = catOfResult(row);
  const m = resultMeta(row.status);
  const isWin = row.status === "WIN";
  const isVoid = row.status === "PUSH";
  const badge = isWin ? "WON" : isVoid ? "REFUNDED" : "MISSED";
  const d = Math.round(row.deltaCents / 100);
  const deltaStr = isVoid ? usd(STAKE_CENTS) : d >= 0 ? `+$${d}` : `−$${Math.abs(d)}`;
  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  // Gold shard line only when shards were actually collected. An over-cap win (shards=0) still won
  // the payout, so show that — never "+0 ◆ collected".
  const gotShards = isWin && row.shards > 0;
  const foot = gotShards
    ? `+${row.shards} ◆ shard${row.shards === 1 ? "" : "s"} collected`
    : isWin ? "Nice call — virtual payout banked"
    : isVoid ? `Market voided · your ${usd(STAKE_CENTS)} stake was returned`
    : "So close — no payout this time";

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.35)", padding: "5px 10px", borderRadius: 18, fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: cat.color }} />{cat.label}
        </div>
        <div style={{ marginLeft: "auto", fontFamily: "var(--df)", fontSize: 18, color: m.accent, letterSpacing: ".04em" }}>{badge}</div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
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
      </div>
      <div style={{ paddingTop: 14, borderTop: "1px solid var(--line)", fontSize: 12, color: gotShards ? "var(--gold)" : "var(--muted)", fontWeight: gotShards ? 700 : 500 }}>{foot}</div>
    </div>
  );
});

// Shared card-shell styling so the top card and the preview match exactly (only the accent glow
// differs per result). Mirrors the deck's rounded panel + shadow.
function cardShell(row: ResultRow): React.CSSProperties {
  const m = resultMeta(row.status);
  const isWin = row.status === "WIN";
  return {
    position: "absolute", inset: 0, borderRadius: 26, overflow: "hidden",
    background: `radial-gradient(120% 80% at 80% 0%, color-mix(in srgb,${m.accent} 16%,transparent), transparent 58%), linear-gradient(170deg, var(--panel2), var(--panel))`,
    border: `1px solid color-mix(in srgb,${m.accent} 45%, var(--line))`,
    boxShadow: isWin ? "0 0 52px -6px color-mix(in srgb,var(--yes) 65%,transparent)" : "0 22px 44px -20px rgba(0,0,0,.7)",
  };
}

// ── RevealCardPreview — the next reveal card sitting behind the top one. Fully rendered, scaled
//    back + dimmed + non-interactive. Uses the deck's exact PREVIEW_SCALE/_Y so the "deck" read is
//    identical to the blitz deck's stack.
function RevealCardPreview({ row }: { row: ResultRow }) {
  return (
    <div style={{ ...cardShell(row), filter: "brightness(.82)", pointerEvents: "none", transform: `scale(${PREVIEW_SCALE}) translateY(${PREVIEW_Y}px)`, transformOrigin: "center bottom" }}>
      <RevealCardFace row={row} />
    </div>
  );
}

// Coin fountain for a win — bursts UP from the card's TOP edge and flies out above it. Rendered as a
// sibling of the card shell (not inside it) so the card's overflow:hidden doesn't clip the coins.
// Positions are fixed once per card (useMemo keyed by row.id) so they don't re-randomize each frame.
function CoinBurst({ row }: { row: ResultRow }) {
  const coins = useMemo(
    () => Array.from({ length: 14 }, (_, k) => ({
      key: k,
      left: `${8 + Math.random() * 84}%`,
      size: `${15 + Math.random() * 13}px`,
      cx: `${(Math.random() * 120 - 60).toFixed(0)}px`,
      anim: `hfCoin ${(1 + Math.random() * 0.7).toFixed(2)}s ${(Math.random() * 0.35).toFixed(2)}s ease-out forwards`,
    })),
    [row.id], // eslint-disable-line react-hooks/exhaustive-deps -- positions fixed per card
  );
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "visible", pointerEvents: "none" }}>
      {coins.map((c) => (
        // top:0 = the card's top edge; hfCoin lifts them up (-180px) so they fountain out above it.
        <div key={c.key} style={{ position: "absolute", left: c.left, top: 0, fontSize: c.size, ["--cx" as string]: c.cx, animation: c.anim }}>🪙</div>
      ))}
    </div>
  );
}

// ── RevealCard — the interactive top card. SAME mechanic as the blitz deck (DeckCard): on mount it
//    rises out of the stack (hfCardRise, from the preview's pose), then the shared swipe physics take
//    over — a swipe in any direction OR a tap flings it off and advances. The entering→drag handoff
//    is copied 1:1 from DeckCard so the reveal and the deck feel identical.
function RevealCard({ row, onAdvance }: { row: ResultRow; onAdvance: () => void }) {
  const [entering, setEntering] = useState(true);
  const enterTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    enterTimer.current = window.setTimeout(() => setEntering(false), RISE_MS); // matches the keyframe
    return () => window.clearTimeout(enterTimer.current);
  }, []);
  const swipe = useCardSwipe({ onCommit: onAdvance, onTap: onAdvance });
  const onPointerDown = (e: React.PointerEvent) => {
    if (entering) { window.clearTimeout(enterTimer.current); setEntering(false); } // grab cancels the rise
    swipe.handlers.onPointerDown(e);
  };
  const riseAnim = entering && !swipe.active && !swipe.flying;
  const isWin = row.status === "WIN";

  // Wrapper holds the swipeable card shell (overflow:hidden) AND the coin burst as a SIBLING (overflow:
  // visible) — so the win fountain bursts from the card's top edge, unclipped. The burst sits BEHIND
  // the card (zIndex 0 vs the shell's 1): coins fountain up from behind the top edge and rise out above
  // it, reading as a backdrop effect rather than covering the card face.
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {isWin && <CoinBurst row={row} />}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={swipe.handlers.onPointerMove}
        onPointerUp={swipe.handlers.onPointerUp}
        style={{
          ...cardShell(row),
          zIndex: 1, // above the burst sibling — keep cardShell's position:absolute/inset:0 (it sizes the card; relative would collapse it to 0 height)
          touchAction: "none", cursor: "grab", willChange: "transform",
          ...(riseAnim
            ? { animation: `hfCardRise ${RISE_MS}ms cubic-bezier(.34,1.2,.5,1) both`, transformOrigin: "center bottom" }
            : swipe.style),
        }}
      >
        <RevealCardFace row={row} />
      </div>
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
