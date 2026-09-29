// Results — native port of src/app/screens/NotificationsScreen.tsx. The settled feed of every call,
// newest first, plus the "In profit" strip of tokenized-stock lots that crossed a profit tier.
// Opening it marks what it received as seen (clears the HUD bell) — stock alerts by the exact
// (position, tier) pairs delivered, so a tier that fires while the list is open stays unread.
// "Replay" re-runs the reveal. Open calls live in the Wallet sheet's History, as on the web.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { ResultsResponse, ResultRow, StockAlertRow as StockAlertRowData } from "@contract/api-types";
import { type Api } from "../api";
import { colors, withAlpha } from "../theme";
import { PredictionRow, type PredictionRowData } from "../components/PredictionRow";
import { StockAlertRow } from "../components/StockAlertRow";

type PendingAck = {
  key: string;
  body: { scope: "bets" | "both"; mode: "PAPER" | "REAL"; betIds: string[]; stockAlerts?: { positionId: string; tierBp: number }[] };
  betCount: number;
  stockCount: number;
};

export function ResultsScreen({ api, onSeen, onReplay, onOpenStock, onAckFailed }: {
  api: Api;
  onSeen: (betCount: number, stockCount: number) => void;
  onReplay: () => void;
  onOpenStock?: () => void;
  onAckFailed: () => void;
}) {
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [stockAlerts, setStockAlerts] = useState<StockAlertRowData[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [ackQueue, setAckQueue] = useState<PendingAck[]>([]);
  // A double tap on "Load more" must not append the same page twice.
  const loadingMore = useRef(false);
  const aliveRef = useRef(false);
  const stagedAckKeys = useRef(new Set<string>());
  const startedAckKeys = useRef(new Set<string>());
  // Nothing in this feed counts down — every row is decided — so one clock read is enough.
  const nowMs = useRef(Date.now()).current;
  const stageAck = useCallback((ack: PendingAck) => {
    if (stagedAckKeys.current.has(ack.key)) return;
    stagedAckKeys.current.add(ack.key);
    setAckQueue((queue) => [...queue, ack]);
  }, []);

  // Load the feed, commit it, then acknowledge exactly the unseen rows delivered in that response.
  useEffect(() => {
    let alive = true;
    aliveRef.current = true;
    api("/api/results")
      .then((r) => {
        if (!alive) return;
        const res = r as ResultsResponse;
        const alerts = res.stockAlerts ?? [];
        setRows(res.rows);
        setStockAlerts(alerts);
        setNextCursor(res.nextCursor);
        setLoadFailed(false);
        const betIds = res.rows.filter((row) => !row.seen).map((row) => row.id);
        const unseen = alerts.filter((a) => !a.seen).map((a) => ({ positionId: a.positionId, tierBp: a.tierBp }));
        if (betIds.length === 0 && unseen.length === 0) return;
        stageAck({
          key: `initial:${res.mode}:${betIds.join(",")}:${unseen.map((a) => `${a.positionId}/${a.tierBp}`).join(",")}`,
          body: { scope: "both", mode: res.mode, betIds, stockAlerts: unseen },
          betCount: betIds.length,
          stockCount: unseen.length,
        });
      })
      .catch((e) => { if (alive) { console.error(e); setLoadFailed(true); } });
    return () => { alive = false; aliveRef.current = false; };
  }, [api, nonce, stageAck]);

  // ACK only after the rows above have committed; the started-key fence keeps the optimistic badge
  // decrement and the POST single-shot.
  useEffect(() => {
    const ack = ackQueue[0];
    if (!ack || startedAckKeys.current.has(ack.key)) return;
    startedAckKeys.current.add(ack.key);
    onSeen(ack.betCount, ack.stockCount);
    api("/api/results/seen", { method: "POST", body: JSON.stringify(ack.body) })
      .catch(console.error)
      .finally(() => {
        onAckFailed();
        if (aliveRef.current) setAckQueue((queue) => queue.filter((item) => item.key !== ack.key));
      });
  }, [ackQueue, api, onSeen, onAckFailed]);

  const loadMore = useCallback(async () => {
    if (loadingMore.current || nextCursor === null) return;
    loadingMore.current = true;
    try {
      const r = (await api(`/api/results?cursor=${encodeURIComponent(nextCursor)}`)) as ResultsResponse;
      if (!aliveRef.current) return;
      setRows((cur) => [...(cur ?? []), ...r.rows]);
      setNextCursor(r.nextCursor);
      const betIds = r.rows.filter((row) => !row.seen).map((row) => row.id);
      if (betIds.length > 0) {
        stageAck({ key: `page:${r.mode}:${betIds.join(",")}`, body: { scope: "bets", mode: r.mode, betIds }, betCount: betIds.length, stockCount: 0 });
      }
    } catch (e) {
      if (aliveRef.current) console.error(e);
    } finally {
      loadingMore.current = false;
    }
  }, [api, nextCursor, stageAck]);

  // The settled history is the potentially huge list, so it is the FlatList's windowed data; the
  // title, the In-profit strip, the replay control and the load/empty states ride in the header.
  const header = (
    <View>
      <View style={styles.headerRow}>
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.title}>Results</Text>
          <Text style={styles.subtitle}>Every call you&apos;ve made, settled.</Text>
        </View>
        {rows !== null && rows.length > 0 ? (
          <TouchableOpacity style={styles.replayBtn} onPress={onReplay} accessibilityRole="button" accessibilityLabel="Replay results reveal">
            <Text style={styles.replayText}>▸ Replay</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {stockAlerts.length > 0 ? (
        <View style={styles.stockSection}>
          <View style={styles.stockHeader}>
            <Text style={styles.stockTitle}>In profit</Text>
            <Text style={styles.stockCount}>· {stockAlerts.length}</Text>
          </View>
          <View style={styles.stockList}>
            {stockAlerts.map((a) => <StockAlertRow key={`${a.positionId}:${a.tierBp}`} row={a} onOpen={onOpenStock} />)}
          </View>
        </View>
      ) : null}

      {rows === null && !loadFailed ? <ActivityIndicator color={colors.energy} style={{ marginTop: 60 }} /> : null}

      {loadFailed ? (
        <View style={styles.failBox}>
          <Text style={styles.empty}>Couldn&apos;t load your results.</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => setNonce((n) => n + 1)}>
            <Text style={styles.retryText}>↻ Retry</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {rows !== null && rows.length === 0 && stockAlerts.length === 0 ? (
        <Text style={[styles.empty, { marginTop: 80 }]}>
          Nothing settled yet. Swipe some cards — results land here once markets resolve.
        </Text>
      ) : null}
      {rows !== null && rows.length > 0 ? <View style={{ height: 14 }} /> : null}
    </View>
  );

  return (
    <FlatList
      style={styles.scroll}
      contentContainerStyle={styles.content}
      data={rows ?? []}
      keyExtractor={(row) => row.id}
      renderItem={({ item }) => <PredictionRow row={toPredictionRow(item)} nowMs={nowMs} />}
      ListHeaderComponent={header}
      initialNumToRender={12}
      windowSize={11}
      removeClippedSubviews
      ItemSeparatorComponent={SettledSeparator}
      ListFooterComponent={
        nextCursor !== null ? (
          <TouchableOpacity style={styles.loadMoreBtn} onPress={() => void loadMore()} accessibilityRole="button">
            <Text style={styles.loadMoreText}>Load more</Text>
          </TouchableOpacity>
        ) : null
      }
      onEndReached={() => void loadMore()}
      onEndReachedThreshold={0.4}
    />
  );
}

function SettledSeparator() {
  return <View style={styles.settledGap} />;
}

// A settled result in the shape every list of the user's own calls renders. The inbox has no
// deadline to show — the market is decided, and `outcome` says how.
function toPredictionRow(r: ResultRow): PredictionRowData {
  return {
    id: r.id,
    question: r.question,
    side: r.side,
    sideLabel: r.sideLabel,
    status: r.status,
    league: r.league,
    category: r.category,
    stakeCents: r.stakeCents,
    lockedPriceBp: r.lockedPriceBp,
    pnlCents: r.deltaCents,
    createdAt: r.createdAt,
    settledAt: r.settledAt,
    outcome: r.outcome,
    shards: r.shards,
  };
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  title: { color: colors.text, fontSize: 26, fontWeight: "900" },
  subtitle: { color: colors.muted, fontSize: 11, marginTop: 2 },
  replayBtn: {
    marginLeft: "auto", backgroundColor: withAlpha(colors.energy, "29"), borderWidth: 1, borderColor: withAlpha(colors.energy, "66"),
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12,
  },
  replayText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  stockSection: { marginTop: 16 },
  stockHeader: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 8 },
  stockTitle: { color: colors.text, fontSize: 18, fontWeight: "900" },
  stockCount: { color: colors.muted, fontSize: 11 },
  stockList: { gap: 8 },
  empty: { color: colors.muted, fontSize: 13, textAlign: "center", lineHeight: 19, paddingHorizontal: 24 },
  failBox: { alignItems: "center", marginTop: 60 },
  retryBtn: {
    marginTop: 16, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 22,
  },
  retryText: { color: colors.energy, fontWeight: "700", fontSize: 14 },
  settledGap: { height: 8 },
  loadMoreBtn: {
    marginTop: 12, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, alignItems: "center",
  },
  loadMoreText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
});
