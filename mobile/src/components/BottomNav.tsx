// Bottom tab bar — FOUR tabs, the owner's rule (web BottomNav.tsx): Deck · Hedge · Stocks · You.
// GM and the results inbox are screens, not tabs: the HUD's streak chip and bell open them.
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

export type Screen = "deck" | "feed" | "hedge" | "stocks" | "home" | "results" | "profile" | "vault" | "invite";

// Time until the next 00:00 UTC — when the daily swipe cap rolls over and the deck reopens. Ticks
// every 30 s (the label is minute-grained). Port of the web BottomNav's useDeckResetCountdown.
function useDeckResetCountdown(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  const min = Math.max(0, Math.floor((next - now) / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : "<1m";
}

const TABS: { key: Screen; glyph: string; label: string }[] = [
  { key: "deck", glyph: "⚡", label: "Deck" },
  { key: "hedge", glyph: "🛡", label: "Hedge" },
  { key: "stocks", glyph: "▲", label: "Stocks" },
  { key: "profile", glyph: "◉", label: "You" },
];

// The Deck tab is the single entry to both the deck and the post-cap feed: once the cap is spent
// (deckLocked) it still opens (into the feed) and its label becomes the countdown to the next deck.
export function BottomNav({ screen, onNav, deckLocked }: { screen: Screen; onNav: (s: Screen) => void; deckLocked: boolean }) {
  const resetIn = useDeckResetCountdown();
  return (
    <View style={styles.bar}>
      {TABS.map((t) => {
        const deckTimer = t.key === "deck" && deckLocked;
        // Deck stays lit on the feed it routes into; You stays lit on Vault and Invite (not tabs).
        const active =
          t.key === "deck" ? screen === "deck" || screen === "feed"
          : t.key === "profile" ? screen === "profile" || screen === "vault" || screen === "invite"
          : screen === t.key;
        return (
          <TouchableOpacity
            key={t.key}
            style={styles.tab}
            onPress={() => onNav(t.key)}
            accessibilityRole="button"
            accessibilityLabel={deckTimer ? `Feed — fresh deck in ${resetIn}` : t.label}
          >
            <Text style={[styles.glyph, !active && styles.glyphOff]}>{t.glyph}</Text>
            <Text style={[styles.label, active && styles.labelOn, deckTimer && styles.labelTimer]}>{deckTimer ? resetIn : t.label}</Text>
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
  labelTimer: { textTransform: "none", fontVariant: ["tabular-nums"] },
});
