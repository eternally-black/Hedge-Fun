// Swipeable market card — the native port of src/app/useCardSwipe.ts physics over the deck card
// face. Right = YES (side A), left = NO (side B), up = SKIP. Follow-the-finger drag → release past
// COMMIT_PX commits with a fling-off, else springs back. The parent is handed the commit mid-fling
// so the next card rises in sync (same hand-off as web).
import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, StyleSheet, Text, View } from "react-native";
import type { DeckCard as DeckCardT } from "../../lib/api-types";
import { colors } from "../theme";
import { catOf, cents, countdown, displayQuestion, isUpDown, marketHint, sideLabels, usd, winPayout } from "../format";

export type SwipeDir = "YES" | "NO" | "SKIP";

export const COMMIT_PX = 130; // drag distance past which a release commits (design-locked, same as web)
const FLY_MS = 380; // outgoing card animates off-screen for this long
const MOVE_EPS = 5; // px of travel before a press counts as a drag

// A card is "fresh" while it has more than the lead buffer left before resolution. Stale cards are
// pruned from the deck so a swipe never lands on a near-resolved (⏱ -> 0:00) market.
export function isFresh(c: DeckCardT, nowMs: number, minLeadMs: number): boolean {
  return new Date(c.resolutionDeadline).getTime() - nowMs > minLeadMs;
}

// Per-card 1s clock (web: DeckCard.useCountdown) — each visible card ticks itself.
function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

export function DeckCard({ card, stakeCents, enabled, onCommit }: {
  card: DeckCardT;
  stakeCents: number;
  enabled: boolean; // false = ignore gestures (busy/flying)
  onCommit: (dir: SwipeDir) => void;
}) {
  const pan = useRef(new Animated.ValueXY()).current;
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  const committedRef = useRef(false);
  const onCommitRef = useRef(onCommit);
  useEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => enabledRef.current && !committedRef.current,
      onMoveShouldSetPanResponder: (_e, g) =>
        enabledRef.current && !committedRef.current && (Math.abs(g.dx) > MOVE_EPS || Math.abs(g.dy) > MOVE_EPS),
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderTerminate: () => {
        Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
      },
      onPanResponderRelease: (_e, g) => {
        const ax = Math.abs(g.dx), ay = Math.abs(g.dy);
        // Up-bias matches the web deck: a clearly-vertical upward drag is SKIP; else horizontal YES/NO.
        let dir: SwipeDir, progress: number;
        if (ay > ax * 1.15 && g.dy < 0) { dir = "SKIP"; progress = Math.min(1, ay / COMMIT_PX); }
        else { dir = g.dx > 0 ? "YES" : "NO"; progress = Math.min(1, ax / COMMIT_PX); }

        if (progress >= 1) {
          committedRef.current = true;
          const toValue = dir === "YES" ? { x: 520, y: -90 } : dir === "NO" ? { x: -520, y: -90 } : { x: 0, y: -760 };
          Animated.timing(pan, { toValue, duration: FLY_MS, useNativeDriver: false }).start();
          // Hand off mid-fling so the next card starts rising at the 50% point (overlap).
          setTimeout(() => onCommitRef.current(dir), Math.round(FLY_MS / 2));
        } else {
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false, bounciness: 14 }).start();
        }
      },
    }),
  ).current;

  const rotate = pan.x.interpolate({ inputRange: [-160, 160], outputRange: ["-9deg", "9deg"], extrapolate: "clamp" });
  const yesOpacity = pan.x.interpolate({ inputRange: [0, COMMIT_PX], outputRange: [0, 1], extrapolate: "clamp" });
  const noOpacity = pan.x.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" });
  const skipOpacity = pan.y.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" });

  return (
    <Animated.View
      style={[styles.card, { transform: [...pan.getTranslateTransform(), { rotate }] }]}
      {...responder.panHandlers}
    >
      <CardFace card={card} stakeCents={stakeCents} />
      {/* direction stamps, driven by drag progress */}
      <Animated.View style={[styles.stamp, styles.stampLeft, { opacity: noOpacity, borderColor: colors.no }]}>
        <StampText card={card} dir="NO" />
      </Animated.View>
      <Animated.View style={[styles.stamp, styles.stampRight, { opacity: yesOpacity, borderColor: colors.yes }]}>
        <StampText card={card} dir="YES" />
      </Animated.View>
      <Animated.View style={[styles.stamp, styles.stampTop, { opacity: skipOpacity, borderColor: colors.skip }]}>
        <Text style={[styles.stampText, { color: colors.skip }]}>SKIP</Text>
      </Animated.View>
    </Animated.View>
  );
}

// The next card, fully rendered behind the top one (not a gray stub) — static, no gestures.
export function CardPreview({ card }: { card: DeckCardT }) {
  return (
    <View style={[styles.card, styles.preview]} pointerEvents="none">
      <CardFace card={card} stakeCents={null} dimmed />
    </View>
  );
}

