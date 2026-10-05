// The indicators for orders in flight (see orderStatus.ts). Two shapes:
//   OrderChips   — a one-line strip of chips (style A: above the action buttons, B: under the deck
//                  pill). Fixed height whether empty or not, so a chip appearing never moves the card.
//   OrderBadge   — style C: a small ring next to the HUD balance with the count still in flight,
//                  flashing green when one fills.
// Everything that moves is native-driver Animated (opacity / translate / scale); a status change
// re-renders one chip, never the deck.
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, StyleSheet, Text, Vibration, View } from "react-native";
import { colors } from "../theme";
import { type OrderStatusItem, useOrderStatus } from "../orderStatus";

const MAX_CHIPS = 3;
export const ORDER_TRAY_HEIGHT = 26;

// offsetY nudges the chips without changing the strip's height (the deck above never moves).
export function OrderChips({ offsetY = 0 }: { offsetY?: number }) {
  const items = useOrderStatus();
  const shown = items.slice(-MAX_CHIPS);
  const hidden = items.length - shown.length;
  return (
    <View style={[styles.tray, offsetY ? { transform: [{ translateY: offsetY }] } : null]} pointerEvents="none" accessibilityLiveRegion="polite">
      {hidden > 0 ? <Text style={styles.more}>+{hidden}</Text> : null}
      {shown.map((it) => <Chip key={it.id} item={it} />)}
    </View>
  );
}

const Chip = memo(function Chip({ item }: { item: OrderStatusItem }) {
  // Created once per chip (lazy state, not a ref read during render) — the useSwipeCard pattern.
  const [enter] = useState(() => new Animated.Value(0));
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    Animated.timing(enter, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [enter]);
  // A settled chip pops once (and a fill ticks the phone) — the "it went through" moment without a
  // word to read.
  useEffect(() => {
    if (item.state === "pending") return;
    if (item.state === "filled") Vibration.vibrate(12);
    pulse.setValue(1.12);
    Animated.spring(pulse, { toValue: 1, friction: 4, useNativeDriver: true }).start();
  }, [item.state, pulse]);

  const tone = TONE[item.state];
  return (
    <Animated.View
      style={[
        styles.chip,
        { borderColor: tone.border, backgroundColor: tone.bg },
        { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }, { scale: pulse }] },
      ]}
      accessibilityLabel={`${item.side} ${item.label}: ${item.state}${item.detail ? `, ${item.detail}` : ""}`}
    >
      {item.state === "pending" ? (
        <ActivityIndicator size="small" color={colors.muted} style={styles.spin} />
      ) : (
        <Text style={[styles.glyph, { color: tone.fg }]}>{tone.glyph}</Text>
      )}
      {/* The outcome as the card named it, in the side's colour — "YES Up" said the same thing twice. */}
      <Text style={[styles.label, { color: item.side === "YES" ? colors.yes : colors.no }]} numberOfLines={1}>{item.label}</Text>
      {item.detail ? <Text style={[styles.detail, { color: tone.fg }]} numberOfLines={1}>{item.detail}</Text> : null}
    </Animated.View>
  );
});

const TONE = {
  pending: { glyph: "", fg: colors.muted, border: colors.line, bg: "rgba(21,21,31,0.92)" },
  filled: { glyph: "✓", fg: colors.yes, border: "rgba(182,255,46,0.45)", bg: "rgba(182,255,46,0.10)" },
  posted: { glyph: "•", fg: colors.gold, border: "rgba(255,194,75,0.45)", bg: "rgba(255,194,75,0.10)" },
  failed: { glyph: "✕", fg: colors.no, border: "rgba(255,59,78,0.45)", bg: "rgba(255,59,78,0.10)" },
} as const;

