// RevealOverlay (native) — port of src/app/screens/RevealOverlay.tsx. The dopamine peak: plays on app
// open, before the deck, replaying what resolved while the user was away. Three phases:
//   aggregate → featured cards (≤5, peak-end ordered) → summary.
// USER-PACED: no auto-advance, no timer. A tap anywhere on the card advances (the web's swipe-or-tap);
// the ✕ exits at any point. Finishing vs skipping is the parent's job (onDone/onSkip) — only finishing
// clears the unread badge. The web's CSS keyframes become small Animated fades/scales.
import { memo, type ReactNode, useEffect, useMemo, useReducer, useRef } from "react";
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ResultRow } from "@contract/api-types";
import { catOf, resultMeta, usd } from "../format";
import { colors, withAlpha } from "../theme";

const MAX_FEATURED = 5;
// The deck's stack pose for the card waiting behind the top one.
const PREVIEW_SCALE = 0.94;
const PREVIEW_Y = 14;
const RISE_MS = 420;

type Phase = "aggregate" | "cards" | "summary";
type State = { phase: Phase; i: number };
type Action = { t: "toCards" } | { t: "next"; last: number };

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "toCards": return { phase: "cards", i: 0 };
    case "next": return s.i >= a.last ? { phase: "summary", i: s.i } : { phase: "cards", i: s.i + 1 };
  }
}

