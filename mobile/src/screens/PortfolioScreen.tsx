// PortfolioScreen (native) — the Stocks tab: open and closed tokenized-stock lots, both economies. Native twin of
// src/app/screens/PortfolioScreen.tsx. The web's wallet-pocket line is gone (no wallet pocket on the phone — the
// Profile owns the wallet), and the pending-buy replay is gone with it (the server sweep + wallet-lot adoption
// recover a lost confirm; nothing is written to the device). Everything else is the web's logic verbatim.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse, StockPortfolioResponse, StockPositionRow } from "@contract/api-types";
import { type Api } from "../api";
import { colors, withAlpha } from "../theme";
import { usd } from "../format";
import { useBuyReal } from "../useBuyReal";
import { StockConsentSheet } from "../components/StockConsentSheet";
import * as wallet from "../platform/wallet.flavor";
import { REAL_BALANCE_POLL_MS } from "../../lib/config";

// The Portfolio (Stocklana): every tokenized-stock lot the user owns, paper and on-chain, in one
// list. Open lots carry their live mark and a two-tap Sell — paper rows sell paper, on-chain rows
// swap back to the wallet. BUYING is the deck's job (one swipe, in the app's current mode), so no
// row offers it. Closed lots collapse behind a toggle — they are history, not the thing you came to
// look at. Pending real buys show as a strip while the poller confirms them.
export function PortfolioScreen({
  me,
  api,
  onRefreshMe,
  onToast,
  onNeedWallet,
}: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
  onNeedWallet: () => void;
}) {
  const [data, setData] = useState<StockPortfolioResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);
  const [selling, setSelling] = useState<string | null>(null);
  // The armed row id — ONE arm at a time across the screen, so a stale arm on a row you scrolled
  // past can never turn the next tap into a sale.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  const arm = useCallback((key: string) => {
    setArmed(key);
    clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(null), 3000);
  }, []);
  const disarm = useCallback(() => {
    clearTimeout(armTimer.current);
    setArmed(null);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = (await api("/api/stocks/portfolio")) as StockPortfolioResponse;
      setData(r);
      setLoadFailed(false);
    } catch (e) {
      console.error(e);
      setLoadFailed(true);
    }
  }, [api]);

  const onDone = useCallback(() => { void load(); void onRefreshMe(); }, [load, onRefreshMe]);
  const real = useBuyReal({
    api,
    me,
    onToast,
    onNeedWallet,
    onRefreshMe,
    ctx: { wallets: data?.wallets ?? [], stockConsent: data?.stockConsent ?? false, sponsored: data?.sponsored },
    onDone,
  });
  const sellReal = real.sellReal;

  // Selling a REAL lot is the same two-tap as a paper sell, but the work happens in the hook (build,
  // sign, submit, confirm). `selling` is shared: a row is either paper or on-chain, never both.
  const sellOnChain = useCallback(
    async (row: StockPositionRow) => {
      setSelling(row.id);
      try {
        await sellReal(row.id, { symbol: row.symbol, ctx: { wallets: data?.wallets ?? [], stockConsent: data?.stockConsent ?? false, sponsored: data?.sponsored } });
      } catch (e) {
        // The hook toasts its own failures; this is the backstop for a rejected promise, so a
        // thrown sell can never leave the row silent after "Selling…".
        console.error(e);
        onToast("Couldn't sell — try again");
      } finally {
        setSelling(null);
      }
    },
    [data, onToast, sellReal],
  );

  // Initial load. The web's pending-buy replay is deliberately absent: nothing is written to the
  // device, so there is nothing to replay — the server sweep and the portfolio's wallet-lot
  // adoption recover a confirm lost between send and book.
  useEffect(() => {
    void load();
  }, [load]);

  // Foreground-gated re-poll: a backgrounded app is a read for a number nobody is looking at.
  // Coming back re-reads immediately, which is also the moment someone returns from the wallet
  // they just bought from.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
    const start = () => {
      stop();
      timer = setInterval(() => void load(), REAL_BALANCE_POLL_MS);
    };
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") { stop(); return; }
      void load();
      start();
    });
    if (AppState.currentState === "active") start();
    return () => { stop(); sub.remove(); };
  }, [load]);

  const sell = useCallback(
    async (row: StockPositionRow) => {
      setSelling(row.id);
      try {
        const r = (await api("/api/stocks/sell", {
          method: "POST",
          body: JSON.stringify({ positionId: row.id }),
        })) as { proceedsCents: number; pnlCents: number };
        onToast(`Sold ${row.symbol}: ${signed(r.pnlCents)}`);
        await load();
        await onRefreshMe();
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409) onToast("Already sold");
        else if (status === 502) onToast("Price unavailable — try again");
        // A network drop or a 500 must not leave the row on "Selling…" and then nothing.
        else { console.error(e); onToast("Couldn't sell — try again"); }
      } finally {
        setSelling(null);
      }
    },
    [api, load, onRefreshMe, onToast],
  );

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const open = data?.open ?? [];
  const closed = data?.closed ?? [];
  const pending = data?.pendingAttempts ?? [];
  const paper = data?.totals.paper ?? { costCents: 0, valueCents: 0, pnlCents: 0 };
  const realTotals = data?.totals.real ?? { costCents: 0, valueCents: 0, pnlCents: 0 };
  const hasReal = realTotals.costCents > 0 || open.some((r) => r.mode === "REAL");

  return (
    <>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={colors.energy} />}
      >
        <Text style={styles.title}>Portfolio</Text>
        <Text style={styles.subtitle}>Tokenized stocks you own — paper and on-chain.</Text>

        <View style={styles.tilesRow}>
          <TotalTile label="Paper" totals={paper} />
          {hasReal ? <TotalTile label="On-chain" totals={realTotals} /> : null}
        </View>

        {pending.length > 0 ? (
          <View style={styles.pendingWrap}>
            {pending.map((p) => (
              <View key={p.id} style={styles.pendingRow}>
                <ActivityIndicator size="small" color={colors.energy} />
                <Text style={styles.pendingText}>Confirming {p.symbol} · {usd(p.stakeCents)}…</Text>
              </View>
            ))}
          </View>
        ) : null}

        {data === null && !loadFailed ? (
          <ActivityIndicator color={colors.energy} style={{ marginTop: 80 }} />
        ) : loadFailed && data === null ? (
          <View style={styles.centerBlock}>
            <Text style={styles.empty}>Couldn&apos;t load your portfolio.</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={() => void load()}>
              <Text style={styles.retryText}>↻ Retry</Text>
            </TouchableOpacity>
          </View>
        ) : open.length === 0 && closed.length === 0 ? (
          <Text style={[styles.empty, { marginTop: 80 }]}>
            No stocks yet. Swipe right on the Stocks deck to buy your first one.
          </Text>
        ) : (
          <>
            {open.length > 0 ? (
              <View style={styles.openList}>
                {open.map((row) => (
                  <OpenRow
                    key={row.id}
                    row={row}
                    canSell={row.mode === "PAPER" || wallet.available}
                    armedSell={armed === row.id}
                    selling={selling === row.id}
                    onArmSell={() => arm(row.id)}
                    onSell={() => {
                      disarm();
                      void (row.mode === "REAL" ? sellOnChain(row) : sell(row));
                    }}
                  />
                ))}
              </View>
            ) : null}

            {closed.length > 0 ? (
              <View style={styles.closedSection}>
                <TouchableOpacity
                  onPress={() => setClosedOpen((o) => !o)}
                  style={styles.closedToggle}
                  accessibilityRole="button"
                >
                  <Text style={styles.closedToggleText}>Closed · {closed.length}</Text>
                  <Text style={styles.closedChevron}>{closedOpen ? "▴" : "▾"}</Text>
                </TouchableOpacity>
                {closedOpen ? (
                  <View style={styles.closedList}>
                    {closed.map((row) => (
                      <ClosedRow key={row.id} row={row} />
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      <StockConsentSheet
        open={real.consentOpen}
        busy={real.busy}
        sponsored={data?.sponsored ?? false}
        onAccept={() => void real.acceptConsent()}
        onClose={real.closeConsent}
      />
    </>
  );
}

// One total tile: the big number is what the lots are worth now, the line under it is the P&L
// against what they cost.
function TotalTile({ label, totals }: { label: string; totals: { costCents: number; valueCents: number; pnlCents: number } }) {
  const pnl = totals.pnlCents;
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{usd(totals.valueCents)}</Text>
      <Text style={[styles.tilePnl, { color: pnl >= 0 ? colors.yes : colors.no }]}>
        {signed(pnl)}
        <Text style={styles.tileCost}> (cost {usd(totals.costCents)})</Text>
      </Text>
    </View>
  );
}

// "+$1.05" / "−$0.40" (U+2212) — usd() formats the magnitude, the sign is ours.
function signed(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

// Display quantity: raw base units → whole shares, scaled by the Token-2022 UI multiplier when the
// mint carries one (so it matches what the wallet shows). Four decimals is honest precision.
function fmtQty(row: StockPositionRow): string {
  const raw = Number(row.qtyBase) / 10 ** row.decimals;
  const scaled = raw * (row.uiMultiplierMicro ? row.uiMultiplierMicro / 1e6 : 1);
  return `${scaled.toFixed(4)} sh`;
}

function OpenRow({
  row,
  canSell,
  armedSell,
  selling,
  onArmSell,
  onSell,
}: {
  row: StockPositionRow;
  // false on a build with no wallet (Play flavor): an on-chain lot is shown, never sold from here.
  canSell: boolean;
  armedSell: boolean;
  selling: boolean;
  onArmSell: () => void;
  onSell: () => void;
}) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? colors.muted : pnl >= 0 ? colors.yes : colors.no;
  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Logo url={row.logoUrl} symbol={row.symbol} />
        <View style={styles.rowMiddle}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowSymbol}>{row.symbol}</Text>
            <Text style={styles.rowName} numberOfLines={1}>{row.name}</Text>
            {row.mode === "REAL" ? (
              <View style={[styles.pill, styles.pillReal]}>
                <Text style={[styles.pillText, { color: colors.gold }]}>◎ on-chain</Text>
              </View>
            ) : (
              <View style={styles.pill}>
                <Text style={styles.pillText}>PAPER</Text>
              </View>
            )}
            {row.source === "WALLET" ? (
              <View style={[styles.pill, styles.pillReal]}>
                <Text style={[styles.pillText, { color: colors.gold }]}>◎ in wallet</Text>
              </View>
            ) : null}
            {row.source === "HEDGE" ? (
              <View style={styles.pill}>
                <Text style={styles.pillText}>hedge</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.rowMeta}>
            {fmtQty(row)} · {row.source === "WALLET" ? "imported at" : "entry"} {usd(row.entryPriceCents)} → now {row.priceCents == null ? "—" : usd(row.priceCents)}
          </Text>
          <Text style={[styles.rowPnl, { color: pnlColor }]}>
            {pnl == null ? "—" : signed(pnl)}
            {!row.fresh ? <Text style={styles.rowStale}> · cached</Text> : null}
          </Text>
        </View>
      </View>
      <View style={styles.rowActions}>
        {/* Same two-tap for both modes — a REAL sell is a swap back to USDC, which is no more
            undoable than a paper one, so it gets the same "are you sure" gesture and the same look. */}
        {canSell ? (
          <TouchableOpacity
            disabled={selling}
            onPress={armedSell ? onSell : onArmSell}
            style={[
              styles.sellBtn,
              armedSell && styles.sellBtnArmed,
              selling && styles.sellBtnDisabled,
            ]}
          >
            <Text style={[styles.sellText, armedSell && styles.sellTextArmed]}>
              {selling ? "Selling…" : armedSell ? "Sell?" : row.mode === "REAL" ? "◎ Sell on Solana" : "Sell"}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.sellOnWeb}>Sell on the web</Text>
        )}
      </View>
    </View>
  );
}

function ClosedRow({ row }: { row: StockPositionRow }) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? colors.muted : pnl >= 0 ? colors.yes : colors.no;
  return (
    <View style={styles.closedRow}>
      <Logo url={row.logoUrl} symbol={row.symbol} />
      <View style={styles.rowMiddle}>
        <Text style={styles.rowSymbol}>{row.symbol}</Text>
        <Text style={styles.rowMeta}>
          {row.closeReason === "wallet" ? "moved in wallet" : "sold"}
          {row.closedAt ? ` · ${new Date(row.closedAt).toLocaleDateString()}` : ""}
          {row.proceedsCents != null ? ` · ${usd(row.proceedsCents)}` : ""}
        </Text>
      </View>
      {pnl != null ? (
        <Text style={[styles.closedPnl, { color: pnlColor }]}>{signed(pnl)}</Text>
      ) : null}
    </View>
  );
}

// 36px round logo with an initials fallback — the same shape every row in the app uses.
function Logo({ url, symbol }: { url: string | null; symbol: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <View style={styles.logoFallback}>
        <Text style={styles.logoInitials}>{symbol.slice(0, 3)}</Text>
      </View>
    );
  }
  return <Image source={{ uri: url }} style={styles.logo} onError={() => setBroken(true)} />;
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20 },
  title: { color: colors.text, fontSize: 26, fontWeight: "900", marginTop: 4 },
  subtitle: { color: colors.muted, fontSize: 11, marginTop: 2 },
  tilesRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  tile: {
    flex: 1, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 12, paddingHorizontal: 13,
  },
  tileLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700" },
  tileValue: { color: colors.text, fontSize: 22, fontWeight: "700", marginTop: 4 },
  tilePnl: { fontSize: 11, marginTop: 3 },
  tileCost: { color: colors.muted },
  pendingWrap: { marginTop: 14, gap: 6 },
  pendingRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12,
  },
  pendingText: { color: colors.muted, fontSize: 12 },
  centerBlock: { alignItems: "center", marginTop: 80 },
  empty: { color: colors.muted, fontSize: 13, textAlign: "center", lineHeight: 19, paddingHorizontal: 24 },
  retryBtn: {
    marginTop: 16, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 11, paddingHorizontal: 22,
  },
  retryText: { color: colors.energy, fontWeight: "700", fontSize: 14 },
  openList: { marginTop: 18, gap: 8 },
  row: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 12, paddingHorizontal: 13,
  },
  rowTop: { flexDirection: "row", gap: 11 },
  rowMiddle: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  rowSymbol: { color: colors.text, fontSize: 13, fontWeight: "700" },
  rowName: { color: colors.muted, fontSize: 11, flexShrink: 1 },
  rowMeta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  rowPnl: { fontSize: 11, marginTop: 2 },
  rowStale: { color: colors.muted },
  rowActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 10 },
  sellBtn: {
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: colors.line, backgroundColor: "transparent",
  },
  sellBtnArmed: { backgroundColor: colors.gold, borderColor: colors.gold },
  sellBtnDisabled: { opacity: 0.5 },
  sellText: { color: colors.muted, fontWeight: "700", fontSize: 11 },
  sellTextArmed: { color: "#1a1205" },
  sellOnWeb: { color: colors.muted, fontSize: 11, paddingVertical: 7 },
  closedSection: { marginTop: 20 },
  closedToggle: { flexDirection: "row", alignItems: "center", gap: 8 },
  closedToggleText: { color: colors.muted, fontSize: 11, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700" },
  closedChevron: { color: colors.muted, fontSize: 10 },
  closedList: { marginTop: 10, gap: 8 },
  closedRow: {
    flexDirection: "row", alignItems: "center", gap: 11,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 10, paddingHorizontal: 13,
  },
  closedPnl: { fontSize: 13, fontWeight: "700" },
  pill: {
    paddingVertical: 2, paddingHorizontal: 7, borderRadius: 20,
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  pillReal: { backgroundColor: withAlpha(colors.gold, "24"), borderColor: withAlpha(colors.gold, "66") },
  pillText: { color: colors.muted, fontSize: 10, fontWeight: "700" },
  logo: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.panel2, flexShrink: 0 },
  logoFallback: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.panel2,
    borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  logoInitials: { color: colors.muted, fontSize: 12, fontWeight: "700" },
});
