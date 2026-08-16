// Top HUD: points / streak / cash chips + bell with unread badge + the shard→artifact strip.
// Native port of src/app/screens/Hud.tsx. All numbers come from /api/me — rendered, never derived.
import { memo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse } from "../../lib/api-types";
import { colors } from "../theme";
import { num, usd } from "../format";

export const Hud = memo(function Hud({ me, onGM, onBalance, onBell }: {
  me: MeResponse | null;
  onGM: () => void;
  onBalance: () => void;
  onBell: () => void;
}) {
  const shards = me?.shards ?? 0;
  const per = me?.shardsPerArtifact ?? 20; // fallback only before the first /api/me lands
  const shardPct = Math.min(100, Math.round((shards / per) * 100));
  const unread = me?.unreadResults ?? 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        {/* Points */}
        <View style={styles.chip}>
          <View style={styles.dotOuter}>
            <View style={styles.dotInner} />
          </View>
          <View>
            <Text style={styles.chipValue}>{me ? num(me.points.total) : "—"}</Text>
            <Text style={styles.chipLabel}>Points</Text>
          </View>
        </View>

        {/* Streak → GM screen */}
        <TouchableOpacity style={styles.chip} onPress={onGM} accessibilityLabel="Streak — open GM check-in">
          <Text style={styles.flame}>🔥</Text>
          <View>
            <Text style={styles.chipValue}>{me ? String(me.streak.level) : "—"}</Text>
            <Text style={styles.chipLabel}>Streak</Text>
          </View>
        </TouchableOpacity>

        <View style={styles.spacer} />

        {/* Cash → top-up sheet */}
        <TouchableOpacity style={styles.chip} onPress={onBalance} accessibilityLabel="Cash balance — open wallet">
          <View style={styles.cashCol}>
            <Text style={styles.cashValue}>{me ? usd(me.cashCents) : "—"}</Text>
            <Text style={styles.chipLabel}>{me && me.lockedCents > 0 ? `+ ${usd(me.lockedCents)} locked ›` : "Cash ›"}</Text>
          </View>
        </TouchableOpacity>

        {/* Bell → results inbox */}
        <TouchableOpacity style={styles.bell} onPress={onBell} accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}>
          <Text style={styles.bellGlyph}>🔔</Text>
          {unread > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unread}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* Shards → artifact progress. Display-only in the slice (the Vault is a web screen). */}
      <View style={styles.shardRow}>
        <Text style={styles.shardText}>◆ {shards}/{per}</Text>
        <View style={styles.shardTrack}>
          <View style={[styles.shardFill, { width: `${shardPct}%` }]} />
        </View>
        <Text style={styles.shardHint}>→ artifact ({me?.artifacts ?? 0})</Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  spacer: { flex: 1 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 7, backgroundColor: colors.panel,
    borderWidth: 1, borderColor: colors.line, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 30,
  },
  dotOuter: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(255,61,205,0.22)",
    borderWidth: 1, borderColor: "rgba(255,61,205,0.5)", alignItems: "center", justifyContent: "center",
  },
  dotInner: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.energy },
  flame: { fontSize: 15 },
  chipValue: { color: colors.text, fontWeight: "700", fontSize: 14, fontFamily: "monospace" },
  chipLabel: { color: colors.muted, fontSize: 8, letterSpacing: 1.4, textTransform: "uppercase", marginTop: 1 },
  cashCol: { alignItems: "flex-end" },
  cashValue: { color: colors.yes, fontWeight: "700", fontSize: 14, fontFamily: "monospace" },
  bell: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: colors.panel, borderWidth: 1,
    borderColor: colors.line, alignItems: "center", justifyContent: "center",
  },
  bellGlyph: { fontSize: 17 },
  badge: {
    position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, paddingHorizontal: 4,
    borderRadius: 9, backgroundColor: colors.no, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: colors.bg,
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700", fontFamily: "monospace" },
  shardRow: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 9 },
  shardText: { color: colors.gold, fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: "700" },
  shardTrack: { flex: 1, height: 7, borderRadius: 6, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  shardFill: { height: "100%", backgroundColor: colors.gold, borderRadius: 6 },
  shardHint: { color: colors.muted, fontSize: 9 },
});
