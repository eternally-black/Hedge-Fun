// The deck's swipe physics, driven natively. gesture-handler's PanGestureHandler feeds the finger's
// translation straight into Animated values on the NATIVE driver, so a drag never waits on the JS
// thread — the old PanResponder + JS-driven Animated version dropped 95% of frames on the emulator
// (median frame 89 ms) whenever JS was busy. (Reanimated was tried first and dropped: on this RN
// version it threw on every frame after a card unmounted, and added ~2 s to startup.)
// Same rules as before and as the web's useCardSwipe: right = YES, left = NO, a clearly-vertical
// upward drag = SKIP; a release past COMMIT_PX flings the card off, anything shorter springs back.
import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import { type PanGestureHandlerStateChangeEvent, State } from "react-native-gesture-handler";

export type SwipeDir = "YES" | "NO" | "SKIP";
export const COMMIT_PX = 130; // drag distance past which a release commits (design-locked, same as web)
const FLY_MS = 260; // outgoing card animates off-screen for this long
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
  const committed = useRef(false);
  const onCommitRef = useRef(onCommit);
  useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

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
    Animated.parallel([
      Animated.timing(x, { toValue: dir === "YES" ? 520 : dir === "NO" ? -520 : 0, duration: FLY_MS, useNativeDriver: true }),
      Animated.timing(y, { toValue: dir === "SKIP" ? -760 : -90, duration: FLY_MS, useNativeDriver: true }),
    ]).start(() => {
      onCommitRef.current(dir);
      if (restoreAfterFling) {
        setTimeout(() => {
          if (!mounted.current) return;
          committed.current = false;
          springBack();
        }, 150);
      }
    });
  };

  const rotate = x.interpolate({ inputRange: [-160, 160], outputRange: ["-9deg", "9deg"], extrapolate: "clamp" });
  const cardStyle = { transform: [{ translateX: x }, { translateY: y }, { rotate }] };
  const yesStyle = { opacity: x.interpolate({ inputRange: [0, COMMIT_PX], outputRange: [0, 1], extrapolate: "clamp" }) };
  const noStyle = { opacity: x.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" }) };
  const skipStyle = { opacity: y.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" }) };

  const handlerProps = { enabled, minDist: MOVE_EPS, onGestureEvent, onHandlerStateChange };
  return { handlerProps, cardStyle, yesStyle, noStyle, skipStyle };
}
