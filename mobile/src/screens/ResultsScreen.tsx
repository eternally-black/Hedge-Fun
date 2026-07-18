// Results — bets + inbox. Native port of src/app/screens/NotificationsScreen.tsx (the settled
// feed) plus the pending half of HistorySheet (open predictions with a live countdown). Opening
// the screen marks every settled result seen — POST /api/results/seen is fire-and-forget (the
// badge was already cleared locally via onSeen; a failed mark just re-syncs from the next /api/me).
import { memo, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { HistoryResponse, HistoryRow, ResultsResponse, ResultRow } from "../../lib/api-types";
import { type Api } from "../api";
import { colors } from "../theme";
import { catOf, cents, countdown, deltaStr, resultMeta, usd } from "../format";

// Per-screen 1s clock — drives the live ⏱ countdown on PENDING rows (web: the history sheet's nowMs
// prop). F12: ticks ONLY while there are pending rows to count down; a settled-only inbox (which needs
// no countdown) never re-renders every second. When it stops, nowMs simply freezes — settled rows
// don't read it, so nothing stales.
function useNowMs(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

export function ResultsScreen({ api, onSeen }: { api: Api; onSeen: () => void }) {
  const [data, setData] = useState<{ pending: HistoryRow[]; settled: ResultRow[] } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // F12: the 1Hz clock only runs when there are pending rows (the sole countdown consumers).
  const hasPending = (data?.pending.length ?? 0) > 0;
  const nowMs = useNowMs(hasPending);

  // Load open + settled, then mark seen. Pending comes from /api/history (PENDING-first rows),
  // settled from /api/results (the inbox feed — seen/shards/verified live there, not in history).
  useEffect(() => {
    let alive = true;
    Promise.all([api("/api/history"), api("/api/results")])
      .then(([h, r]) => {
        if (!alive) return;
        setData({
          pending: (h as HistoryResponse).rows.filter((row) => row.status === "PENDING"),
          settled: (r as ResultsResponse).rows,
        });
        setLoadFailed(false);
      })
      .catch((e) => { if (alive) { console.error(e); setLoadFailed(true); } });
    onSeen();
    api("/api/results/seen", { method: "POST" }).catch(() => { /* badge re-syncs from /api/me */ });
    return () => { alive = false; };
  }, [api, onSeen, nonce]);

  // F12: the settled history is the potentially-huge list, so it's the FlatList's windowed data; the
  // title, load/empty states, and the (small, bounded) pending section ride in the header. SettledRow
  // is memoized and never reads nowMs, so the 1Hz pending clock doesn't re-render settled rows.
  const header = (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Results</Text>
        <Text style={styles.subtitle}>Every call you&apos;ve made — open and settled.</Text>
      </View>

      {data === null && !loadFailed && <ActivityIndicator color={colors.energy} style={{ marginTop: 60 }} />}

      {loadFailed && (
        <View style={{ alignItems: "center", marginTop: 60 }}>
          <Text style={styles.empty}>Couldn&apos;t load your results.</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => setNonce((n) => n + 1)}>
            <Text style={styles.retryText}>↻ Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {data && data.pending.length === 0 && data.settled.length === 0 && (
        <Text style={[styles.empty, { marginTop: 80 }]}>
          No calls yet. Swipe some cards — results land here once markets resolve.
        </Text>
      )}

      {data && data.pending.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Open · {data.pending.length}</Text>
          {data.pending.map((row) => <PendingRow key={row.id} row={row} nowMs={nowMs} />)}
        </View>
      )}

      {data && data.settled.length > 0 && (
        <Text style={[styles.sectionLabel, styles.settledLabel]}>Settled</Text>
      )}
    </View>
  );

  return (
    <FlatList
      style={styles.scroll}
      contentContainerStyle={styles.content}
      data={data?.settled ?? []}
      keyExtractor={(row) => row.id}
      renderItem={({ item }) => <SettledRow row={item} />}
      ListHeaderComponent={header}
      initialNumToRender={12}
      windowSize={11}
      removeClippedSubviews
      ItemSeparatorComponent={SettledSeparator}
    />
  );
}

// 8px gap between settled rows (the old ScrollView section used `gap: 8`).
function SettledSeparator() {
  return <View style={styles.settledGap} />;
}

// One open prediction (native port of HistoryRow.tsx, PENDING branch): side chip, question,
// locked price + stake, and a live countdown — or "Awaiting result" once the deadline passes
// (the market sits in the resolution window; a frozen 0m 00s would look stuck).
function PendingRow({ row, nowMs }: { row: HistoryRow; nowMs: number }) {
  const sideColor = row.side === "YES" ? colors.yes : colors.no;
  const deadlinePassed = new Date(row.resolutionDeadline).getTime() <= nowMs;
  const statusText = deadlinePassed ? "AWAITING" : "PENDING";
  const statusColor = deadlinePassed ? colors.skip : colors.muted;
  const delta = deadlinePassed ? "⏳ result soon" : `⏱ ${countdown(row.resolutionDeadline, nowMs).text}`;

  return (
    <View style={styles.row}>
      <View style={[styles.sideChip, { backgroundColor: `${sideColor}2e` }]}>
        <Text style={[styles.sideChipText, { color: sideColor }]} numberOfLines={1}>
          {row.sideLabel.length > 8 ? `${row.sideLabel.slice(0, 7)}…` : row.sideLabel}
        </Text>
      </View>
      <View style={styles.rowMiddle}>
        <Text style={styles.rowQuestion} numberOfLines={1}>{row.question}</Text>
        <Text style={styles.rowMeta}>{cents(row.lockedPriceBp)} · {usd(row.stakeCents)} stake</Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowStatus, { color: statusColor }]}>{statusText}</Text>
        <Text style={[styles.rowDelta, { color: statusColor }]}>{delta}</Text>
      </View>
    </View>
  );
}

