// Bottom tab bar for the vertical slice: Deck / GM / Results / You.
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export type Screen = "deck" | "home" | "results" | "profile";

const TABS: { key: Screen; glyph: string; label: string }[] = [
  { key: "deck", glyph: "🃏", label: "Deck" },
  { key: "home", glyph: "🔥", label: "GM" },
  { key: "results", glyph: "🔔", label: "Results" },
  { key: "profile", glyph: "👤", label: "You" },
];

export function BottomNav({ screen, onNav }: { screen: Screen; onNav: (s: Screen) => void }) {
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const active = screen === t.key;
        return (
          <TouchableOpacity key={t.key} style={styles.tab} onPress={() => onNav(t.key)} accessibilityRole="button" accessibilityLabel={t.label}>
            <Text style={[styles.glyph, !active && styles.glyphOff]}>{t.glyph}</Text>
            <Text style={[styles.label, active && styles.labelOn]}>{t.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.line,
    backgroundColor: colors.bg2, paddingBottom: 14, paddingTop: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 2 },
  glyph: { fontSize: 18 },
  glyphOff: { opacity: 0.45 },
  label: { fontSize: 10, color: colors.muted, letterSpacing: 0.6, textTransform: "uppercase" },
  labelOn: { color: colors.energy, fontWeight: "700" },
});
