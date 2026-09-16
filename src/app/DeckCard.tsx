"use client";

import { memo, useEffect, useRef, useState } from "react";
import { type Card, catOf, isFootball, cents, usd, winPayout, countdown, sideLabels, marketHint, displayQuestion, isUpDown, upDownWindow, isMatchClock } from "./ui";
import { skinStyle, SCRIM } from "./skins";
import { useCardSwipe } from "./useCardSwipe";

export type SwipeAction = "YES" | "NO" | "SKIP";

export const RISE_MS = 320; // how long the next card rises into the top slot (shared with the reveal stack)

// ============================================================================
// CardFace — the full card VISUALS, pure + memoized. Used both for the live top card and the
// next-card preview behind it (so the next card is fully rendered, not a gray stub). Takes only
// primitives so memo() skips re-renders unless a value actually changes. No gesture, no clock.
// ============================================================================
type FaceProps = {
  card: Card;
  skinId: string; // equipped skin (or preview skin) — drives the whole card background
  countdownText: string;
  urgent: boolean;
  windowText: string; // live "Resolves in ~N min" line (shown for quick crypto Up/Down)
  // drag-driven overlay/stamp intensities (0 for a static preview card)
  yesP: number;
  noP: number;
  skipP: number;
  // What ONE swipe stakes, in cents. Passed in rather than read from config because in real mode it
  // is the account's own setting, and the payouts beside it must derive from the same number the chip
  // shows -- a card promising a $10 win on a $1 stake is a lie about somebody's money.
  stakeCents: number;
  // Present only where the stake is editable (real mode, live top card). Absent -> the chip stays
  // inert text, which is what a preview card sitting behind the top one has to be.
  onEditStake?: () => void;
};


// A price that MOVED, rendered as a pulse. The top card re-quotes every second; without this the
// number just differs between frames, which reads exactly like a number that never moves. Returns
// the animation to play — cheaper is a bright pulse (the same stake buys more), dearer is a dim one
// — and nothing else, so a re-render mid-swipe can never shift the layout under a thumb.
//
// Derived during render from a ref of the previous value: no state, no effect, so a price change
// costs zero extra renders. Restarting the animation is the CALLER's job — it keys the element on
// the value it is showing, and a remount is what re-runs a CSS animation that already played. That
// is also why two moves the same way inside one 460ms animation now pulse twice, as they should.
/* eslint-disable react-hooks/refs -- the previous-value-during-render pattern, on purpose: the ref
   is this hook's whole point, and the write is idempotent (a second render pass with the same value
   changes nothing), so a double render cannot double-pulse. The alternative is the setState the
   comment above describes. */
export function useTick(value: number): string | undefined {
  const prev = useRef({ value, anim: undefined as string | undefined });
  if (prev.current.value !== value) {
    const down = value < prev.current.value; // a LOWER price is better for the buyer
    prev.current = { value, anim: `${down ? "hfTickUp" : "hfTickDown"} .45s ease` };
  }
  return prev.current.anim;
}
/* eslint-enable react-hooks/refs */

