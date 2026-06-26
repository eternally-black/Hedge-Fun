"use client";

import { memo, useEffect, useRef, useState } from "react";
import { type Card, catOf, bgGrad, cents, winPayout, countdown } from "./ui";
import { useCardSwipe } from "./useCardSwipe";

export type SwipeAction = "YES" | "NO" | "SKIP";

const RISE_MS = 320; // how long the next card rises into the top slot

// ============================================================================
// CardFace — the full card VISUALS, pure + memoized. Used both for the live top card and the
// next-card preview behind it (so the next card is fully rendered, not a gray stub). Takes only
// primitives so memo() skips re-renders unless a value actually changes. No gesture, no clock.
// ============================================================================
type FaceProps = {
  card: Card;
  countdownText: string;
  urgent: boolean;
  // drag-driven overlay/stamp intensities (0 for a static preview card)
  yesP: number;
  noP: number;
  skipP: number;
};

const CardFace = memo(function CardFace({ card, countdownText, urgent, yesP, noP, skipP }: FaceProps) {
  const cat = catOf(card);
  const stamp = (p: number) => ({ o: Math.max(0, Math.min(1, (p - 0.15) / 0.5)), s: 0.6 + 0.4 * Math.min(1, p) });
  const ys = stamp(yesP), ns = stamp(noP), ks = stamp(skipP);

  return (
    <>
      <div style={{ position: "absolute", inset: 0, background: bgGrad(cat.color) }} />

      {/* directional overlays */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: yesP, background: "linear-gradient(270deg, color-mix(in srgb,var(--yes) 70%, transparent), transparent 65%)" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: noP, background: "linear-gradient(90deg, color-mix(in srgb,var(--no) 70%, transparent), transparent 65%)" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: skipP, background: "radial-gradient(120% 70% at 50% 34%, color-mix(in srgb,var(--skip) 60%, transparent), transparent 62%)" }} />

      {/* stamps — show the real side label */}
      <Stamp label={card.outcomeNoLabel} color="var(--no)" o={ns.o} s={ns.s} pos={{ top: 42, left: 26 }} rot={-15} />
      <Stamp label={card.outcomeYesLabel} color="var(--yes)" o={ys.o} s={ys.s} pos={{ top: 42, right: 26 }} rot={15} />
      <Stamp label="SKIP" color="var(--skip)" o={ks.o} s={ks.s} pos={{ top: 30, left: "50%", marginLeft: -62 }} rot={0} />

      {/* content */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: "16px 18px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "6px 11px", borderRadius: 20 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: cat.color, boxShadow: `0 0 8px ${cat.color}` }} />
            <span style={{ fontSize: 10, letterSpacing: ".13em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>{cat.label}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "6px 11px", borderRadius: 20, border: `1px solid ${urgent ? "color-mix(in srgb,var(--no) 60%,transparent)" : "transparent"}` }}>
            <span style={{ fontSize: 12 }}>⏱</span>
            <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, color: urgent ? "var(--no)" : "#fff" }}>{countdownText}</span>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "14px 0" }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 32, lineHeight: 1.04, letterSpacing: ".2px", color: "#fff", textShadow: "0 2px 20px rgba(0,0,0,.5)", textWrap: "balance" }}>{card.question}</div>
        </div>

        {/* odds split — sides + CENTS (Polymarket-style), not % */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            <span style={{ color: "var(--no)" }}>{card.outcomeNoLabel} {cents(card.noPriceBp)}</span>
            <span style={{ color: "var(--yes)" }}>{cents(card.yesPriceBp)} {card.outcomeYesLabel}</span>
          </div>
          <div style={{ display: "flex", height: 12, borderRadius: 8, overflow: "hidden", background: "rgba(0,0,0,.4)" }}>
            <div style={{ width: `${card.noPriceBp / 100}%`, background: "linear-gradient(90deg,color-mix(in srgb,var(--no) 60%,#000),var(--no))" }} />
            <div style={{ flex: 1, background: "linear-gradient(90deg,var(--yes),color-mix(in srgb,var(--yes) 60%,#000))" }} />
          </div>
        </div>

        {/* stake + win payouts */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", border: "1px solid var(--line)", padding: "8px 12px", borderRadius: 14 }}>
            <div style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase" }}>Stake</div>
            <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "#fff" }}>$100</div>
          </div>
          <div style={{ flex: 1, display: "flex", gap: 6 }}>
            <PayBox label={`Win ${card.outcomeNoLabel}`} val={winPayout(card.noPriceBp)} color="var(--no)" />
            <PayBox label={`Win ${card.outcomeYesLabel}`} val={winPayout(card.yesPriceBp)} color="var(--yes)" />
          </div>
        </div>
        <div style={{ textAlign: "center", marginTop: 12, fontSize: 11, color: "rgba(255,255,255,.55)", letterSpacing: ".02em" }}>Tap for details · swipe to call</div>
      </div>
    </>
  );
});