// One settled result (native port of the web InboxRow): category icon, question, your call vs the
// resolved outcome, payout delta + WIN/LOSS/VOID tag, shard drop, and the Solana-anchored badge.
// F12: memoized (its `row` is stable and it never reads the 1Hz clock) so the pending countdown can't
// re-render hundreds of settled rows every second — combined with FlatList windowing above.
const SettledRow = memo(function SettledRow({ row }: { row: ResultRow }) {
  const cat = catOf(row);
  const m = resultMeta(row.status);
  const sideColor = row.side === "YES" ? colors.yes : colors.no;

  return (
    <View style={styles.row}>
      <View style={[styles.catIcon, { backgroundColor: `${m.accent}33` }]}>
        <Text style={{ fontSize: 16 }}>{cat.icon}</Text>
      </View>
      <View style={styles.rowMiddle}>
        <Text style={styles.rowQuestionMulti}>{row.question}</Text>
        <Text style={styles.rowMeta}>
          Your call <Text style={{ color: sideColor, fontWeight: "700" }}>{row.side}</Text> · {row.outcome}
        </Text>
        {row.verified ? (
          <TouchableOpacity
            disabled={!row.onchainRef}
            onPress={() => row.onchainRef && void Linking.openURL(row.onchainRef)}
          >
            <Text style={styles.verified}>⛓ Solana-anchored score</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowPayout, { color: m.accent }]}>{deltaStr(row.status, row.deltaCents)}</Text>
        <Text style={[styles.rowStatus, { color: m.accent }]}>{m.tag}</Text>
        {row.shards > 0 && <Text style={styles.shardDrop}>+{row.shards} ◆</Text>}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  title: { color: colors.text, fontSize: 26, fontWeight: "900" },
  subtitle: { color: colors.muted, fontSize: 11, marginTop: 6, flexShrink: 1 },
  empty: { color: colors.muted, fontSize: 13, textAlign: "center", lineHeight: 19, paddingHorizontal: 24 },
  retryBtn: {
    marginTop: 16, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 22,
  },
  retryText: { color: colors.energy, fontWeight: "700", fontSize: 14 },
  section: { marginTop: 16, gap: 8 },
  sectionLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700" },
  settledLabel: { marginTop: 16, marginBottom: 8 }, // the "Settled" header above the windowed FlatList rows
  settledGap: { height: 8 }, // ItemSeparator between settled rows (matches the old section gap)
  row: {
    flexDirection: "row", gap: 11, backgroundColor: colors.panel, borderWidth: 1,
    borderColor: colors.line, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 13,
  },
  sideChip: { minWidth: 34, height: 34, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", justifyContent: "center", maxWidth: 80 },
  sideChipText: { fontSize: 12, fontWeight: "900" },
  catIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  rowMiddle: { flex: 1, minWidth: 0 },
  rowQuestion: { color: colors.text, fontSize: 13, fontWeight: "600", lineHeight: 16 },
  rowQuestionMulti: { color: colors.text, fontSize: 13, fontWeight: "600", lineHeight: 16 },
  rowMeta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  rowRight: { alignItems: "flex-end", flexShrink: 0 },
  rowStatus: { fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: "700", marginTop: 2 },
  rowDelta: { fontFamily: "monospace", fontSize: 12, marginTop: 2 },
  rowPayout: { fontFamily: "monospace", fontWeight: "700", fontSize: 14 },
  verified: { color: colors.yes, fontSize: 10, fontWeight: "700", marginTop: 5 },
  shardDrop: { color: colors.gold, fontSize: 10, marginTop: 2 },
});
