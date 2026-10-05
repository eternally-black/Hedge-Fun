// The HUD bell doubles as the real-order indicator (chosen over chips by the deck and a balance badge
// in an on-device A/B/C/D test, 2026-10-05). While orders are in flight it is a spinning ring with the
// count (1, 2, 3…); when they settle it resolves to ✓ (green = filled, gold = awaiting the exchange)
// or ✕ for a moment, then it is the plain bell again. Native-driver animation only.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, StyleSheet, Text, Vibration, View } from "react-native";
import { colors } from "../theme";
import { useOrderStatus } from "../orderStatus";

export function OrderStatusBell({ bell }: { bell: ReactNode }) {
  const items = useOrderStatus();
  const pending = items.filter((i) => i.state === "pending").length;
  const settled = items.filter((i) => i.state !== "pending");
  const last = settled.length ? settled.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  // Created once (lazy state, not a ref read during render) — the useSwipeCard pattern.
  const [pop] = useState(() => new Animated.Value(1));
  const shownId = useRef(0);
  useEffect(() => {
    if (!last || last.id <= shownId.current || pending > 0) return;
    shownId.current = last.id;
    if (last.state === "filled") Vibration.vibrate(12);
    pop.setValue(1.3);
    Animated.spring(pop, { toValue: 1, friction: 4, useNativeDriver: true }).start();
  }, [last, pending, pop]);

  if (pending > 0) {
    return (
      <View style={styles.box} accessibilityLabel={`${pending} order${pending > 1 ? "s" : ""} in flight`}>
        <ActivityIndicator size="small" color={colors.gold} style={styles.spin} />
        <Text style={styles.count}>{pending}</Text>
      </View>
    );
  }
  if (!last) return <>{bell}</>;
  const color = last.state === "failed" ? colors.no : last.state === "posted" ? colors.gold : colors.yes;
  return (
    <Animated.View
      style={[styles.box, { transform: [{ scale: pop }] }]}
      accessibilityLabel={last.state === "failed" ? "Order not placed" : "Order placed"}
    >
      <Text style={[styles.mark, { color }]}>{last.state === "failed" ? "✕" : "✓"}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  spin: { position: "absolute", transform: [{ scale: 1.05 }] },
  count: { color: colors.gold, fontSize: 11, fontWeight: "900" },
  mark: { fontSize: 18, fontWeight: "900" },
});
