// Swipeable market card — the native port of src/app/useCardSwipe.ts physics over the deck card
// face. Right = YES (side A), left = NO (side B), up = SKIP. Follow-the-finger drag → release past
// COMMIT_PX commits with a fling-off, else springs back. The parent is handed the commit mid-fling
// so the next card rises in sync (same hand-off as web).
import { memo, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useSwipeCard } from "../useSwipeCard";
import type { DeckCard as DeckCardT } from "@contract/api-types";
import { colors } from "../theme";
import { isFootballCard, SkinBackground } from "../skins";
import { catOf, cents, countdown, displayQuestion, isMatchClock, isUpDown, marketHint, sideLabels, usd, winPayout } from "../format";

export { COMMIT_PX, type SwipeDir } from "../useSwipeCard";
import type { SwipeDir } from "../useSwipeCard";


// A card is "fresh" while it has more than the lead buffer left before resolution. Stale cards are
// pruned from the deck so a swipe never lands on a near-resolved (⏱ -> 0:00) market.
export function isFresh(c: DeckCardT, nowMs: number, minLeadMs: number): boolean {
  return new Date(c.resolutionDeadline).getTime() - nowMs > minLeadMs;
}

// Per-card 1s clock (web: DeckCard.useCountdown). Only the tiny Live* texts below own it, so the tick
// re-renders a line of text — never the whole card face (skin SVG, odds, footer) under a moving finger.
function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

export function DeckCard({ card, skinId, stakeCents, enabled, onCommit, onEditStake }: {
  card: DeckCardT;
  skinId: string; // the equipped skin — owns the whole card background (me.skins.equipped)
  stakeCents: number;
  enabled: boolean; // false = ignore gestures (busy/flying)
  onCommit: (dir: SwipeDir) => void;
  // Present only where the stake is editable (real mode, live top card). Absent → the chip stays
  // inert text, which is what a preview card sitting behind the top one has to be.
  onEditStake?: () => void;
}) {
  const { gesture, cardStyle, yesStyle, noStyle, skipStyle } = useSwipeCard({ enabled, onCommit });

  return (
    <GestureDetector gesture={gesture}>
    <Animated.View style={[styles.card, cardStyle]}>
      <CardFace card={card} skinId={skinId} stakeCents={stakeCents} onEditStake={onEditStake} />
      {/* direction stamps, driven by drag progress */}
      <Animated.View style={[styles.stamp, styles.stampLeft, { borderColor: colors.no }, noStyle]}>
        <StampText card={card} dir="NO" />
      </Animated.View>
      <Animated.View style={[styles.stamp, styles.stampRight, { borderColor: colors.yes }, yesStyle]}>
        <StampText card={card} dir="YES" />
      </Animated.View>
      <Animated.View style={[styles.stamp, styles.stampTop, { borderColor: colors.skip }, skipStyle]}>
        <Text style={[styles.stampText, { color: colors.skip }]}>SKIP</Text>
      </Animated.View>
    </Animated.View>
    </GestureDetector>
  );
}

// The next card, fully rendered behind the top one (not a gray stub) — static, no gestures.
export function CardPreview({ card, skinId }: { card: DeckCardT; skinId: string }) {
  return (
    <View style={[styles.card, styles.preview]} pointerEvents="none">
      <CardFace card={card} skinId={skinId} stakeCents={null} dimmed />
    </View>
  );
}

// The stake chip. A TouchableOpacity where it is editable, plain text where it is not — a preview
// card behind the top one must not be tappable at all.
function StakeChip({ stakeCents, onEditStake }: { stakeCents: number; onEditStake?: () => void }) {
  const body = (
    <>
      <Text style={styles.chipLabel}>Stake</Text>
      <Text style={styles.chipValue}>{usd(stakeCents)}</Text>
    </>
  );
  const box = [styles.chip, { borderColor: onEditStake ? colors.gold : colors.line }];
  if (!onEditStake) return <View style={box}>{body}</View>;
  return (
    <TouchableOpacity onPress={onEditStake} style={box} accessibilityRole="button">
      {body}
    </TouchableOpacity>
  );
}

// One side's payout at the current stake, tinted with the side's own colour (web PayBox).
function PayBox({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <View style={[styles.payBox, { backgroundColor: `${color}24`, borderColor: `${color}59` }]}>
      <Text style={[styles.payLabel, { color }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.payValue, { color }]}>{val}</Text>
    </View>
  );
}

const LiveBadge = memo(function LiveBadge({ deadline }: { deadline: string }) {
  const cd = countdown(deadline, useNowMs());
  return (
    <View style={[styles.badge, cd.urgent && styles.badgeUrgent]}>
      <Text style={styles.badgeText}>⏱ <Text style={cd.urgent ? styles.timerUrgent : styles.timer}>{cd.text}</Text></Text>
    </View>
  );
});

