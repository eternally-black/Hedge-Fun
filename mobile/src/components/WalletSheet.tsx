// WalletSheet (native) — port of the wallet half of src/app/screens/BalanceSheet.tsx: the ONE money
// sheet, opened from the HUD balance chip on every screen. One pocket per kind of money, named by
// purpose (Paper, the play balance; Real · Stocks, the connected Solana wallet; Real · Predictions,
// the Polymarket balance), then the History tabs (Calls / Stocks / Hedges) like the web sheet.
import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { MeResponse, StockPortfolioResponse, StockPositionRow } from "@contract/api-types";
import { toPredictionRow, useClosePosition, useExitQuotes, usePredictionHistory } from "../usePredictionHistory";
import { PredictionRow } from "./PredictionRow";
import { StockHistoryRow } from "../screens/PortfolioScreen";
import { statusOf, type Api } from "../api";
import { usd } from "../format";
import { colors } from "../theme";
import * as wallet from "../platform/wallet.flavor";
import { pocketStyles, RealDepositPanel } from "./RealDepositPanel";

type StockPocketState = { address: string | null; usdCents: number | null; sponsored: boolean; refresh: () => Promise<void> };

export function WalletSheet({ visible, me, api, realPusdMicro, stock, onClose, onTopupDone, onToast }: {
  visible: boolean;
  me: MeResponse | null;
  api: Api;
  realPusdMicro: string | null;
  // Owned and polled by Root, so this sheet and the HUD state the same number.
  stock: StockPocketState;
  onClose: () => void;
  onTopupDone: () => void | Promise<void>;
  onToast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const doTopup = useCallback(async (kind: "free" | "artifact") => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/topup", { method: "POST", body: JSON.stringify({ kind }) });
      await onTopupDone(); // parent refreshMe() → fresh cash/locked/topup
      onClose();
    } catch (e) {
      // 409 = free already used / no longer eligible (raced the gate); 402 = no artifact.
      onToast(statusOf(e) === 402 ? "Need an artifact to top up" : "Top-up unavailable right now");
    } finally {
      setBusy(false);
    }
  }, [api, busy, onClose, onTopupDone, onToast]);

  // The Play build has no real pockets at all.
  const isReal = wallet.available && me?.real.mode === "REAL";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          {/* flexShrink: the sheet caps its height (maxHeight 88%), and a ScrollView that doesn't shrink
              takes its full content height instead — the overflow is clipped by the sheet and there is
              nothing left to scroll (the History list sat below the fold, unreachable). */}
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Text style={styles.title}>Wallet</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close">
                <Text style={styles.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* One layout per pocket, ordered by the app's Paper/Real switch: the pockets real mode
                spends first, play money last. In paper mode the Polymarket pocket is not shown — the
                switch itself lives on the Profile screen. */}
            {isReal ? (
              <>
                <StockPocket stock={stock} onToast={onToast} />
                <RealDepositPanel me={me} api={api} pusdMicro={realPusdMicro} onToast={onToast} label="Real · Predictions" />
                <PaperPocket me={me} busy={busy} onTopup={doTopup} />
              </>
            ) : (
              <>
                <PaperPocket me={me} busy={busy} onTopup={doTopup} />
                {wallet.available ? <StockPocket stock={stock} onToast={onToast} /> : null}
              </>
            )}

            {/* Mounted only while the sheet is open: the history is re-read on every opening and
                the 1s exit-quote poll never runs for a closed sheet. */}
            {visible ? <History me={me} api={api} onToast={onToast} onClose={onClose} /> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// The lower half of the web BalanceSheet: three tabs — Calls (prediction bets, /api/history), Stocks
// (tokenized-stock lots, /api/stocks/portfolio), Hedges (the accepted hedge legs of both kinds).
type Tab = "calls" | "stocks" | "hedges";
const TABS: { key: Tab; label: string }[] = [
  { key: "calls", label: "Calls" },
  { key: "stocks", label: "Stocks" },
  { key: "hedges", label: "Hedges" },
];

// Stock lots, fetched the first time a tab that shows them opens. Open lots first, then closed.
function useStockHistory(api: Api, wanted: boolean) {
  const [rows, setRows] = useState<StockPositionRow[] | null>(null);
  useEffect(() => {
    if (!wanted || rows) return;
    let alive = true;
    void (async () => {
      try {
        const r = (await api("/api/stocks/portfolio")) as StockPortfolioResponse;
        if (alive) setRows([...r.open, ...r.closed]);
      } catch {
        if (alive) setRows([]);
      }
    })();
    return () => { alive = false; };
  }, [api, wanted, rows]);
  return rows;
}

function History({ me, api, onToast, onClose }: { me: MeResponse | null; api: Api; onToast: (m: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("calls");
  const { rows, pending, nowMs, refresh, hasMore, loadMore, error } = usePredictionHistory(api);
  const { close, closing } = useClosePosition(api, me, onToast, refresh);
  // The Stocks tab shows no prediction rows, so the exit-quote poll has nothing to price there.
  const callsVisible = tab === "calls" || tab === "hedges";
  const exitQuotes = useExitQuotes(api, rows, callsVisible);
  const stocks = useStockHistory(api, tab !== "calls");

  // ponytail: Hedges filters the pages loaded so far (50 per page) — a hedge older than the loaded
  // window shows up after "Load more"; a server-side ?source= filter if that ever bites.
  const callRows = tab === "hedges" ? rows?.filter((r) => r.source === "HEDGE") ?? null : tab === "calls" ? rows : null;
  const stockRows = tab === "hedges" ? stocks?.filter((r) => r.source === "HEDGE") ?? null : tab === "stocks" ? stocks : null;
  const loading = (tab !== "stocks" && !rows) || (tab !== "calls" && !stocks);
  const empty = !loading && (callRows?.length ?? 0) + (stockRows?.length ?? 0) === 0;
  // A failed history read is not "no calls yet" — telling someone with open positions they have
  // none is the worst thing this sheet can say.
  const failed = error && callsVisible;
  const emptyCopy =
    tab === "calls" ? "No predictions yet. Swipe a card to make your first call."
    : tab === "stocks" ? "No stocks yet. Swipe right on the Stocks deck to buy one."
    : "No hedges yet. The Hedge tab turns a life cost or a wallet into one.";
  // Selling is a real-money action — only a build that can sign offers it.
  const canClose = wallet.available;

  return (
    <View>
      <View style={styles.historyHead}>
        <Text style={styles.historyTitle}>History</Text>
        {tab === "calls" && pending > 0 ? <Text style={styles.openCount}>{pending} open</Text> : null}
        <TouchableOpacity onPress={onClose} style={[styles.closeBtn, { marginLeft: "auto" }]} accessibilityLabel="Close">
          <Text style={styles.closeBtnText}>✕</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((t) => {
          const on = t.key === tab;
          return (
            <TouchableOpacity
              key={t.key}
              onPress={() => setTab(t.key)}
              style={[styles.tab, on && styles.tabOn]}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.tabText, on && styles.tabTextOn]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <Text style={styles.historyNote}>Loading…</Text>
      ) : (
        <View style={styles.historyList}>
          {failed ? (
            <TouchableOpacity onPress={() => void refresh()} style={styles.retry}>
              <Text style={styles.retryText}>Couldn&apos;t load — tap to retry</Text>
            </TouchableOpacity>
          ) : null}
          {empty && !failed ? <Text style={styles.historyNote}>{emptyCopy}</Text> : null}
          {stockRows?.map((r) => <StockHistoryRow key={r.id} row={r} />)}
          {callRows?.map((r) => (
            <PredictionRow
              key={r.id}
              row={toPredictionRow(r)}
              // Only an open row reads the clock; a settled one gets a constant so the 1 s tick does
              // not re-render every row of the list.
              nowMs={r.status === "PENDING" ? nowMs : 0}
              onClosePosition={canClose ? () => close(r) : undefined}
              closing={closing === r.id}
              exitQuote={exitQuotes[r.id]}
            />
          ))}
          {tab !== "stocks" && hasMore ? (
            <TouchableOpacity onPress={() => void loadMore()} style={styles.loadMore}>
              <Text style={styles.loadMoreText}>Load more</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

// PAPER — play money. The top-up lives here and nowhere else: the pockets are named, so "claim free
// $200" can no longer be mistaken for a way to fund a real one.
function PaperPocket({ me, busy, onTopup }: { me: MeResponse | null; busy: boolean; onTopup: (k: "free" | "artifact") => void }) {
  return (
    <View style={pocketStyles.panel}>
      <Text style={pocketStyles.label}>Paper</Text>
      <Text style={[pocketStyles.amount, { color: colors.yes }]}>{me ? usd(Math.max(0, me.cashCents)) : "—"}</Text>
      <Text style={pocketStyles.note}>
        {me ? `Play money. ${usd(me.lockedCents)} in play · ${usd(me.balanceCents)} total.` : "Play money."}
      </Text>
      <TopupButton me={me} busy={busy} onTopup={onTopup} />
    </View>
  );
}

// REAL · STOCKS. On the phone this is always the wallet connected through Mobile Wallet Adapter (the
// web shows its embedded wallet here), so the note is the web's connected-wallet line. No QR: the
// address is one tap away from the clipboard.
function StockPocket({ stock, onToast }: { stock: StockPocketState; onToast: (m: string) => void }) {
  const { address, usdCents, refresh } = stock;
  // A toast renders under the wallet Modal, so the copy confirmation lives on the button itself.
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!address) return;
    try {
      await Clipboard.setStringAsync(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onToast("Couldn't copy — select the address instead");
    }
  };
  const note = !address
    ? "Connect a wallet in your profile to trade stocks with real money."
    : "The wallet you connected — fund it from your wallet app.";

  return (
    <View style={pocketStyles.panel}>
      <Text style={pocketStyles.label}>Real · Stocks</Text>
      <Text style={[pocketStyles.amount, { color: colors.gold }]}>{usdCents == null ? "—" : usd(usdCents)}</Text>
      <Text style={pocketStyles.note}>{note}</Text>
      {address ? (
        <>
          <Text selectable style={styles.address}>{address}</Text>
          <View style={pocketStyles.actionRow}>
            <TouchableOpacity onPress={() => void copy()} style={[pocketStyles.action, pocketStyles.gold]}>
              <Text style={[pocketStyles.actionText, pocketStyles.goldText]}>{copied ? "Copied ✓" : "Copy address"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void refresh()} style={[pocketStyles.action, pocketStyles.quiet]}>
              <Text style={[pocketStyles.actionText, pocketStyles.quietText]}>↻ Refresh</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </View>
  );
}

// One affordance, derived from me.topup. Always visible; disabled when neither path is open.
function TopupButton({ me, busy, onTopup }: { me: MeResponse | null; busy: boolean; onTopup: (k: "free" | "artifact") => void }) {
  if (!me) return null;
  const t = me.topup;
  const grant = usd(t.grantCents);

  // Holds an artifact but Cash is at/above the gate → the top-up is intentionally locked (it bails
  // out a low balance, not a full one). Show it inactive with the $ threshold.
  const hasArtifact = me.artifacts >= t.artifactCost;
  const cashTooHigh = me.cashCents >= t.artifactCashGateCents;
  const gate = usd(t.artifactCashGateCents);

  let label: string, kind: "free" | "artifact" | null, primary = false;
  if (t.freeTopupAvailable) { label = `Claim free ${grant}`; kind = "free"; primary = true; }
  else if (t.artifactTopupAvailable) { label = `Top up ${grant} · 1 ◆`; kind = "artifact"; primary = true; }
  else if (hasArtifact && cashTooHigh) { label = `Top-up locked — Cash must be under ${gate}`; kind = null; }
  else if (!t.freeTopupUsed) { label = "Free top-up unlocks when low on cash"; kind = null; }
  else { label = "Earn an artifact to top up"; kind = null; }

  const disabled = kind === null || busy;
  return (
    <View style={pocketStyles.actionRow}>
      <TouchableOpacity
        onPress={() => kind && onTopup(kind)}
        disabled={disabled}
        style={[pocketStyles.action, primary ? { backgroundColor: colors.yes } : pocketStyles.quiet, busy && { opacity: 0.6 }]}
      >
        <Text style={[pocketStyles.actionText, { color: primary ? "#06140b" : colors.muted }]}>{busy ? "…" : label}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(4,4,8,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.bg2, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 18, paddingBottom: 28, paddingTop: 8,
    maxHeight: "88%",
  },
  scroll: { flexShrink: 1 },
  handle: { width: 42, height: 5, borderRadius: 4, backgroundColor: colors.line, alignSelf: "center", marginBottom: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  title: { color: colors.text, fontSize: 26, fontWeight: "900", flex: 1 },
  closeBtn: {
    width: 30, height: 30, borderRadius: 999, backgroundColor: colors.panel,
    borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center",
  },
  closeBtnText: { color: colors.muted, fontSize: 15 },
  address: { marginTop: 10, fontFamily: "monospace", fontSize: 11, color: colors.text, lineHeight: 16 },
  historyHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  historyTitle: { color: colors.text, fontSize: 26, fontWeight: "900" },
  openCount: { fontSize: 11, color: colors.skip, fontWeight: "700" },
  tabs: {
    flexDirection: "row", gap: 6, marginBottom: 12, backgroundColor: colors.panel, borderWidth: 1,
    borderColor: colors.line, borderRadius: 999, padding: 3,
  },
  tab: { flex: 1, paddingVertical: 7, borderRadius: 999, alignItems: "center" },
  tabOn: { backgroundColor: colors.energy },
  tabText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5, color: colors.muted },
  tabTextOn: { color: "#fff" },
  historyList: { gap: 8 },
  historyNote: { textAlign: "center", color: colors.muted, padding: 24, fontSize: 13 },
  retry: { padding: 24, borderRadius: 14, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, alignItems: "center" },
  retryText: { color: colors.muted, fontSize: 13 },
  loadMore: {
    marginTop: 4, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: colors.panel2,
    borderWidth: 1, borderColor: colors.line, alignItems: "center",
  },
  loadMoreText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
});
