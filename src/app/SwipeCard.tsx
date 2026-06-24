"use client";

import { useEffect, useRef, useState } from "react";

// Tinder-style swipe card on native pointer events (no gesture lib — ponytail).
// Drag right = YES (side A), left = NO (side B), up = SKIP (no bet). Release past the
// threshold flings the card and fires onAction; otherwise it springs back. Buttons in the
// parent stay as a fallback; this just adds the gesture.
export type SwipeAction = "YES" | "NO" | "SKIP";

const SWIPE_THRESHOLD = 90; // px past which a release commits the action
const FLING = 600; // px the card travels when it leaves

export function SwipeCard({
  children,
  onAction,
  disabled,
}: {
  children: React.ReactNode;
  onAction: (a: SwipeAction) => void;
  disabled?: boolean;
}) {
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [leaving, setLeaving] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const flingTimer = useRef<number | undefined>(undefined);

  // Clear the fling timer if the card unmounts mid-animation (key change), so onAction can't
  // fire on a dead component.
  useEffect(() => () => window.clearTimeout(flingTimer.current), []);

  // Which action the current offset maps to (null = back to center). Horizontal wins over
  // vertical unless the drag is clearly upward.
  function actionFor(x: number, y: number): SwipeAction | null {
    if (y < -SWIPE_THRESHOLD && Math.abs(y) > Math.abs(x)) return "SKIP";
    if (x > SWIPE_THRESHOLD) return "YES";
    if (x < -SWIPE_THRESHOLD) return "NO";
    return null;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (disabled || leaving) return;
    start.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return;
    setDrag({ x: e.clientX - start.current.x, y: e.clientY - start.current.y });
  }

  function onPointerUp() {
    if (!start.current) return;
    const a = actionFor(drag.x, drag.y);
    start.current = null;
    if (a) {
      // Fling the card off-screen in the committed direction, then fire the action.
      const target =
        a === "SKIP" ? { x: 0, y: -FLING } : { x: a === "YES" ? FLING : -FLING, y: drag.y };
      setLeaving(target);
      setDrag(target);
      flingTimer.current = window.setTimeout(() => onAction(a), 180);
    } else {
      setDrag({ x: 0, y: 0 }); // spring back
    }
  }

  const a = actionFor(drag.x, drag.y);
  const rot = drag.x / 20; // tilt with horizontal drag
  // Directional hint overlay (YES green / NO red / SKIP amber), opacity grows with the drag.
  const hint =
    a === "YES"
      ? { label: "YES", color: "#16a34a", o: Math.min(1, (drag.x - 40) / 80) }
      : a === "NO"
        ? { label: "NO", color: "#dc2626", o: Math.min(1, (-drag.x - 40) / 80) }
        : a === "SKIP"
          ? { label: "SKIP", color: "#d97706", o: Math.min(1, (-drag.y - 40) / 80) }
          : null;

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "relative",
        touchAction: "none", // stop the browser from scrolling/zooming on drag
        cursor: disabled ? "default" : "grab",
        transform: `translate(${drag.x}px, ${drag.y}px) rotate(${rot}deg)`,
        transition: leaving || start.current === null ? "transform 0.18s ease-out" : "none",
      }}
    >
      {hint && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            padding: "4px 12px",
            border: `3px solid ${hint.color}`,
            color: hint.color,
            borderRadius: 8,
            fontWeight: 800,
            fontSize: 22,
            opacity: hint.o,
            transform: "rotate(-12deg)",
            pointerEvents: "none",
          }}
        >
          {hint.label}
        </div>
      )}
      {children}
    </div>
  );
}