export const CardFace = memo(function CardFace({ card, skinId, countdownText, urgent, windowText, yesP, noP, skipP, stakeCents, onEditStake }: FaceProps) {
  const cat = catOf(card);
  // WHICH window this is, and whether it has started. Two Up/Down markets can end at the same minute
  // and be completely different bets — a not-yet-open five-minute window is a coin flip while the
  // fifteen-minute one closing beside it is two thirds decided — and the countdown alone cannot tell
  // them apart. The start is derived from the end (which we know exactly) minus the window length,
  // so no timezone maths is involved.
  const matchClock = isMatchClock(card);
  const win = isUpDown(card) ? upDownWindow(card.question) : null;
  const startsInMin = win
    ? Math.ceil((new Date(card.resolutionDeadline).getTime() - win.lengthMin * 60_000 - Date.now()) / 60_000)
    : 0;
  const windowLine = win
    ? `${win.label} · ${startsInMin > 0 ? `opens in ~${startsInMin} min` : windowText.replace(/^Resolves/, "resolves")}`
    : windowText;
  // Both sides tick independently: a book usually moves one of them.
  const yesTick = useTick(card.yesPriceBp);
  const noTick = useTick(card.noPriceBp);
  const stamp = (p: number) => ({ o: Math.max(0, Math.min(1, (p - 0.15) / 0.5)), s: 0.6 + 0.4 * Math.min(1, p) });
  const ys = stamp(yesP), ns = stamp(noP), ks = stamp(skipP);
  // Human-readable side labels (Over/Under markets get the line folded in) + a plain-language hint.
  const labels = sideLabels(card);
  const hint = marketHint(card);
  // The equipped skin owns the background. Derived in render (cheap, pure) — no effect/state.
  // Layering: bg → skin overlay → readability SCRIM → directional overlays → stamps → content.
  const skin = skinStyle(skinId, cat.color, isFootball(card));

  return (
    <>
      <div style={{ position: "absolute", inset: 0, background: skin.bg }} />
      {skin.overlay ? <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>{skin.overlay}</div> : null}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: SCRIM }} />

      {/* directional overlays */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: yesP, background: "linear-gradient(270deg, color-mix(in srgb,var(--yes) 70%, transparent), transparent 65%)" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: noP, background: "linear-gradient(90deg, color-mix(in srgb,var(--no) 70%, transparent), transparent 65%)" }} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: skipP, background: "radial-gradient(120% 70% at 50% 34%, color-mix(in srgb,var(--skip) 60%, transparent), transparent 62%)" }} />

      {/* stamps — show the human-readable side label */}
      <Stamp label={labels.no} color="var(--no)" o={ns.o} s={ns.s} pos={{ top: 42, left: 26 }} rot={-15} />
      <Stamp label={labels.yes} color="var(--yes)" o={ys.o} s={ys.s} pos={{ top: 42, right: 26 }} rot={15} />
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

        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "14px 0" }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 32, lineHeight: 1.04, letterSpacing: ".2px", color: "#fff", textShadow: "0 2px 20px rgba(0,0,0,.5)", textWrap: "balance" }}>{displayQuestion(card)}</div>
          {isUpDown(card)
            ? <div style={{ marginTop: 10, fontSize: 13, color: "rgba(255,255,255,.62)", lineHeight: 1.3 }}>{windowLine}</div>
            : hint && <div style={{ marginTop: 10, fontSize: 13, color: "rgba(255,255,255,.62)", lineHeight: 1.3, textWrap: "pretty" }}>{hint}</div>}
          {/* What the ⏱ badge is actually counting. On a match it is the KICK-OFF: Gamma's endDate
              equals gameStartTime on every live sport market, the thing then trades through the game
              and resolves after it. Unlabelled, the same badge that means "pays out in 7m" on a
              crypto card meant "starts in 7m" here, and a position read as overdue from the whistle. */}
          {matchClock ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "rgba(255,255,255,.5)", lineHeight: 1.3 }}>
              Kick-off in {countdownText} · resolves after the match
            </div>
          ) : null}
        </div>

        {/* odds split — sides + CENTS (Polymarket-style), not % */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            {/* keyed on the price: a new key remounts the block, which is what restarts the pulse */}
            <div key={`no${card.noPriceBp}`} style={{ color: "var(--no)", minWidth: 0, animation: noTick }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.no}</div>
              <div>{cents(card.noPriceBp)}</div>
            </div>
            <div key={`yes${card.yesPriceBp}`} style={{ color: "var(--yes)", minWidth: 0, textAlign: "right", animation: yesTick }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.yes}</div>
              <div>{cents(card.yesPriceBp)}</div>
            </div>
          </div>
          <div style={{ display: "flex", height: 12, borderRadius: 8, overflow: "hidden", background: "rgba(0,0,0,.4)" }}>
            <div style={{ width: `${card.noPriceBp / 100}%`, background: "linear-gradient(90deg,color-mix(in srgb,var(--no) 60%,#000),var(--no))" }} />
            <div style={{ flex: 1, background: "linear-gradient(90deg,var(--yes),color-mix(in srgb,var(--yes) 60%,#000))" }} />
          </div>
        </div>

        {/* stake + win payouts */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* The chip IS the control. A stake is a per-swipe amount, so the place to change it is the
              place it is stated -- not a settings screen two taps away from the gesture it governs.
              pointerdown is stopped so opening it can never read as the start of a swipe. */}
          <StakeChip stakeCents={stakeCents} onEditStake={onEditStake} />
          <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 6 }}>
            <PayBox key={`no${card.noPriceBp}`} label={labels.no} val={usd(winPayout(card.noPriceBp, stakeCents))} color="var(--no)" tick={noTick} />
            <PayBox key={`yes${card.yesPriceBp}`} label={labels.yes} val={usd(winPayout(card.yesPriceBp, stakeCents))} color="var(--yes)" tick={yesTick} />
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

