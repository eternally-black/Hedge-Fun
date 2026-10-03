// The deck's swipe physics, driven natively. gesture-handler's PanGestureHandler feeds the finger's
// translation straight into Animated values on the NATIVE driver, so a drag never waits on the JS
// thread — the old PanResponder + JS-driven Animated version dropped 95% of frames on the emulator
// (median frame 89 ms) whenever JS was busy. (Reanimated was tried first and dropped: on this RN
// version it threw on every frame after a card unmounted, and added ~2 s to startup.)
// Same rules as before and as the web's useCardSwipe: right = YES, left = NO, a clearly-vertical
// upward drag = SKIP; a release past COMMIT_PX flings the card off, anything shorter springs back.
// The hand-off is the web's too (src/app/useCardSwipe.ts + DeckCard hfCardRise): the commit fires
// HALFWAY through the fling so the next card is already rising while this one flies and fades out,
// and a newly mounted top card rises out of the preview pose instead of snapping to full size.
import { useEffect, useRef } from "react";
import { Animated, Easing } from "react-native";
import { type PanGestureHandlerStateChangeEvent, State } from "react-native-gesture-handler";

export type SwipeDir = "YES" | "NO" | "SKIP";
export const COMMIT_PX = 130; // drag distance past which a release commits (design-locked, same as web)
const FLY_MS = 380; // outgoing card flies off + fades for this long (web FLY_MS)
const RISE_MS = 320; // the next card rises into the top slot for this long (web RISE_MS)
// Resting pose of the card waiting behind the top one (web PREVIEW_SCALE / PREVIEW_Y; opacity on the
// dark backdrop stands in for the web's brightness(.82)). The rise starts from EXACTLY this pose.
export const PREVIEW_SCALE = 0.957;
export const PREVIEW_Y = 13;
export const PREVIEW_OPACITY = 0.82;
export const previewPose = {
  transform: [{ translateY: PREVIEW_Y }, { scale: PREVIEW_SCALE }],
  opacity: PREVIEW_OPACITY,
};
const MOVE_EPS = 5; // px of travel before a press counts as a drag

export function useSwipeCard({ enabled, onCommit, restoreAfterFling = false }: {
  enabled: boolean;
  onCommit: (dir: SwipeDir) => void;
  // A card that may survive its own commit (a REAL stock buy keeps it until the lot is booked, and a
  // cancelled one keeps it for good): if it is still mounted after the fling, bring it back and
  // re-arm the gesture, so the deck the user sees is the deck the buttons act on.
  restoreAfterFling?: boolean;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(0)).current; // 0 = preview pose, 1 = top card
  const fade = useRef(new Animated.Value(1)).current; // drops to 0 during a fling, like the web
  const committed = useRef(false);
  const onCommitRef = useRef(onCommit);
  useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    const a = Animated.timing(rise, { toValue: 1, duration: RISE_MS, easing: Easing.bezier(0.34, 1.2, 0.5, 1), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [rise]);

  const springBack = () =>
    Animated.parallel([
      Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 14 }),
      Animated.spring(y, { toValue: 0, useNativeDriver: true, bounciness: 14 }),
    ]).start();

  // Native-driven: the gesture's translation lands in x/y on the UI thread, no JS per move event.
  const onGestureEvent = useRef(
    Animated.event([{ nativeEvent: { translationX: x, translationY: y } }], { useNativeDriver: true }),
  ).current;

  const onHandlerStateChange = (e: PanGestureHandlerStateChangeEvent) => {
    const { state, translationX, translationY } = e.nativeEvent;
    if (committed.current) return;
    if (state === State.CANCELLED || state === State.FAILED) { springBack(); return; }
    if (state !== State.END) return;
    const ax = Math.abs(translationX), ay = Math.abs(translationY);
    let dir: SwipeDir, progress: number;
    if (ay > ax * 1.15 && translationY < 0) { dir = "SKIP"; progress = Math.min(1, ay / COMMIT_PX); }
    else { dir = translationX > 0 ? "YES" : "NO"; progress = Math.min(1, ax / COMMIT_PX); }
    if (progress < 1) { springBack(); return; }
    committed.current = true;
    const easing = Easing.bezier(0.45, 0, 0.25, 1);
    Animated.parallel([
      Animated.timing(x, { toValue: dir === "YES" ? 540 : dir === "NO" ? -540 : 0, duration: FLY_MS, easing, useNativeDriver: true }),
      Animated.timing(y, { toValue: dir === "SKIP" ? -1000 : -70, duration: FLY_MS, easing, useNativeDriver: true }),
      Animated.timing(fade, { toValue: 0, duration: FLY_MS, useNativeDriver: true }),
    ]).start(() => {
      if (!restoreAfterFling) return;
      setTimeout(() => {
        if (!mounted.current) return;
        committed.current = false;
        Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start();
        springBack();
      }, 150);
    });
    // Hand off mid-fling: the parent advances now, so the next card rises while this one leaves.
    setTimeout(() => onCommitRef.current(dir), Math.round(FLY_MS / 2));
  };

  // Web: rotate(dx * 0.05deg) while dragging, 26deg at the end of a fling.
  const rotate = x.interpolate({ inputRange: [-540, 540], outputRange: ["-27deg", "27deg"] });
  const riseY = Animated.add(y, rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_Y, 0] }));
  const scale = rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_SCALE, 1] });
  const opacity = Animated.multiply(fade, rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_OPACITY, 1] }));
  const cardStyle = { opacity, transform: [{ translateX: x }, { translateY: riseY }, { rotate }, { scale }] };
  const yesStyle = { opacity: x.interpolate({ inputRange: [0, COMMIT_PX], outputRange: [0, 1], extrapolate: "clamp" }) };
  const noStyle = { opacity: x.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" }) };
  const skipStyle = { opacity: y.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" }) };

  const handlerProps = { enabled, minDist: MOVE_EPS, onGestureEvent, onHandlerStateChange };
  return { handlerProps, cardStyle, yesStyle, noStyle, skipStyle };
}
