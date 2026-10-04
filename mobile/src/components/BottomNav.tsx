// Bottom tab bar — FOUR tabs, the owner's rule (web BottomNav.tsx): Deck · Hedge · Stocks · You.
// GM and the results inbox are screens, not tabs: the HUD's streak chip and bell open them.
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
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

// One drawn icon set, tinted like the web's glyphs (muted when idle, energy when lit). Text glyphs
// could not be: ⚡ and 🛡 are colour emoji that ignore the tint, and ▲ / ◉ fell back to near-black
// on the dark bar. A lit icon also gets a soft fill of its own colour.
type IconKey = "deck" | "hedge" | "stocks" | "profile";
function TabIcon({ icon, color, lit }: { icon: IconKey; color: string; lit: boolean }) {
  const fill = lit ? `${color}33` : "none";
  const p = { stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      {icon === "deck" ? <Path d="M13 2 L4 14 H11 L10 22 L20 9 H13 Z" fill={fill} {...p} />
        : icon === "hedge" ? <Path d="M12 2.5 L20 5.5 V11 C20 16 16.5 19.8 12 21.5 C7.5 19.8 4 16 4 11 V5.5 Z" fill={fill} {...p} />
        : icon === "stocks" ? <><Path d="M3 17 L9 11 L13 15 L21 7" fill="none" {...p} /><Path d="M15 7 H21 V13" fill="none" {...p} /></>
        : <><Circle cx={12} cy={8} r={4} fill={fill} {...p} /><Path d="M4 21 C4 16.6 7.6 14 12 14 C16.4 14 20 16.6 20 21" fill="none" {...p} /></>}
    </Svg>
  );
}

const TABS: { key: Screen; icon: IconKey; label: string }[] = [
  { key: "deck", icon: "deck", label: "Deck" },
  { key: "hedge", icon: "hedge", label: "Hedge" },
  { key: "stocks", icon: "stocks", label: "Stocks" },
  { key: "profile", icon: "profile", label: "Profile" }, // web: "Profile"
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
            <TabIcon icon={t.icon} color={active ? colors.energy : colors.muted} lit={active} />
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
    // 26 (was 14): the Seeker's gesture bar sat on the labels; this lifts the row clear of it.
    backgroundColor: colors.bg2, paddingBottom: 26, paddingTop: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 3 },
  label: { fontSize: 10, color: colors.muted, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: "700" },
  labelOn: { color: colors.energy, fontWeight: "700" },
  labelTimer: { textTransform: "none", fontVariant: ["tabular-nums"] },
});
