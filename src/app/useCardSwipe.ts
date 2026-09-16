"use client";

import { useEffect, useRef, useState } from "react";

// ─── useCardSwipe — the deck's swipe physics, extracted so the reveal reuses it verbatim ─────────
// Follow-the-finger drag → release past threshold commits with a fling-off, else springs back. This
// is the SAME gesture the blitz deck uses (DeckCard); pulling it into a hook means one source of the
// physics/timings, no reinvented velocity or duplicated transform math.
//
// The hook owns ONLY the gesture (drag state, direction, fly transform, tap detection). The visual
// (card face, stamps, overlays, coins) stays with each caller — the deck shows odds, the reveal
// shows an outcome, but both move identically.

export type SwipeDir = "YES" | "NO" | "SKIP";

export const COMMIT_PX = 130; // drag distance past which a release commits (design-locked)
const FLY_MS = 380; // outgoing card animates off-screen for this long
const TAP_MS = 300; // a release under this, with no movement, is a tap
const MOVE_EPS = 5; // px of travel before a press counts as a drag (not a tap)

export type CardSwipe = {
  // Spread onto the card element.
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    // The browser took the pointer away mid-drag (a second finger, a system back-gesture, a
    // scroll takeover). Without this the card freezes where the finger left it, stamp lit.
    onPointerCancel: (e: React.PointerEvent) => void;
  };
  // Live transform/transition/opacity for the card element (drag-follow, fly-off, or spring-back).
  style: { transform: string; transition: string; opacity: number };
  active: boolean; // a drag is in progress
  flying: boolean; // a commit fling is animating (card on its way off-screen)
  // Per-direction progress 0..1 (for the deck's overlays/stamps). 0 unless that direction is the
  // current drag direction.
  progressOf: (d: SwipeDir) => number;
};

export function useCardSwipe(opts: {
  // Called once, mid-fling (at FLY_MS/2), so the next card can rise while this one flies out.
  onCommit: (dir: SwipeDir) => void;
  onTap?: () => void;
  enabled?: boolean; // false = ignore gestures (busy/animating)
  // SKIP (swipe-up) is a real third direction in the deck; the reveal treats up like any swipe but
  // still flings upward, so it's on by default.
  allowSkip?: boolean;
}): CardSwipe {
  const { onCommit, onTap, enabled = true, allowSkip = true } = opts;
  const [drag, setDrag] = useState({ active: false, dx: 0, dy: 0, dir: null as SwipeDir | null, progress: 0 });
  const [fly, setFly] = useState<SwipeDir | null>(null);
  const start = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const flyTimer = useRef<number | undefined>(undefined);
  const unflyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    window.clearTimeout(flyTimer.current);
    window.clearTimeout(unflyTimer.current);
  }, []);

  const reset = () => setDrag({ active: false, dx: 0, dy: 0, dir: null, progress: 0 });

  function onPointerDown(e: React.PointerEvent) {
    if (!enabled || fly) return;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* not all targets capture */ }
    start.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
  }
  function onPointerMove(e: React.PointerEvent) {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > MOVE_EPS || Math.abs(dy) > MOVE_EPS) s.moved = true;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    let dir: SwipeDir, progress: number;
    // Up-bias matches the deck: a clearly-vertical upward drag is SKIP; otherwise horizontal YES/NO.
    if (allowSkip && ay > ax * 1.15 && dy < 0) { dir = "SKIP"; progress = Math.min(1, ay / COMMIT_PX); }
    else { dir = dx > 0 ? "YES" : "NO"; progress = Math.min(1, ax / COMMIT_PX); }
    setDrag({ active: true, dx, dy, dir, progress });
  }
  function onPointerUp() {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const isTap = !s.moved && Date.now() - s.t < TAP_MS;
    if (isTap) { reset(); onTap?.(); return; }
    if (drag.progress >= 1 && drag.dir) {
      const dir = drag.dir;
      setFly(dir);
      reset();
      // Hand off mid-fling so the next card starts rising at the 50% point (overlap), matching the deck.
      flyTimer.current = window.setTimeout(() => onCommit(dir), Math.round(FLY_MS / 2));
      // Clear the fling once the animation has finished. A consumed card is unmounted before this
      // fires (keyed by id / index), so only a card the caller refused to consume — a gated act() —
      // ever sees it, and it springs back visible instead of sitting invisible and ungrabbable.
      unflyTimer.current = window.setTimeout(() => setFly(null), FLY_MS + 60);
    } else {
      reset(); // sprung back
    }
  }

  // A cancelled pointer is a release that cannot commit: drop the press, spring back, hand the
  // capture back to the browser (it usually already took it, hence the try).
  function onPointerCancel(e: React.PointerEvent) {
    start.current = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* capture may already be gone */ }
    reset();
  }

  let transform = "translate(0,0) rotate(0deg)";
  let transition = "transform .45s cubic-bezier(.34,1.4,.5,1)"; // spring-back overshoot
  let opacity = 1;
  if (fly) {
    transform = fly === "YES" ? "translate(150%,-12%) rotate(26deg)"
      : fly === "NO" ? "translate(-150%,-12%) rotate(-26deg)"
      : "translate(0,-170%) rotate(-3deg)";
    transition = `transform ${FLY_MS}ms cubic-bezier(.45,0,.25,1), opacity ${FLY_MS}ms`;
    opacity = 0;
  } else if (drag.active) {
    transform = `translate(${drag.dx}px,${drag.dy}px) rotate(${drag.dx * 0.05}deg)`;
    transition = "none";
  }

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    style: { transform, transition, opacity },
    active: drag.active,
    flying: fly != null,
    progressOf: (d) => (drag.active && drag.dir === d ? drag.progress : 0),
  };
}