export function RevealOverlay({ rows, shards, shardsPerArtifact, onDone, onSkip }: {
  rows: ResultRow[];
  shards: number;
  shardsPerArtifact: number;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, { phase: "aggregate", i: 0 });

  // Aggregate totals over ALL rows (the reveal shows the full net, even though only ≤5 cards play).
  const agg = useMemo(() => rows.reduce(
    (a, r) => ({
      net: a.net + r.deltaCents,
      won: a.won + (r.status === "WIN" ? 1 : 0),
      lost: a.lost + (r.status === "LOSS" ? 1 : 0),
      shards: a.shards + r.shards,
    }),
    { net: 0, won: 0, lost: 0, shards: 0 },
  ), [rows]);

  // Peak-end order: at most MAX_FEATURED cards, ending on the biggest win so the sequence climaxes.
  const featured = useMemo(() => peakEndOrder(rows, MAX_FEATURED), [rows]);
  const last = featured.length - 1;
  const next = () => dispatch({ t: "next", last });

  const netPositive = agg.net >= 0;
  // Exact, like every other money figure: rounding each row first is how a summary stops matching.
  const netStr = (netPositive ? "+" : "") + usd(agg.net);
  const netColor = netPositive ? colors.yes : colors.no;
  const shardPct = Math.min(100, Math.round((shards / shardsPerArtifact) * 100));
  const shardsLeft = Math.max(0, shardsPerArtifact - shards);

  return (
    <View style={styles.overlay}>
      {/* Persistent close — exits to the deck, badge preserved. */}
      <Pressable style={styles.close} onPress={onSkip} accessibilityRole="button" accessibilityLabel="Close">
        <Text style={styles.closeGlyph}>✕</Text>
      </Pressable>

      {state.phase === "aggregate" && (
        <Pressable style={styles.aggregate} onPress={() => dispatch({ t: "toCards" })} accessibilityRole="button" accessibilityLabel="Relive your calls">
          <FadeIn delay={0}><Text style={styles.aggKicker}>While you were away</Text></FadeIn>
          <FadeIn delay={50}>
            <Text style={[styles.aggNet, { color: netColor, textShadowColor: withAlpha(netColor, "73"), textShadowRadius: 30 }]}>{netStr}</Text>
          </FadeIn>
          <FadeIn delay={100}>
            <Text style={styles.aggSub}>net virtual P&amp;L · {rows.length} call{rows.length === 1 ? "" : "s"} settled</Text>
          </FadeIn>
          <FadeIn delay={180}>
            <View style={styles.aggTiles}>
              <AggTile value={String(agg.won)} label="Won" color={colors.yes} />
              <AggTile value={String(agg.lost)} label="Lost" color={colors.no} />
              <AggTile value={`+${agg.shards} ◆`} label="Shards" color={colors.gold} />
            </View>
          </FadeIn>
          <FadeIn delay={260}>
            <Pulse>
              <View style={styles.aggCta}><Text style={styles.aggCtaText}>Tap to relive your calls →</Text></View>
            </Pulse>
          </FadeIn>
        </Pressable>
      )}

      {state.phase === "cards" && featured[state.i] && (
        <View style={styles.cardsWrap}>
          <View style={styles.progressRow}>
            {featured.map((_, k) => (
              <View key={k} style={[styles.progressBar, { backgroundColor: k <= state.i ? colors.text : colors.line }]} />
            ))}
          </View>
          <View style={styles.stackArea}>
            <View style={styles.stack}>
              {featured[state.i + 1] ? <RevealCardPreview key={`p${state.i}`} row={featured[state.i + 1]!} /> : null}
              {/* keyed by index so each card remounts (fresh rise) */}
              <RevealCard key={state.i} row={featured[state.i]!} onAdvance={next} />
            </View>
          </View>
          <Text style={styles.cardsHint}>Swipe or tap to continue · {state.i + 1} / {featured.length}</Text>
        </View>
      )}

      {state.phase === "summary" && (
        <ScrollView style={styles.summaryScroll} contentContainerStyle={styles.summaryContent}>
          <FadeIn delay={0}>
            <View style={styles.summaryHead}>
              <Text style={styles.summaryEmoji}>🎉</Text>
              <Text style={styles.summaryTitle}>That&apos;s a wrap</Text>
              <Text style={styles.summarySub}>Everything&apos;s already credited to your balance.</Text>
            </View>
          </FadeIn>

          {/* Shard-chain card only when shards were actually collected this batch — no "+0" panel. */}
          {agg.shards > 0 ? (
            <View style={styles.shardCard}>
              <View style={styles.shardRow}>
                <Text style={styles.shardGlyph}>◆</Text>
                <Text style={styles.shardLabel}>+{agg.shards} shard{agg.shards === 1 ? "" : "s"} collected</Text>
                <Text style={styles.shardCount}>{shards}/{shardsPerArtifact}</Text>
              </View>
              <View style={styles.shardTrack}><View style={[styles.shardFill, { width: `${shardPct}%` }]} /></View>
              <Text style={styles.shardLeft}>{shardsLeft} more to forge your next artifact</Text>
            </View>
          ) : null}

          <View style={styles.summarySpacer} />
          <Pressable style={styles.continueBtn} onPress={onDone} accessibilityRole="button">
            <Text style={styles.continueText}>Continue →</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

// One-shot fade + rise (the web's hfBigIn); `delay` staggers the aggregate's lines.
function FadeIn({ delay, children }: { delay: number; children: ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: 400, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [v, delay]);
  return (
    <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
      {children}
    </Animated.View>
  );
}

// The web's hfPulse — a slow breathing scale on the "Tap to relive" pill.
function Pulse({ children }: { children: ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 1000, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View style={{ transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) }] }}>
      {children}
    </Animated.View>
  );
}

function AggTile({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={[styles.aggTile, { backgroundColor: withAlpha(color, "24"), borderColor: withAlpha(color, "5c") }]}>
      <Text style={[styles.aggTileValue, { color }]}>{value}</Text>
      <Text style={styles.aggTileLabel}>{label}</Text>
    </View>
  );
}

// The card visuals, pure + memoized — used by the top card and the preview behind it.
const RevealCardFace = memo(function RevealCardFace({ row }: { row: ResultRow }) {
  const cat = catOf(row);
  const m = resultMeta(row.status);
  const isWin = row.status === "WIN";
  const isVoid = row.status === "PUSH";
  const badge = isWin ? "WON" : isVoid ? "REFUNDED" : "MISSED";
  // Exact to the cent, and the sign is explicit: a win of 89 cents is "+$0.89", not "+$1".
  const deltaStr = isVoid ? usd(row.stakeCents) : `${row.deltaCents >= 0 ? "+" : ""}${usd(row.deltaCents)}`;
  const sideColor = row.side === "YES" ? colors.yes : colors.no;
  // Gold shard line only when shards were actually collected; an over-cap win still banked a payout.
  const gotShards = isWin && row.shards > 0;
  const foot = gotShards
    ? `+${row.shards} ◆ shard${row.shards === 1 ? "" : "s"} collected`
    : isWin ? "Nice call — virtual payout banked"
    : isVoid ? `Market voided · your ${usd(row.stakeCents)} stake was returned`
    : "So close — no payout this time";

  return (
    <View style={styles.face}>
      <View style={styles.faceTop}>
        <View style={styles.catChip}>
          <View style={[styles.catDot, { backgroundColor: cat.color }]} />
          <Text style={styles.catLabel}>{cat.label}</Text>
        </View>
        <Text style={[styles.badge, { color: m.accent }]}>{badge}</Text>
      </View>
      <View style={styles.faceMid}>
        <Text style={styles.question}>{row.question}</Text>
        <Text style={styles.outcome}>{row.outcome}</Text>
        <View style={styles.callRow}>
          <Text style={styles.callLabel}>Your call</Text>
          <Text style={[styles.callSide, { color: sideColor, borderColor: sideColor }]}>{row.side}</Text>
        </View>
        <View style={styles.deltaRow}>
          <Text style={[styles.delta, { color: m.accent }]}>{deltaStr}</Text>
          <Text style={styles.deltaKind}>{isVoid ? "returned" : isWin ? "virtual payout" : "virtual loss"}</Text>
        </View>
      </View>
      <Text style={[styles.foot, { color: gotShards ? colors.gold : colors.muted, fontWeight: gotShards ? "700" : "500" }]}>{foot}</Text>
    </View>
  );
});

// Shared card-shell styling so the top card and the preview match (only the accent glow differs).
function cardShell(row: ResultRow) {
  const m = resultMeta(row.status);
  const isWin = row.status === "WIN";
  return {
    backgroundColor: colors.panel,
    borderColor: withAlpha(m.accent, "73"),
    shadowColor: isWin ? colors.yes : "#000",
    shadowOpacity: 0.6,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  } as const;
}

// The next card behind the top one: fully rendered, scaled back, dimmed, not interactive.
function RevealCardPreview({ row }: { row: ResultRow }) {
  return (
    <View style={[styles.cardShell, cardShell(row), styles.preview, { transform: [{ scale: PREVIEW_SCALE }, { translateY: PREVIEW_Y }] }]}>
      <RevealCardFace row={row} />
    </View>
  );
}

// Deterministic PRNG so per-card coin positions are stable and the memo stays pure.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Coin fountain for a win, bursting up from the card's top edge (a sibling of the card so it is not
// clipped by the card's rounded corners).
function CoinBurst({ row }: { row: ResultRow }) {
  const coins = useMemo(() => {
    const rand = mulberry32(hashStr(row.id));
    return Array.from({ length: 14 }, (_, k) => ({
      key: k,
      left: 8 + rand() * 84,
      size: 15 + rand() * 13,
      cx: rand() * 120 - 60,
      dur: 1000 + rand() * 700,
      delay: rand() * 350,
    }));
  }, [row.id]);
  return (
    <View style={styles.coinLayer} pointerEvents="none">
      {coins.map(({ key, ...c }) => <Coin key={key} {...c} />)}
    </View>
  );
}

function Coin({ left, size, cx, dur, delay }: { left: number; size: number; cx: number; dur: number; delay: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: 1, duration: dur, delay, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [v, dur, delay]);
  return (
    <Animated.Text
      style={[
        styles.coin,
        {
          left: `${left}%`,
          fontSize: size,
          opacity: v.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
          transform: [
            { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -180] }) },
            { translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, cx] }) },
          ],
        },
      ]}
    >
      🪙
    </Animated.Text>
  );
}

