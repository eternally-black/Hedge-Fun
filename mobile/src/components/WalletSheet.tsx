// WalletSheet (native) — port of the wallet half of src/app/screens/BalanceSheet.tsx: the ONE money
// sheet, opened from the HUD balance chip on every screen. One pocket per kind of money, named by
// purpose (Paper, the play balance; Real · Stocks, the connected Solana wallet; Real · Predictions,
// the Polymarket balance). The history tabs arrive in a later change; the Results screen covers them.
import { useCallback, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { MeResponse } from "@contract/api-types";
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
          <ScrollView showsVerticalScrollIndicator={false}>
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
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
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
  const copy = async () => {
    if (!address) return;
    try {
      await Clipboard.setStringAsync(address);
      onToast("Address copied");
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
              <Text style={[pocketStyles.actionText, pocketStyles.goldText]}>Copy address</Text>
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
  handle: { width: 42, height: 5, borderRadius: 4, backgroundColor: colors.line, alignSelf: "center", marginBottom: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  title: { color: colors.text, fontSize: 26, fontWeight: "900", flex: 1 },
  closeBtn: {
    width: 30, height: 30, borderRadius: 999, backgroundColor: colors.panel,
    borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center",
  },
  closeBtnText: { color: colors.muted, fontSize: 15 },
  address: { marginTop: 10, fontFamily: "monospace", fontSize: 11, color: colors.text, lineHeight: 16 },
});
