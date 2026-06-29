"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  type Card,
  type Me,
  catOf,
  bgGrad,
  cents,
  usd,
  winPayout,
  countdown,
  sideLabels,
  marketHint,
  displayQuestion,
  isUpDown,
} from "../ui";
import { STAKE_CENTS, DECK_MIN_LEAD_MS } from "@/lib/config";
import type { BetSide } from "@/lib/api-types";

// ============================================================================
// Shared market block — the tappable near-50% binary card used by BOTH the post-cap feed (лента)
// and the football match-detail view. It's just the rounded panel (gradient + question + odds +
// tap-to-bet); the caller sizes the box around it (a 50%-viewport snap section in the feed, a fixed
// block in the football view). Memoized on primitive-ish props so a /api/me refresh or a bet on a
// sibling card never re-renders this one. Betting flows through useMarketBet (below).
// ============================================================================
type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export const MarketCard = memo(function MarketCard({
  card,
  placedSide,
  nowMs,
  onBet,
}: {
  card: Card;
  placedSide: BetSide | undefined;
  nowMs: number; // shared clock (ticks ~15s) — keeps Date.now() out of render
  onBet: (card: Card, side: BetSide) => void;
}) {
  const cat = catOf(card);
  const labels = sideLabels(card);
  const hint = marketHint(card);
  const cd = countdown(card.resolutionDeadline, nowMs);
  const expired = new Date(card.resolutionDeadline).getTime() - nowMs <= DECK_MIN_LEAD_MS;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 22, overflow: "hidden", background: "var(--panel2)", border: "1px solid var(--line)", boxShadow: "0 18px 40px -20px rgba(0,0,0,.7)" }}>
      <div style={{ position: "absolute", inset: 0, background: bgGrad(cat.color) }} />
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: "14px 15px" }}>
        {/* category + countdown */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: cat.color, boxShadow: `0 0 8px ${cat.color}` }} />
            <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>{cat.label}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18, border: `1px solid ${cd.urgent ? "color-mix(in srgb,var(--no) 60%,transparent)" : "transparent"}` }}>
            <span style={{ fontSize: 11 }}>⏱</span>
            <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 12, color: cd.urgent ? "var(--no)" : "#fff" }}>{cd.text}</span>
          </div>
        </div>

        {/* question — compact, clamped so stacked cards stay balanced */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "8px 0", minHeight: 0 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 20, lineHeight: 1.08, letterSpacing: ".2px", color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,.5)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>{displayQuestion(card)}</div>
          {isUpDown(card)
            ? <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,.6)", lineHeight: 1.3 }}>{cd.relText}</div>
            : hint ? <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,.6)", lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>{hint}</div> : null}
        </div>

        {/* odds split */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 12, marginBottom: 5 }}>
            <span style={{ color: "var(--no)" }}>{labels.no} {cents(card.noPriceBp)}</span>
            <span style={{ color: "var(--yes)" }}>{cents(card.yesPriceBp)} {labels.yes}</span>
          </div>
          <div style={{ display: "flex", height: 10, borderRadius: 6, overflow: "hidden", background: "rgba(0,0,0,.4)" }}>
            <div style={{ width: `${card.noPriceBp / 100}%`, background: "linear-gradient(90deg,color-mix(in srgb,var(--no) 60%,#000),var(--no))" }} />
            <div style={{ flex: 1, background: "linear-gradient(90deg,var(--yes),color-mix(in srgb,var(--yes) 60%,#000))" }} />
          </div>
        </div>

        {/* action row: two tap-to-bet buttons, or a locked banner once placed */}
        {placedSide ? (
          <LockedBanner card={card} side={placedSide} labels={labels} />
        ) : (
          <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
            <BetButton label={labels.no} payout={winPayout(card.noPriceBp)} color="var(--no)" disabled={expired} onClick={() => onBet(card, "NO")} />
            <BetButton label={labels.yes} payout={winPayout(card.yesPriceBp)} color="var(--yes)" disabled={expired} onClick={() => onBet(card, "YES")} />
          </div>
        )}
        <div style={{ textAlign: "center", marginTop: 8, fontSize: 10, color: "rgba(255,255,255,.5)", letterSpacing: ".02em" }}>
          {expired ? "Resolving — closed for new calls" : `${usd(STAKE_CENTS)} · no points, shards on wins`}
        </div>
      </div>
    </div>
  );
});

