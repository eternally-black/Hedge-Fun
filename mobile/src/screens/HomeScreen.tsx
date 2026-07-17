// Home / GM — the daily check-in. Native port of src/app/screens/GmScreen.tsx: one tap = streak day
// + login bonus (POST /api/login-mark, ?ref= carried if a code is stored — idempotent server-side).
// Burned streaks can be revived with 1 artifact right here (POST /api/recover).
import { useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse, StreakState } from "../../lib/api-types";
import { type Api } from "../api";
import { colors } from "../theme";
import { readRefCode } from "../refCode";

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const;
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

type DayCell = { label: string; isToday: boolean; isDone: boolean; isWindowStart: boolean };

// Pure: build the 7 Mon→Sun cells from the user's streak state (same math as web's buildGmWeek).
function buildGmWeek(todayWeekday: number, windowStartWeekday: number, streakLevel: number, checkedInToday: boolean): DayCell[] {
  const doneBeforeToday = streakLevel > 0 ? (streakLevel - (checkedInToday ? 1 : 0)) % 7 : 0;
  return DAY_LABELS.map((label, col) => {
    const posInWindow = (col - windowStartWeekday + 7) % 7;
    const isToday = col === todayWeekday;
    const isDone = posInWindow < doneBeforeToday || (checkedInToday && isToday);
    return { label, isToday, isDone, isWindowStart: col === windowStartWeekday };
  });
}

type GmStatus = "checkedIn" | "claim" | "burnedHasArtifact" | "burnedNoArtifact" | "lost";

// Which GM hero to render (same rules as web's gmStatus).
function gmStatus(state: StreakState, done: boolean, artifacts: number): GmStatus {
  if (state === "LOST") return "lost";
  if (state === "BURNED_RECOVERABLE") return artifacts > 0 ? "burnedHasArtifact" : "burnedNoArtifact";
  return done ? "checkedIn" : "claim";
}

const GM_SUBTITLE: Record<GmStatus, string> = {
  checkedIn: "You're checked in. Streak is safe — come back tomorrow.",
  claim: "Check in to keep your streak burning.",
  burnedHasArtifact: "Your streak broke. Spend an artifact to revive it before the window closes — or it resets to 0.",
  burnedNoArtifact: "Your streak broke. Without an artifact it can't be restored, and it resets to 0 when the recovery window closes.",
  lost: "Your streak broke and the recovery window closed — it can't be restored. Tap to start a fresh one.",
};

