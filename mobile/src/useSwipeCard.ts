// The deck's swipe physics — a 1:1 port of the web's useCardSwipe (src/app/useCardSwipe.ts) and
// SwipeShell's rise (src/app/DeckCard.tsx + globals.css hfCardRise), driven entirely on the UI
// thread. gesture-handler's PanGestureHandler feeds the finger's translation straight into Animated
// values on the NATIVE driver, and every derived property (rotation, stamp/overlay intensity, the
// SKIP-vs-sideways classification itself) is an Animated node graph, so a drag never waits on JS and
// never re-renders React. (Reanimated was tried and dropped: on this RN version it threw on every
// frame after a card unmounted, and added ~2 s to startup.)
//
// The web's numbers, verbatim:
//   drag      translate(dx,dy) rotate(dx * 0.05deg), no transition
//   classify  |dy| > |dx| * 1.15 && dy < 0 → SKIP (progress |dy|/130), else YES/NO (progress |dx|/130)
//   release   progress >= 1 → fling; else spring back: transform .45s cubic-bezier(.34,1.4,.5,1)
//   fling     YES translate(150%,-12%) rotate(26deg) · NO translate(-150%,-12%) rotate(-26deg) ·
//             SKIP translate(0,-170%) rotate(-3deg) — % of the card's own size — over 380ms
//             cubic-bezier(.45,0,.25,1), opacity → 0 over 380ms `ease`; onCommit at 190ms; a card
//             still mounted at 440ms (a refused act) springs back, opacity snapping to 1
//   stamps    only the CURRENT drag direction shows, and only while the finger is down:
//             opacity (p - .15) / .5, scale .6 + .4p; directional overlay opacity = p
//   rise      a card that becomes top grows from the preview pose — scale(.957) translateY(13px),
//             brightness(.82), origin center bottom — over 320ms cubic-bezier(.34,1.2,.5,1);
//             grabbing it mid-rise cancels the rise
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, type LayoutChangeEvent } from "react-native";
import { type PanGestureHandlerStateChangeEvent, State } from "react-native-gesture-handler";

export type SwipeDir = "YES" | "NO" | "SKIP";
export const COMMIT_PX = 130; // drag distance past which a release commits (design-locked, web COMMIT_PX)
const FLY_MS = 380; // web FLY_MS
export const RISE_MS = 320; // web RISE_MS
const SPRING_MS = 450; // web: transform .45s on spring-back
const MOVE_EPS = 5; // web MOVE_EPS — px of travel before a press is a drag, not a tap
const DEG_PER_PX = 0.05; // web: rotate(dx * 0.05deg)
// Down is not a direction (only YES / NO / SKIP-up commit), so a downward drag is rubber-banded: the
// card follows at a fifth of the finger and stops 80 px down, instead of sliding over the action
// buttons and uncovering the card behind it (seen on the Seeker, 2026-10-04). Display only — the
// release classification below still reads the raw translation, so nothing a drag can do changes.
const DOWN_FOLLOW_PX = 400;
const DOWN_MAX_PX = 80;
// Resting pose of the card waiting behind the top one (web PREVIEW_SCALE / PREVIEW_Y). brightness(.82)
// is a black veil at .18: brightness multiplies each channel by .82, which is exactly what an 18%
// black layer composited on top does — no offscreen filter pass.
export const PREVIEW_SCALE = 0.957;
export const PREVIEW_Y = 13;
export const PREVIEW_VEIL = 0.18;

const SPRING_EASE = Easing.bezier(0.34, 1.4, 0.5, 1);
const FLY_EASE = Easing.bezier(0.45, 0, 0.25, 1);
const RISE_EASE = Easing.bezier(0.34, 1.2, 0.5, 1);
const CSS_EASE = Easing.bezier(0.25, 0.1, 0.25, 1); // CSS `ease` — the web's opacity transition