function BetButton({ label, payout, color, disabled, onClick }: { label: string; payout: number; color: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        flex: 1, minWidth: 0, padding: "9px 8px", borderRadius: 14, font: "inherit", cursor: disabled ? "default" : "pointer",
        background: `color-mix(in srgb,${color} 16%,transparent)`, border: `1.5px solid color-mix(in srgb,${color} 50%,transparent)`,
        color, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{ fontFamily: "var(--df)", fontSize: 16, lineHeight: 1, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 10, color: "rgba(255,255,255,.7)" }}>to win <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color }}>${payout}</span></span>
    </button>
  );
}

function LockedBanner({ card, side, labels }: { card: Card; side: BetSide; labels: { yes: string; no: string } }) {
  const color = side === "YES" ? "var(--yes)" : "var(--no)";
  const label = side === "YES" ? labels.yes : labels.no;
  const payout = winPayout(side === "YES" ? card.yesPriceBp : card.noPriceBp);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 12px", borderRadius: 16, background: `color-mix(in srgb,${color} 18%,transparent)`, border: `1.5px solid color-mix(in srgb,${color} 55%,transparent)` }}>
      <span style={{ fontSize: 16, color }}>✓</span>
      <span style={{ fontSize: 13, color: "#fff" }}>
        You&apos;re in on <span style={{ fontFamily: "var(--df)", color }}>{label}</span> — <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color }}>${payout}</span> to win
      </span>
    </div>
  );
}

// ============================================================================
// useMarketBet — the points-FREE bet flow shared by the feed and the football match view. Optimistic
// (lock the card, then POST /api/feed/bet), with the deck's cash gate + 402/409 handling. Reads
// me/placed via refs so placeBet stays stable across the frequent /api/me refreshes. seedPlaced lets
// a caller pre-mark markets the user already bet (the football view loads them from the server).
// ============================================================================
export function useMarketBet({
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
}): {
  placed: Map<string, BetSide>;
  placeBet: (card: Card, side: BetSide) => void;
  seedPlaced: (entries: Iterable<readonly [string, BetSide]>) => void;
} {
  const [placed, setPlaced] = useState<Map<string, BetSide>>(new Map());
  const meRef = useRef<Me | null>(me);
  useEffect(() => { meRef.current = me; }, [me]);
  const placedRef = useRef(placed);
  useEffect(() => { placedRef.current = placed; }, [placed]);

  const placeBet = useCallback(
    (card: Card, side: BetSide) => {
      if (placedRef.current.has(card.id)) return; // already bet this card
      const m = meRef.current;
      if (m && m.cashCents < m.stakeCents) {
        onToast("No free cash — top up to keep going");
        onTopup();
        return;
      }
      setPlaced((prev) => new Map(prev).set(card.id, side));
      api("/api/feed/bet", { method: "POST", body: JSON.stringify({ marketId: card.id, side }) })
        .then(() => onRefreshMe())
        .catch((e) => {
          const status = (e as { status?: number }).status;
          if (status === 409) { void onRefreshMe(); return; } // already bet / expired — leave it locked
          setPlaced((prev) => { const n = new Map(prev); n.delete(card.id); return n; }); // roll back so retry/top-up is possible
          if (status === 402) { onToast("No free cash — top up to keep going"); onTopup(); }
          else console.error(e);
        });
    },
    [api, onRefreshMe, onToast, onTopup],
  );

  const seedPlaced = useCallback((entries: Iterable<readonly [string, BetSide]>) => {
    setPlaced((prev) => {
      const n = new Map(prev);
      for (const [k, v] of entries) n.set(k, v);
      return n;
    });
  }, []);

  return { placed, placeBet, seedPlaced };
}