export function HomeScreen({ me, api, onRefreshMe, onEnterDeck }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onEnterDeck: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const done = me?.loginMarkedToday ?? false;
  const streak = me?.streak.level ?? 0;
  const week = buildGmWeek(me?.streak.todayWeekday ?? 0, me?.streak.windowStartWeekday ?? 0, streak, done);
  const status = gmStatus(me?.streak.state ?? "ACTIVE", done, me?.artifacts ?? 0);
  const burned = status === "burnedHasArtifact" || status === "burnedNoArtifact";
  const broken = burned || status === "lost";

  // GM tap: the daily check-in. Carries the stored referral code (if any) — capture is idempotent
  // server-side, and capture-ref on boot usually got there first.
  const gm = useCallback(async () => {
    setBusy(true);
    try {
      const code = await readRefCode();
      await api(code ? `/api/login-mark?ref=${encodeURIComponent(code)}` : "/api/login-mark", { method: "POST" });
      await onRefreshMe();
    } finally {
      setBusy(false);
    }
  }, [api, onRefreshMe]);

  // Spend 1 artifact to revive a burned (recoverable) streak.
  const revive = useCallback(async () => {
    setBusy(true);
    try {
      await api("/api/recover", { method: "POST" });
      await onRefreshMe();
    } finally {
      setBusy(false);
    }
  }, [api, onRefreshMe]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.emoji}>{broken ? "💀" : "🔥"}</Text>
      <Text style={styles.title}>{broken ? "STREAK BROKEN" : "GM, DEGEN"}</Text>
      <Text style={[styles.subtitle, broken && { color: colors.no }]}>{GM_SUBTITLE[status]}</Text>

      <View style={styles.weekRow}>
        {week.map((d, i) => (
          <View key={i} style={styles.weekItemWrap}>
            {d.isWindowStart && i > 0 && <View style={styles.cutoff} />}
            <View style={styles.weekItem}>
              <View style={[
                styles.dayCell,
                d.isToday && { borderColor: colors.energy },
                d.isDone && !d.isToday && { borderColor: colors.gold },
                d.isDone && { backgroundColor: "rgba(255,194,75,0.22)" },
              ]}>
                <Text style={styles.dayCellText}>{d.isDone ? "🔥" : d.isToday && !done ? "☀" : ""}</Text>
              </View>
              <Text style={[styles.dayLabel, d.isWindowStart && { color: colors.energy, fontWeight: "700" }]}>{d.label}</Text>
            </View>
          </View>
        ))}
      </View>
      <Text style={styles.weekNote}>Your week starts {DAY_NAMES[me?.streak.windowStartWeekday ?? 0]}</Text>

      <View style={styles.statsPanel}>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.energy }]}>+1</Text>
          <Text style={styles.statLabel}>Point</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.gold }]}>🔥 {streak}</Text>
          <Text style={styles.statLabel}>Streak</Text>
        </View>
      </View>

      {busy ? (
        <ActivityIndicator color={colors.energy} style={{ marginTop: 26 }} />
      ) : burned ? (
        <TouchableOpacity
          style={[styles.cta, status === "burnedNoArtifact" ? styles.ctaDisabled : styles.ctaGold]}
          onPress={status === "burnedNoArtifact" ? undefined : revive}
          disabled={status === "burnedNoArtifact"}
        >
          <Text style={[styles.ctaText, status === "burnedNoArtifact" && { color: colors.muted }]}>
            {status === "burnedHasArtifact" ? "🛡 Spend 1 Artifact → Revive streak" : "No artifact to revive"}
          </Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.cta} onPress={status === "checkedIn" ? onEnterDeck : gm}>
          <Text style={styles.ctaText}>
            {status === "checkedIn" ? "Enter the deck →" : status === "lost" ? "☀ Start a new streak" : "☀ Claim & keep streak"}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emoji: { fontSize: 64 },
  title: { color: colors.text, fontSize: 44, lineHeight: 44, fontWeight: "900", marginTop: 10, textAlign: "center" },
  subtitle: { color: colors.muted, fontSize: 14, maxWidth: 290, marginTop: 8, textAlign: "center", lineHeight: 20 },
  weekRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 24 },
  weekItemWrap: { flexDirection: "row", alignItems: "stretch", gap: 8 },
  cutoff: { width: 2, alignSelf: "stretch", borderRadius: 2, backgroundColor: colors.energy, opacity: 0.7 },
  weekItem: { alignItems: "center", gap: 5 },
  dayCell: {
    width: 30, height: 30, borderRadius: 10, backgroundColor: colors.panel,
    borderWidth: 1.5, borderColor: colors.line, alignItems: "center", justifyContent: "center",
  },
  dayCellText: { fontSize: 13 },
  dayLabel: { fontSize: 10, color: colors.muted },
  weekNote: { fontSize: 9, color: colors.muted, marginTop: 8, opacity: 0.8 },
  statsPanel: {
    flexDirection: "row", gap: 22, marginTop: 22, backgroundColor: colors.panel,
    borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 22,
  },
  stat: { alignItems: "center" },
  statValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 22 },
  statLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: colors.muted, marginTop: 2 },
  statDivider: { width: 1, backgroundColor: colors.line },
  cta: {
    marginTop: 26, width: "100%", maxWidth: 300, borderRadius: 18, paddingVertical: 16,
    alignItems: "center", backgroundColor: colors.energy,
  },
  ctaGold: { backgroundColor: colors.gold },
  ctaDisabled: { backgroundColor: colors.panel2 },
  ctaText: { color: "#fff", fontSize: 18, fontWeight: "900" },
});
