// Bottom tab bar — FOUR tabs, the owner's rule (web BottomNav.tsx): Deck · Hedge · Stocks · You.
// GM and the results inbox are screens, not tabs: the HUD's streak chip and bell open them.
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export type Screen = "deck" | "hedge" | "stocks" | "home" | "results" | "profile";

const TABS: { key: Screen; glyph: string; label: string }[] = [
  { key: "deck", glyph: "⚡", label: "Deck" },
  { key: "hedge", glyph: "🛡", label: "Hedge" },
  { key: "stocks", glyph: "▲", label: "Stocks" },
  { key: "profile", glyph: "◉", label: "You" },
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