export const CardPreview = memo(function CardPreview({ card, skinId, stakeCents }: { card: Card; skinId: string; stakeCents: number }) {
  const text = useCountdown(card.resolutionDeadline, 0); // no urgency styling needed behind
  return (
    <div style={{ position: "absolute", inset: 0, borderRadius: 26, overflow: "hidden", background: "var(--panel2)", border: "1px solid var(--line)", filter: "brightness(.82)", pointerEvents: "none", transform: `scale(${PREVIEW_SCALE}) translateY(${PREVIEW_Y}px)`, transformOrigin: "center bottom" }}>
      <CardFace card={card} skinId={skinId} countdownText={text.text} urgent={false} windowText={text.relText} yesP={0} noP={0} skipP={0} stakeCents={stakeCents} />
    </div>
  );
});

// ============================================================================
// DeckCard — the interactive top card. Owns the gesture AND its own 1s countdown tick, so the
// clock no longer re-renders the whole App (it was the main jank source during swipes).
// ============================================================================
// ============================================================================
// SwipeShell — the gesture shell, extracted so a second card type (the stock deck) reuses the exact
// physics: the rise-out-of-stack animation, the drag-follow, the fling-off, the tap detection. It
// owns ONLY the gesture and the outer element; the face is a render prop, so each card type draws
// its own content while moving identically.
// ============================================================================
export function SwipeShell({ busy, onAction, onTap, children }: {
  busy?: boolean;
  onAction: (a: SwipeAction) => void;
  onTap: () => void;
  children: (p: { yesP: number; noP: number; skipP: number }) => React.ReactNode;
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
      onPointerCancel={swipe.handlers.onPointerCancel}
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
      {children({ yesP: swipe.progressOf("YES"), noP: swipe.progressOf("NO"), skipP: swipe.progressOf("SKIP") })}
    </div>
  );
}

export function DeckCard({
  card,
  skinId,
  busy,
  onAction,
  onTap,
  stakeCents,
  onEditStake,
}: {
  card: Card;
  skinId: string;
  busy?: boolean;
  onAction: (a: SwipeAction) => void;
  onTap: () => void;
  stakeCents: number;
  onEditStake?: () => void;
}) {
  const cd = useCountdown(card.resolutionDeadline);
  return (
    <SwipeShell busy={busy} onAction={onAction} onTap={onTap}>
      {({ yesP, noP, skipP }) => (
        <CardFace card={card} skinId={skinId} countdownText={cd.text} urgent={cd.urgent} windowText={cd.relText} yesP={yesP} noP={noP} skipP={skipP} stakeCents={stakeCents} onEditStake={onEditStake} />
      )}
    </SwipeShell>
  );
}

// Self-contained 1s countdown tick, scoped to whoever uses it — so the clock re-renders ONLY
// the card that owns it, never the whole app. Starts at 0 (server) then ticks client-side.
function useCountdown(iso: string, _seed = 0) {
  // Lazy init to the real time so the first paint is correct AND we avoid a setState-in-effect
  // cascade. Safe from hydration mismatch: DeckCard renders only after the client deck fetch, so it
  // is never in the SSR tree with a card. The interval then drives the per-card tick.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return countdown(iso, nowMs);
}

// The stake chip. A real <button> where it is editable (a div with role="button" answers the mouse
// and ignores the keyboard), plain text where it is not — a preview card behind the top one must
// not be reachable by Tab at all.
function StakeChip({ stakeCents, onEditStake }: { stakeCents: number; onEditStake?: () => void }) {
  const box: React.CSSProperties = {
    background: "rgba(0,0,0,.4)",
    backdropFilter: "blur(6px)",
    border: "1px solid " + (onEditStake ? "var(--gold)" : "var(--line)"),
    padding: "8px 12px",
    borderRadius: 14,
  };
  const body = (
    <>
      <div style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase" }}>
        Stake
      </div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "#fff" }}>{usd(stakeCents)}</div>
    </>
  );
  if (!onEditStake) return <div style={box}>{body}</div>;
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onEditStake(); }}
      style={{ ...box, margin: 0, font: "inherit", textAlign: "left", cursor: "pointer" }}
    >
      {body}
    </button>
  );
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

function PayBox({ label, val, color, tick }: { label: string; val: string; color: string; tick?: string }) {
  return (
    <div style={{ flex: 1, textAlign: "center", background: `color-mix(in srgb,${color} 14%,transparent)`, border: `1px solid color-mix(in srgb,${color} 35%,transparent)`, padding: "8px 6px", borderRadius: 14, minWidth: 0 }}>
      <div style={{ fontSize: 8, letterSpacing: ".1em", color, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color, animation: tick }}>{val}</div>
    </div>
  );
}