// Where a card sits in the stack. One component renders every role and the role is a prop, so the card
// behind the top one is PROMOTED in place (no remount of its face mid-fling — that remount was the
// 100–150 ms hitch at every hand-off); "hidden" is the one after it, premounted and invisible.
export type StackRole = "top" | "next" | "hidden";

export function useSwipeCard({ role, enabled, onCommit }: {
  role: StackRole;
  enabled: boolean;
  onCommit: (dir: SwipeDir) => void;
}) {
  // Created once per card (lazy state, not a ref read during render).
  const [{ x, y, rx, fade, rise, active }] = useState(() => ({
    x: new Animated.Value(0), // drag/fling translation, px
    y: new Animated.Value(0),
    rx: new Animated.Value(0), // rotation beyond dx*0.05 — carries a fling to its exact end angle
    fade: new Animated.Value(1),
    rise: new Animated.Value(0), // 0 = preview pose, 1 = top card
    active: new Animated.Value(0), // 1 while the finger is down (web drag.active)
  }));

  const size = useRef({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  };

  const committed = useRef(false);
  const rising = useRef<Animated.CompositeAnimation | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const onCommitRef = useRef(onCommit);
  useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  // Becoming the top card plays the rise once (web: SwipeShell mounts with `entering`).
  useEffect(() => {
    if (role !== "top") return;
    const a = Animated.timing(rise, { toValue: 1, duration: RISE_MS, easing: RISE_EASE, useNativeDriver: true });
    rising.current = a;
    a.start(() => { rising.current = null; });
    return () => a.stop();
  }, [role, rise]);

  const springBack = () =>
    Animated.parallel([
      Animated.timing(x, { toValue: 0, duration: SPRING_MS, easing: SPRING_EASE, useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: SPRING_MS, easing: SPRING_EASE, useNativeDriver: true }),
      Animated.timing(rx, { toValue: 0, duration: SPRING_MS, easing: SPRING_EASE, useNativeDriver: true }),
    ]).start();

  // Native-driven: the gesture's translation lands in x/y on the UI thread, no JS per move event.
  const onGestureEvent = useMemo(
    () => Animated.event([{ nativeEvent: { translationX: x, translationY: y } }], { useNativeDriver: true }),
    [x, y],
  );

  const onHandlerStateChange = (e: PanGestureHandlerStateChangeEvent) => {
    const { state, translationX, translationY } = e.nativeEvent;
    if (committed.current) return;
    if (state === State.BEGAN) {
      // Grabbing the card cancels the entering rise so the drag takes over cleanly (web onPointerDown).
      if (rising.current) { rising.current.stop(); rising.current = null; rise.setValue(1); }
      return;
    }
    if (state === State.ACTIVE) { active.setValue(1); return; }
    active.setValue(0); // released or cancelled: stamps and overlays drop at once (web reset())
    if (state === State.CANCELLED || state === State.FAILED) { springBack(); return; }
    if (state !== State.END) return;
    const ax = Math.abs(translationX), ay = Math.abs(translationY);
    let dir: SwipeDir, progress: number;
    if (ay > ax * 1.15 && translationY < 0) { dir = "SKIP"; progress = Math.min(1, ay / COMMIT_PX); }
    else { dir = translationX > 0 ? "YES" : "NO"; progress = Math.min(1, ax / COMMIT_PX); }
    if (progress < 1) { springBack(); return; }

    committed.current = true;
    const w = size.current.w || 400, h = size.current.h || 600;
    const tx = dir === "YES" ? 1.5 * w : dir === "NO" ? -1.5 * w : 0;
    const ty = dir === "SKIP" ? -1.7 * h : -0.12 * h;
    const endDeg = dir === "YES" ? 26 : dir === "NO" ? -26 : -3;
    const fly = (val: Animated.Value, toValue: number) =>
      Animated.timing(val, { toValue, duration: FLY_MS, easing: FLY_EASE, useNativeDriver: true });
    Animated.parallel([
      fly(x, tx),
      fly(y, ty),
      // rotation = x*0.05 + rx; easing rx to (end - tx*0.05) on the same curve makes the angle
      // travel linearly (in eased time) from the release angle to the web's end angle.
      fly(rx, endDeg - tx * DEG_PER_PX),
      Animated.timing(fade, { toValue: 0, duration: FLY_MS, easing: CSS_EASE, useNativeDriver: true }),
    ]).start();
    // Hand off mid-fling so the next card starts rising at the 50% point (web flyTimer).
    timers.current.push(setTimeout(() => onCommitRef.current(dir), Math.round(FLY_MS / 2)));
    // A consumed card is unmounted long before this fires; only a card the caller refused to consume
    // (a gated act, a real stock buy still booking) sees it, and springs back visible and grabbable.
    timers.current.push(setTimeout(() => {
      committed.current = false;
      fade.setValue(1);
      springBack();
    }, FLY_MS + 60));
  };

  const styles = useMemo(() => {
    // Direction classification as a node graph: skipOn = 1 when -dy > 1.15|dx| (web's up-bias).
    const absX = x.interpolate({ inputRange: [-1, 0, 1], outputRange: [1, 0, 1] });
    const upBias = Animated.add(Animated.multiply(y, -1), Animated.multiply(absX, -1.15));
    const skipOn = upBias.interpolate({ inputRange: [0, 0.01], outputRange: [0, 1], extrapolate: "clamp" });
    const sideOn = Animated.multiply(Animated.subtract(1, skipOn), active);
    const clamp = "clamp" as const;
    const yesP = Animated.multiply(x.interpolate({ inputRange: [0, COMMIT_PX], outputRange: [0, 1], extrapolate: clamp }), sideOn);
    const noP = Animated.multiply(x.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: clamp }), sideOn);
    const skipP = Animated.multiply(
      Animated.multiply(y.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: clamp }), skipOn),
      active,
    );
    const stamp = (p: Animated.AnimatedMultiplication<number>, rot: string) => ({
      opacity: p.interpolate({ inputRange: [0.15, 0.65], outputRange: [0, 1], extrapolate: clamp }),
      transform: [{ rotate: rot }, { scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1], extrapolate: clamp }) }],
    });
    // Up (negative) passes through 1:1 — the first segment's slope extends to the left; down is
    // scaled by DOWN_MAX_PX / DOWN_FOLLOW_PX and clamped.
    const shownY = y.interpolate({
      inputRange: [-1, 0, DOWN_FOLLOW_PX],
      outputRange: [-1, 0, DOWN_MAX_PX],
      extrapolateLeft: "extend",
      extrapolateRight: clamp,
    });
    const rotate = Animated.add(Animated.multiply(x, DEG_PER_PX), rx).interpolate({ inputRange: [0, 1], outputRange: ["0deg", "1deg"] });
    return {
      // Outer layer: the stack pose (scale about the bottom edge, like transform-origin center bottom).
      riseStyle: {
        transformOrigin: "bottom" as const,
        transform: [
          { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_SCALE, 1] }) },
          { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_Y, 0] }) },
        ],
      },
      // Inner layer: the finger (rotation about the centre, like the web's drag transform).
      cardStyle: { opacity: fade, transform: [{ translateX: x }, { translateY: shownY }, { rotate }] },
      veilStyle: { opacity: rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_VEIL, 0] }) },
      yesOverlay: { opacity: yesP },
      noOverlay: { opacity: noP },
      skipOverlay: { opacity: skipP },
      yesStamp: stamp(yesP, "15deg"),
      noStamp: stamp(noP, "-15deg"),
      skipStamp: stamp(skipP, "0deg"),
    };
  }, [x, y, rx, fade, rise, active]);

  const handlerProps = { enabled: enabled && role === "top", minDist: MOVE_EPS, onGestureEvent, onHandlerStateChange };
  return { handlerProps, onLayout, ...styles };
}
