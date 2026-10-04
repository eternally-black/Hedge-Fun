// Placeholders for a tab's first load. A skeleton takes the exact box of the content it stands in for
// (the caller passes the real height/width), so the data landing swaps grey for text without moving
// anything. Static on purpose: a pulse animation would be a JS-driven loop on screens that are kept
// mounted in the background (Root keeps Hedge and Stocks alive between tab switches).
import { ActivityIndicator, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";

export function SkeletonBar({ width = "100%", height = 12, style }: {
  width?: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.bar, { width, height }, style]} />;
}

// The "updating" tick a tab shows while it revalidates data it is already showing. Always takes its
// 16×16 box, so it appearing and disappearing never nudges the header it sits in.
export function UpdatingTick({ visible }: { visible: boolean }) {
  return (
    <View style={styles.tick} accessibilityElementsHidden={!visible} importantForAccessibility={visible ? "auto" : "no-hide-descendants"}>
      <ActivityIndicator size="small" color={colors.muted} animating={visible} style={styles.tickSpinner} accessibilityLabel="Updating" />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: colors.panel2, borderRadius: 6 },
  tick: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  tickSpinner: { transform: [{ scale: 0.7 }] },
});
