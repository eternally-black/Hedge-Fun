// SwipeShell — the native twin of the web's SwipeShell (src/app/DeckCard.tsx): one card in the deck
// stack, with the gesture, the rise out of the stack, the fling and the web's exact layering —
// background → directional overlays → stamps → content. Both decks (predictions and stocks) wrap
// their faces in it, so the two move identically, as they do on the web.
//
// Performance: everything that moves is a native-driver Animated node (transform, opacity, stamp
// scale); nothing in a drag or a fling re-renders React. The overlays are native gradient backgrounds,
// not SVG (see the note at the overlays). Hardware-texture layers on the faces were measured on the
// Seeker and made no difference to frame cadence, so they are not used (they cost ~7 MB per face).
import type { ReactNode } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { PanGestureHandler } from "react-native-gesture-handler";
import { colors } from "../theme";
import { type StackRole, type SwipeDir, useSwipeCard } from "../useSwipeCard";

export function SwipeShell({ role, enabled, onCommit, stampLabels, background, children }: {
  role: StackRole;
  enabled: boolean; // false = ignore gestures (busy)
  onCommit: (dir: SwipeDir) => void;
  stampLabels: { yes: string; no: string };
  background: ReactNode; // static — skin, tint, scrim
  children: ReactNode; // the content, drawn above the stamps (web CardFace order)
}) {
  const s = useSwipeCard({ role, enabled, onCommit });
  const top = role === "top";
  return (
    <Animated.View
      style={[styles.fill, s.riseStyle, role === "hidden" && styles.hidden]}
      pointerEvents={top ? "auto" : "none"}
    >
      <PanGestureHandler {...s.handlerProps}>
        <Animated.View style={[styles.fill, styles.radius, top && styles.shadow, s.cardStyle]} onLayout={s.onLayout}>
          <View style={[styles.fill, styles.clip]}>
            <View style={styles.fill} pointerEvents="none">{background}</View>

            {/* The web's directional overlays, as native gradient backgrounds (GPU shaders). Not
                react-native-svg: on Android every SvgView rasterises in software into a card-sized
                bitmap (~20 ms each on the Seeker) and uploads it as a texture — three per card was
                most of the hitch when a card mounted. */}
            <Animated.View style={[styles.fill, styles.yesOverlay, s.yesOverlay]} pointerEvents="none" />
            <Animated.View style={[styles.fill, styles.noOverlay, s.noOverlay]} pointerEvents="none" />
            <Animated.View style={[styles.fill, styles.skipOverlay, s.skipOverlay]} pointerEvents="none" />

            <Stamp label={stampLabels.no} color={colors.no} pos={styles.stampNo} style={s.noStamp} />
            <Stamp label={stampLabels.yes} color={colors.yes} pos={styles.stampYes} style={s.yesStamp} />
            <Stamp label="SKIP" color={colors.skip} pos={styles.stampSkip} style={s.skipStamp} />

            <View style={styles.fill} pointerEvents="box-none">{children}</View>
            {/* brightness(.82) of the preview pose, fading out as the card rises (hfCardRise) */}
            <Animated.View style={[styles.fill, styles.veil, s.veilStyle]} pointerEvents="none" />
          </View>
        </Animated.View>
      </PanGestureHandler>
    </Animated.View>
  );
}

function Stamp({ label, color, pos, style }: { label: string; color: string; pos: object; style: object }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.stamp, pos, { borderColor: color, boxShadow: `0 0 24px ${color}66` }, style]}
    >
      <Text style={[styles.stampText, { color }]} numberOfLines={1}>{label}</Text>
    </Animated.View>
  );
}

function rgba(hex: string, a: number): string {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
}

const styles = StyleSheet.create({
  fill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  hidden: { opacity: 0 },
  radius: { borderRadius: 26 },
  // web: box-shadow 0 24px 50px -18px rgba(0,0,0,.7) on the live card only
  shadow: { boxShadow: "0 24px 50px -18px rgba(0,0,0,0.7)" },
  clip: { borderRadius: 26, overflow: "hidden", backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line },
  veil: { backgroundColor: "#000" },
  // web: linear-gradient(270deg | 90deg, color-mix(side 70%, transparent), transparent 65%) and
  // radial-gradient(120% 70% at 50% 34%, color-mix(skip 60%, transparent), transparent 62%). The
  // transparent stop keeps the side's own RGB so the fade does not pass through grey.
  yesOverlay: { experimental_backgroundImage: `linear-gradient(270deg, ${rgba(colors.yes, 0.7)}, ${rgba(colors.yes, 0)} 65%)` },
  noOverlay: { experimental_backgroundImage: `linear-gradient(90deg, ${rgba(colors.no, 0.7)}, ${rgba(colors.no, 0)} 65%)` },
  skipOverlay: { experimental_backgroundImage: `radial-gradient(120% 70% at 50% 34%, ${rgba(colors.skip, 0.6)}, ${rgba(colors.skip, 0)} 62%)` },
  stamp: { position: "absolute", borderWidth: 5, borderRadius: 12, paddingVertical: 2, paddingHorizontal: 16, maxWidth: 240 },
  stampNo: { top: 42, left: 26 },
  stampYes: { top: 42, right: 26 },
  stampSkip: { top: 30, left: "50%", marginLeft: -62 },
  stampText: { fontSize: 40, fontWeight: "900", textAlign: "center" },
});