// ============================================================================
// CardPreview — the next card sitting behind the top one. Fully rendered (same CardFace), just
// scaled back, dimmed, and non-interactive. Owns its own slow clock so the visible top card's
// fast clock and this don't share a parent re-render. memo'd: only re-renders if its card changes.
// ============================================================================
// PREVIEW_SCALE / _Y define the resting pose of a card sitting behind the top one. The rise
// keyframe (globals.css hfCardRise) starts from EXACTLY these values, so when this preview
// becomes the top card the growth is seamless — and because it's animated (scale .957 -> 1),
// the font grows smoothly instead of jumping. transformOrigin must match (center bottom).
export const PREVIEW_SCALE = 0.957;
export const PREVIEW_Y = 13;

export const CardPreview = memo(function CardPreview({ card }: { card: Card }) {
  const text = useCountdown(card.resolutionDeadline, 0); // no urgency styling needed behind
  return (
    <div style={{ position: "absolute", inset: 0, borderRadius: 26, overflow: "hidden", background: "var(--panel2)", border: "1px solid var(--line)", filter: "brightness(.82)", pointerEvents: "none", transform: `scale(${PREVIEW_SCALE}) translateY(${PREVIEW_Y}px)`, transformOrigin: "center bottom" }}>
      <CardFace card={card} countdownText={text.text} urgent={false} yesP={0} noP={0} skipP={0} />
    </div>
  );
});

// ============================================================================
// DeckCard — the interactive top card. Owns the gesture AND its own 1s countdown tick, so the
// clock no longer re-renders the whole App (it was the main jank source during swipes).
// ============================================================================
export function DeckCard({
  card,
  busy,
  onAction,
  onTap,
}: {
  card: Card;
  busy?: boolean;
  onAction: (a: SwipeAction) => void;
  onTap: () => void;
}) {
  // `entering` plays the rise-out-of-stack animation once on mount (this card just became top).
  // While entering we let the CSS keyframe own `transform`; after it ends we switch to the
  // inline transform that drives the drag. A new card key remounts -> entering resets to true.
  const [entering, setEntering] = useState(true);
  const enterTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    enterTimer.current = window.setTimeout(() => setEntering(false), RISE_MS); // matches keyframe
    return () => window.clearTimeout(enterTimer.current);
  }, []);

  const cd = useCountdown(card.resolutionDeadline);

  // Shared deck/reveal physics. Commit fires the bet (onAction); tap opens detail.
  const swipe = useCardSwipe({ onCommit: onAction, onTap, enabled: !busy });

  // Grabbing the card cancels the entering rise so the drag takes over cleanly.
  const onPointerDown = (e: React.PointerEvent) => {
    if (entering) { window.clearTimeout(enterTimer.current); setEntering(false); }
    swipe.handlers.onPointerDown(e);
  };

  // While the rise animation plays, hand `transform`/`filter` to the keyframe (don't set them
  // inline, or inline would fight the animation). Once it's done, the swipe style takes over.
  const riseAnim = entering && !swipe.active && !swipe.flying;

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={swipe.handlers.onPointerMove}
      onPointerUp={swipe.handlers.onPointerUp}
      style={{
        position: "absolute", inset: 0, borderRadius: 26, overflow: "hidden",
        background: "var(--panel2)", border: "1px solid var(--line)",
        boxShadow: "0 24px 50px -18px rgba(0,0,0,.7)", touchAction: "none",
        cursor: busy ? "default" : "grab", willChange: "transform",
        ...(riseAnim
          ? { animation: `hfCardRise ${RISE_MS}ms cubic-bezier(.34,1.2,.5,1) both`, transformOrigin: "center bottom" }
          : swipe.style),
      }}
    >
      <CardFace card={card} countdownText={cd.text} urgent={cd.urgent} yesP={swipe.progressOf("YES")} noP={swipe.progressOf("NO")} skipP={swipe.progressOf("SKIP")} />
    </div>
  );
}

// Self-contained 1s countdown tick, scoped to whoever uses it — so the clock re-renders ONLY
// the card that owns it, never the whole app. Starts at 0 (server) then ticks client-side.
function useCountdown(iso: string, _seed = 0) {
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return countdown(iso, nowMs);
}

function Stamp({ label, color, o, s, pos, rot }: { label: string; color: string; o: number; s: number; pos: React.CSSProperties; rot: number }) {
  return (
    <div style={{
      position: "absolute", ...pos, "--rot": `${rot}deg`, border: `5px solid ${color}`, color,
      fontFamily: "var(--df)", fontSize: 40, padding: "2px 16px", borderRadius: 12,
      transform: `rotate(${rot}deg) scale(${s})`, opacity: o, maxWidth: 240,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      boxShadow: `0 0 24px color-mix(in srgb,${color} 40%,transparent)`, textAlign: "center",
    } as React.CSSProperties}>{label}</div>
  );
}

function PayBox({ label, val, color }: { label: string; val: number; color: string }) {
  return (
    <div style={{ flex: 1, textAlign: "center", background: `color-mix(in srgb,${color} 14%,transparent)`, border: `1px solid color-mix(in srgb,${color} 35%,transparent)`, padding: "8px 6px", borderRadius: 14, minWidth: 0 }}>
      <div style={{ fontSize: 8, letterSpacing: ".1em", color, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color }}>${val}</div>
    </div>
  );
}