function StampText({ card, dir }: { card: DeckCardT; dir: "YES" | "NO" }) {
  const labels = sideLabels(card);
  const label = dir === "YES" ? labels.yes : labels.no;
  return (
    <Text style={[styles.stampText, { color: dir === "YES" ? colors.yes : colors.no }]} numberOfLines={1}>
      {label}
    </Text>
  );
}

// The card face: category + ⏱ cutoff, question, hint, odds split (real side labels, cents), and
// the stake/payout footer. stakeCents null hides the footer (preview).
function CardFace({ card, stakeCents, dimmed = false }: { card: DeckCardT; stakeCents: number | null; dimmed?: boolean }) {
  const nowMs = useNowMs();
  const cat = catOf(card);
  const labels = sideLabels(card);
  const hint = marketHint(card);
  const cd = countdown(card.resolutionDeadline, nowMs);

  return (
    <View style={[styles.face, dimmed && { opacity: 0.75 }]}>
      <View style={styles.topRow}>
        <View style={styles.badge}>
          <View style={[styles.badgeDot, { backgroundColor: cat.color }]} />
          <Text style={styles.badgeText}>{cat.label}</Text>
        </View>
        <View style={[styles.badge, cd.urgent && styles.badgeUrgent]}>
          <Text style={styles.badgeText}>⏱ <Text style={cd.urgent ? styles.timerUrgent : styles.timer}>{cd.text}</Text></Text>
        </View>
      </View>

      <View style={styles.middle}>
        <Text style={styles.question} numberOfLines={4}>{displayQuestion(card)}</Text>
        {isUpDown(card)
          ? <Text style={styles.hint}>{cd.relText}</Text>
          : hint ? <Text style={styles.hint} numberOfLines={2}>{hint}</Text> : null}
      </View>

      {/* odds split — real side labels, prices in CENTS (52¢), spread is real (need not sum to 100¢) */}
      <View>
        <View style={styles.oddsRow}>
          <Text style={[styles.oddsSide, { color: colors.no }]} numberOfLines={1}>{labels.no} {cents(card.noPriceBp)}</Text>
          <Text style={[styles.oddsSide, { color: colors.yes }]} numberOfLines={1}>{cents(card.yesPriceBp)} {labels.yes}</Text>
        </View>
        <View style={styles.oddsBar}>
          <View style={{ width: `${card.noPriceBp / 100}%`, backgroundColor: colors.no, height: "100%" }} />
          <View style={{ flex: 1, backgroundColor: colors.yes, height: "100%" }} />
        </View>
        {stakeCents !== null && (
          <View style={styles.payoutRow}>
            <Text style={styles.payoutText}>
              {usd(stakeCents)} on <Text style={{ color: colors.yes, fontWeight: "700" }}>{labels.yes}</Text> → win ${winPayout(card.yesPriceBp, stakeCents)}
            </Text>
            <Text style={styles.payoutText}>
              <Text style={{ color: colors.no, fontWeight: "700" }}>{labels.no}</Text> → win ${winPayout(card.noPriceBp, stakeCents)}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 26, overflow: "hidden",
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  preview: { transform: [{ scale: 0.95 }, { translateY: -10 }], opacity: 0.9 },
  face: { flex: 1, padding: 16 },
  topRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  badge: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.4)",
    paddingVertical: 4, paddingHorizontal: 9, borderRadius: 18,
  },
  badgeUrgent: { borderWidth: 1, borderColor: "rgba(255,59,78,0.6)" },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { color: "#fff", fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: "700" },
  timer: { fontFamily: "monospace", fontSize: 12, letterSpacing: 0 },
  timerUrgent: { fontFamily: "monospace", fontSize: 12, letterSpacing: 0, color: colors.no },
  middle: { flex: 1, justifyContent: "center", paddingVertical: 8 },
  question: { color: "#fff", fontSize: 22, lineHeight: 26, fontWeight: "800", letterSpacing: 0.2 },
  hint: { marginTop: 8, fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 15 },
  oddsRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5, gap: 8 },
  oddsSide: { fontFamily: "monospace", fontWeight: "700", fontSize: 12, flexShrink: 1 },
  oddsBar: { flexDirection: "row", height: 10, borderRadius: 6, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.4)" },
  payoutRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 10, gap: 8 },
  payoutText: { color: "rgba(255,255,255,0.55)", fontSize: 10, flexShrink: 1 },
  stamp: {
    position: "absolute", paddingVertical: 6, paddingHorizontal: 14, borderRadius: 12,
    borderWidth: 3, backgroundColor: "rgba(10,10,15,0.75)", maxWidth: "80%",
  },
  stampLeft: { top: 42, left: 18, transform: [{ rotate: "-14deg" }] },
  stampRight: { top: 42, right: 18, transform: [{ rotate: "14deg" }] },
  stampTop: { top: 20, alignSelf: "center" },
  stampText: { fontSize: 22, fontWeight: "900", letterSpacing: 1 },
});
