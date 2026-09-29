// The deck's swipe physics on the UI thread. The card follows the finger through Reanimated shared
// values driven by a gesture-handler Pan, so a drag never waits on the JS thread — the old
// PanResponder + JS-driven Animated version dropped 95% of frames on the emulator (median frame 89 ms)
// whenever JS was busy. Same rules as before (and as the web's useCardSwipe): right = YES, left = NO,
// a clearly-vertical upward drag = SKIP; a release past COMMIT_PX flings the card off and hands the
// commit to JS mid-fling, anything shorter springs back.
import { useEffect, useRef } from "react";
import { Gesture } from "react-native-gesture-handler";
import { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

export type SwipeDir = "YES" | "NO" | "SKIP";
export const COMMIT_PX = 130; // drag distance past which a release commits (design-locked, same as web)
const FLY_MS = 260; // outgoing card animates off-screen for this long
const MOVE_EPS = 5; // px of travel before a press counts as a drag
const SPRING = { damping: 14, stiffness: 180 };

export function useSwipeCard({ enabled, onCommit, restoreAfterFling = false }: {
  enabled: boolean;
  onCommit: (dir: SwipeDir) => void;
  // A card that may survive its own commit (a REAL stock buy keeps it until the lot is booked, and a
  // cancelled one keeps it for good): if it is still mounted after the fling, bring it back and
  // re-arm the gesture, so the deck the user sees is the deck the buttons act on.
  restoreAfterFling?: boolean;
}) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const committed = useSharedValue(false);
  const onCommitRef = useRef(onCommit);
  useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // JS side of a commit, called when the fling has FINISHED. Handing off mid-fling (as the old JS
  // version did) unmounted the card while Reanimated was still animating it, and every remaining
  // frame threw "Unable to find SurfaceMountingManager" with a stack trace on the UI thread — 132 per
  // swipe on the emulator, which is what made every frame janky.
  const commitOnJs = (dir: SwipeDir) => {
    onCommitRef.current(dir);
    if (restoreAfterFling) {
      setTimeout(() => {
        if (!mounted.current) return;
        committed.set(false);
        x.set(withSpring(0, SPRING));
        y.set(withSpring(0, SPRING));
      }, 150);
    }
  };

  const gesture = Gesture.Pan()
    .enabled(enabled)
    .minDistance(MOVE_EPS)
    .onUpdate((e) => {
      if (committed.get()) return;
      x.set(e.translationX);
      y.set(e.translationY);
    })
    .onEnd((e) => {
      if (committed.get()) return;
      const ax = Math.abs(e.translationX), ay = Math.abs(e.translationY);
      let dir: SwipeDir, progress: number;
      if (ay > ax * 1.15 && e.translationY < 0) { dir = "SKIP"; progress = Math.min(1, ay / COMMIT_PX); }
      else { dir = e.translationX > 0 ? "YES" : "NO"; progress = Math.min(1, ax / COMMIT_PX); }
      if (progress >= 1) {
        committed.set(true);
        x.set(withTiming(dir === "YES" ? 520 : dir === "NO" ? -520 : 0, { duration: FLY_MS }));
        y.set(withTiming(dir === "SKIP" ? -760 : -90, { duration: FLY_MS }, (finished) => {
          if (finished) scheduleOnRN(commitOnJs, dir);
        }));
      } else {
        x.set(withSpring(0, SPRING));
        y.set(withSpring(0, SPRING));
      }
    })
    .onFinalize((_e, success) => {
      // A cancelled gesture (another handler took over) must not leave the card mid-air.
      if (!success && !committed.get()) {
        x.set(withSpring(0, SPRING));
        y.set(withSpring(0, SPRING));
      }
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.get() },
      { translateY: y.get() },
      { rotate: `${interpolate(x.get(), [-160, 160], [-9, 9], Extrapolation.CLAMP)}deg` },
    ],
  }));
  const yesStyle = useAnimatedStyle(() => ({ opacity: interpolate(x.get(), [0, COMMIT_PX], [0, 1], Extrapolation.CLAMP) }));
  const noStyle = useAnimatedStyle(() => ({ opacity: interpolate(x.get(), [-COMMIT_PX, 0], [1, 0], Extrapolation.CLAMP) }));
  const skipStyle = useAnimatedStyle(() => ({ opacity: interpolate(y.get(), [-COMMIT_PX, 0], [1, 0], Extrapolation.CLAMP) }));

  return { gesture, cardStyle, yesStyle, noStyle, skipStyle };
}