const LiveText = memo(function LiveText({ deadline, kind, style }: { deadline: string; kind: "rel" | "kickoff"; style: object }) {
  const cd = countdown(deadline, useNowMs());
  return <Text style={style}>{kind === "rel" ? cd.relText : `Kick-off in ${cd.text} · resolves after the match`}</Text>;
});

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
export function CardFace({ card, skinId, stakeCents, dimmed = false, onEditStake }: {
  card: DeckCardT;
  skinId: string;
  stakeCents: number | null;
  dimmed?: boolean;
  onEditStake?: () => void;
}) {
  const cat = catOf(card);
  const labels = sideLabels(card);
  const hint = marketHint(card);

  return (
    <View style={[styles.face, dimmed && { opacity: 0.75 }]}>
      {/* The equipped skin owns the background: bg → overlay → scrim, then the content below. */}
      <SkinBackground skinId={skinId} categoryColor={cat.color} isFootball={isFootballCard(card)} />
      <View style={styles.topRow}>
        <View style={styles.badge}>
          <View style={[styles.badgeDot, { backgroundColor: cat.color }]} />
          <Text style={styles.badgeText}>{cat.label}</Text>
        </View>
        <LiveBadge deadline={card.resolutionDeadline} />
      </View>

      <View style={styles.middle}>
        <Text style={styles.question} numberOfLines={4}>{displayQuestion(card)}</Text>
        {isUpDown(card)
          ? <LiveText deadline={card.resolutionDeadline} kind="rel" style={styles.hint} />
          : hint ? <Text style={styles.hint} numberOfLines={2}>{hint}</Text> : null}
        {/* What the ⏱ badge counts on a match: the kick-off, not a payout — see web CardFace. */}
        {isMatchClock(card) ? (
          <LiveText deadline={card.resolutionDeadline} kind="kickoff" style={styles.kickoff} />
        ) : null}
      </View>

      {/* odds split — real side labels, prices in CENTS (52¢), spread is real (need not sum to 100¢) */}
      <View>
        <View style={styles.oddsRow}>
          <View style={styles.oddsCol}>
            <Text style={[styles.oddsSide, { color: colors.no }]} numberOfLines={1}>{labels.no}</Text>
            <Text style={[styles.oddsSide, { color: colors.no }]}>{cents(card.noPriceBp)}</Text>
          </View>
          <View style={[styles.oddsCol, { alignItems: "flex-end" }]}>
            <Text style={[styles.oddsSide, { color: colors.yes }]} numberOfLines={1}>{labels.yes}</Text>
            <Text style={[styles.oddsSide, { color: colors.yes }]}>{cents(card.yesPriceBp)}</Text>
          </View>
        </View>
        <View style={styles.oddsBar}>
          <View style={{ width: `${card.noPriceBp / 100}%`, backgroundColor: colors.no, height: "100%" }} />
          <View style={{ flex: 1, backgroundColor: colors.yes, height: "100%" }} />
        </View>
        {stakeCents !== null && (
          <View style={styles.footerRow}>
            {/* The chip IS the control. A stake is a per-swipe amount, so the place to change it is
                the place it is stated — not a settings screen two taps away from the gesture it
                governs. Inert text where the stake is not editable (a preview card). */}
            <StakeChip stakeCents={stakeCents} onEditStake={onEditStake} />
            <View style={styles.payRow}>
              <PayBox label={labels.no} val={usd(winPayout(card.noPriceBp, stakeCents))} color={colors.no} />
              <PayBox label={labels.yes} val={usd(winPayout(card.yesPriceBp, stakeCents))} color={colors.yes} />
            </View>
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
  kickoff: { marginTop: 6, fontSize: 10, color: "rgba(255,255,255,0.5)", lineHeight: 14 },
  oddsRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5, gap: 8 },
  oddsCol: { flexShrink: 1, minWidth: 0 },
  oddsSide: { fontFamily: "monospace", fontWeight: "700", fontSize: 12, flexShrink: 1 },
  oddsBar: { flexDirection: "row", height: 10, borderRadius: 6, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.4)" },
  footerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  chip: { backgroundColor: "rgba(0,0,0,0.4)", borderWidth: 1, borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12 },
  chipLabel: { fontSize: 8, letterSpacing: 1.2, color: colors.muted, textTransform: "uppercase" },
  chipValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 15, color: "#fff" },
  payRow: { flex: 1, minWidth: 0, flexDirection: "row", gap: 6 },
  payBox: { flex: 1, minWidth: 0, alignItems: "center", borderWidth: 1, borderRadius: 14, paddingVertical: 8, paddingHorizontal: 6 },
  payLabel: { fontSize: 8, letterSpacing: 1, textTransform: "uppercase" },
  payValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 14 },
  stamp: {
    position: "absolute", paddingVertical: 6, paddingHorizontal: 14, borderRadius: 12,
    borderWidth: 3, backgroundColor: "rgba(10,10,15,0.75)", maxWidth: "80%",
  },
  stampLeft: { top: 42, left: 18, transform: [{ rotate: "-14deg" }] },
  stampRight: { top: 42, right: 18, transform: [{ rotate: "14deg" }] },
  stampTop: { top: 20, alignSelf: "center" },
  stampText: { fontSize: 22, fontWeight: "900", letterSpacing: 1 },
});