// The interactive top card: rises out of the stack on mount, then a tap advances.
function RevealCard({ row, onAdvance }: { row: ResultRow; onAdvance: () => void }) {
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(rise, { toValue: 1, duration: RISE_MS, easing: Easing.bezier(0.34, 1.2, 0.5, 1), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [rise]);
  const isWin = row.status === "WIN";

  return (
    <View style={styles.cardWrap}>
      {isWin ? <CoinBurst row={row} /> : null}
      <Animated.View
        style={[
          styles.cardShell,
          cardShell(row),
          styles.cardTop,
          {
            opacity: rise,
            transform: [
              { scale: rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_SCALE, 1] }) },
              { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [PREVIEW_Y, 0] }) },
            ],
          },
        ]}
      >
        <Pressable style={{ flex: 1 }} onPress={onAdvance} accessibilityRole="button" accessibilityLabel="Next result">
          <RevealCardFace row={row} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

// Peak-end ordering: ≤max cards ending on the biggest win. If there is a win, it goes last; the rest
// fill from the front by recency (rows arrive newest-first). Same as the web (test-reveal-order.ts).
export function peakEndOrder(rows: ResultRow[], max: number): ResultRow[] {
  if (rows.length <= 1) return rows.slice();
  const wins = rows.filter((r) => r.status === "WIN");
  const finale = wins.length ? wins.reduce((b, r) => (r.deltaCents > b.deltaCents ? r : b), wins[0]!) : null;
  const rest = rows.filter((r) => r !== finale).slice(0, max - (finale ? 1 : 0));
  return finale ? [...rest, finale] : rest;
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 88, backgroundColor: colors.bg },
  close: {
    position: "absolute", top: 14, right: 16, zIndex: 8, width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)", borderWidth: 1, borderColor: colors.line,
  },
  closeGlyph: { color: colors.text, fontSize: 18, fontWeight: "800" },

  aggregate: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 30 },
  aggKicker: { fontSize: 11, letterSpacing: 2.6, textTransform: "uppercase", color: colors.muted, fontWeight: "700", textAlign: "center" },
  aggNet: { fontSize: 72, marginTop: 16, fontWeight: "900", textAlign: "center" },
  aggSub: { fontSize: 12, letterSpacing: 0.5, color: colors.muted, marginTop: 6, textAlign: "center" },
  aggTiles: { flexDirection: "row", gap: 9, marginTop: 28 },
  aggTile: { borderRadius: 16, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 18, alignItems: "center" },
  aggTileValue: { fontSize: 24, fontWeight: "700", fontFamily: "monospace" },
  aggTileLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: colors.muted, marginTop: 2 },
  aggCta: { marginTop: 36, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 24 },
  aggCtaText: { fontSize: 13, color: colors.text, fontWeight: "700" },

  cardsWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  progressRow: { flexDirection: "row", gap: 5, justifyContent: "center", paddingTop: 52, paddingHorizontal: 46 },
  progressBar: { flex: 1, height: 3, borderRadius: 3 },
  stackArea: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 10 },
  stack: { width: 300, maxWidth: "100%", height: 420 },
  cardsHint: { textAlign: "center", paddingTop: 14, paddingBottom: 30, color: colors.muted, fontSize: 12 },

  summaryScroll: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  summaryContent: { paddingTop: 64, paddingHorizontal: 22, paddingBottom: 26, flexGrow: 1 },
  summaryHead: { alignItems: "center" },
  summaryEmoji: { fontSize: 44 },
  summaryTitle: { fontSize: 40, lineHeight: 44, marginTop: 6, color: colors.text, fontWeight: "900" },
  summarySub: { fontSize: 13, color: colors.muted, marginTop: 6 },
  shardCard: { marginTop: 22, backgroundColor: colors.panel, borderWidth: 1, borderColor: withAlpha(colors.gold, "5c"), borderRadius: 18, padding: 16 },
  shardRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  shardGlyph: { fontSize: 20, color: colors.gold },
  shardLabel: { fontSize: 13, fontWeight: "700", color: colors.gold },
  shardCount: { marginLeft: "auto", fontWeight: "700", fontSize: 13, color: colors.gold, fontFamily: "monospace" },
  shardTrack: { marginTop: 10, height: 9, borderRadius: 6, backgroundColor: colors.panel2, overflow: "hidden", borderWidth: 1, borderColor: colors.line },
  shardFill: { height: "100%", backgroundColor: colors.gold },
  shardLeft: { fontSize: 11, color: colors.muted, marginTop: 8 },
  summarySpacer: { flex: 1, minHeight: 18 },
  continueBtn: { width: "100%", marginTop: 18, backgroundColor: colors.energy, padding: 16, borderRadius: 18, alignItems: "center", elevation: 10 },
  continueText: { color: "#fff", fontSize: 24, fontWeight: "900" },

  cardWrap: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  cardShell: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 26, overflow: "hidden", borderWidth: 1 },
  cardTop: { zIndex: 1 },
  preview: { opacity: 0.82 },

  face: { flex: 1, padding: 20 },
  faceTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  catChip: { flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: "rgba(0,0,0,0.35)", paddingVertical: 5, paddingHorizontal: 10, borderRadius: 18 },
  catDot: { width: 7, height: 7, borderRadius: 4 },
  catLabel: { fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: "700", color: "#fff" },
  badge: { marginLeft: "auto", fontSize: 18, letterSpacing: 0.5, fontWeight: "900" },
  faceMid: { flex: 1, justifyContent: "center" },
  question: { fontSize: 13, color: colors.muted, marginTop: 16, lineHeight: 17 },
  outcome: { fontSize: 28, lineHeight: 32, color: "#fff", marginTop: 6, fontWeight: "900" },
  callRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16 },
  callLabel: { fontSize: 11, color: colors.muted },
  callSide: { fontSize: 15, borderWidth: 2, borderRadius: 8, paddingVertical: 1, paddingHorizontal: 9, fontWeight: "900" },
  deltaRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 12 },
  delta: { fontSize: 34, lineHeight: 38, fontWeight: "700", fontFamily: "monospace" },
  deltaKind: { fontSize: 11, color: colors.muted, marginBottom: 4 },
  foot: { paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line, fontSize: 12 },

  coinLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 },
  coin: { position: "absolute", top: 0 },
});