// Style D: the bell IS the indicator. While orders are in flight it becomes a spinning ring with the
// count (1, 2, 3…); when they settle it resolves to ✓ or ✕ for a moment, then the bell is back.
// With nothing to say it renders `fallback` (the ordinary bell).
export function BellOrderStatus({ fallback }: { fallback: ReactNode }) {
  const items = useOrderStatus();
  const pending = items.filter((i) => i.state === "pending").length;
  const settled = items.filter((i) => i.state !== "pending");
  const last = settled.length ? settled.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  const [pop] = useState(() => new Animated.Value(1));
  const lastId = useRef(0);
  useEffect(() => {
    if (!last || last.id <= lastId.current || pending > 0) return;
    lastId.current = last.id;
    if (last.state === "filled") Vibration.vibrate(12);
    pop.setValue(1.3);
    Animated.spring(pop, { toValue: 1, friction: 4, useNativeDriver: true }).start();
  }, [last, pending, pop]);
  if (pending > 0) {
    return (
      <View style={styles.bellBox} accessibilityLabel={`${pending} order${pending > 1 ? "s" : ""} in flight`}>
        <ActivityIndicator size="small" color={colors.gold} style={styles.bellSpin} />
        <Text style={styles.bellCount}>{pending}</Text>
      </View>
    );
  }
  if (!last) return <>{fallback}</>;
  const ok = last.state === "filled" || last.state === "posted";
  return (
    <Animated.View style={[styles.bellBox, { transform: [{ scale: pop }] }]} accessibilityLabel={ok ? "Order placed" : "Order not placed"}>
      <Text style={[styles.bellMark, { color: last.state === "failed" ? colors.no : last.state === "posted" ? colors.gold : colors.yes }]}>
        {last.state === "failed" ? "✕" : "✓"}
      </Text>
    </Animated.View>
  );
}

// Style C: the count of orders still in flight, beside the balance. Renders nothing while idle.
export function OrderBadge() {
  const items = useOrderStatus();
  const pending = items.filter((i) => i.state === "pending").length;
  const [flash] = useState(() => new Animated.Value(0));
  const lastFilled = useRef(0);
  const filledIds = items.filter((i) => i.state === "filled").map((i) => i.id);
  const newest = filledIds.length ? Math.max(...filledIds) : 0;
  useEffect(() => {
    if (newest <= lastFilled.current) return;
    lastFilled.current = newest;
    Vibration.vibrate(12);
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 900, useNativeDriver: true }).start();
  }, [newest, flash]);
  if (pending === 0 && newest === 0) return null;
  return (
    <View style={styles.badgeWrap} pointerEvents="none">
      <Animated.View style={[styles.badgeFlash, { opacity: flash }]} />
      {pending > 0 ? (
        <>
          <ActivityIndicator size="small" color={colors.gold} style={styles.badgeSpin} />
          <Text style={styles.badgeCount}>{pending}</Text>
        </>
      ) : (
        <Text style={[styles.badgeCount, { color: colors.yes }]}>✓</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tray: {
    height: ORDER_TRAY_HEIGHT, flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, paddingHorizontal: 12, overflow: "hidden",
  },
  more: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 170, height: 24,
    paddingHorizontal: 8, borderRadius: 12, borderWidth: 1,
  },
  spin: { transform: [{ scale: 0.6 }], width: 14, height: 14 },
  glyph: { fontSize: 12, fontWeight: "900", width: 14, textAlign: "center" },
  label: { color: colors.text, fontSize: 11, fontWeight: "600", flexShrink: 1 },
  detail: { fontSize: 10, fontWeight: "700" },
  badgeWrap: { width: 26, height: 26, alignItems: "center", justifyContent: "center", marginLeft: -4 },
  badgeFlash: { position: "absolute", width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(182,255,46,0.35)" },
  badgeSpin: { position: "absolute", transform: [{ scale: 0.9 }] },
  badgeCount: { color: colors.gold, fontSize: 10, fontWeight: "900" },
  bellBox: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  bellSpin: { position: "absolute", transform: [{ scale: 1.05 }] },
  bellCount: { color: colors.gold, fontSize: 11, fontWeight: "900" },
  bellMark: { fontSize: 18, fontWeight: "900" },
});
