// Top-up bottom sheet — native port of the money half of src/app/screens/BalanceSheet.tsx.
// One affordance derived from me.topup (free once / 1 artifact / locked-with-reason). The server
// owns every gate; the client only renders me.topup and POSTs /api/topup.
import { useCallback, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse } from "../../lib/api-types";
import { statusOf, type Api } from "../api";
import { colors } from "../theme";
import { usd } from "../format";

export function TopupSheet({ visible, me, api, onClose, onTopupDone, onToast }: {
  visible: boolean;
  me: MeResponse | null;
  api: Api;
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

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <View style={styles.panel}>
            <Text style={styles.panelLabel}>Cash</Text>
            <Text style={styles.cashValue}>{me ? usd(Math.max(0, me.cashCents)) : "—"}</Text>
            <View style={styles.splitRow}>
              <SplitStat label="In play" value={me ? usd(me.lockedCents) : "—"} />
              <SplitStat label="Total" value={me ? usd(me.balanceCents) : "—"} />
            </View>
            {me && <TopupButton me={me} busy={busy} onTopup={doTopup} />}
          </View>
          <Text style={styles.hint}>Virtual cash, zero risk. A swipe locks one stake until the market resolves.</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SplitStat({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={styles.splitLabel}>{label}</Text>
      <Text style={styles.splitValue}>{value}</Text>
    </View>
  );
}

// One affordance, derived from me.topup. Always visible; disabled when neither path is open.
function TopupButton({ me, busy, onTopup }: { me: MeResponse; busy: boolean; onTopup: (k: "free" | "artifact") => void }) {
  const t = me.topup;
  const grant = usd(t.grantCents);

  // Holds an artifact but Cash is at/above the gate → the top-up is intentionally locked (it bails
  // out a low balance, not a full one). Show it inactive with the $ threshold, not "earn an artifact".
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
    <TouchableOpacity
      onPress={() => kind && onTopup(kind)}
      disabled={disabled}
      style={[styles.topupBtn, primary ? styles.topupPrimary : styles.topupIdle, busy && { opacity: 0.6 }]}
    >
      <Text style={[styles.topupText, { color: primary ? colors.yes : colors.muted }]}>{busy ? "…" : label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(4,4,8,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.bg2, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 18, paddingBottom: 28, paddingTop: 8,
  },
  handle: { width: 42, height: 5, borderRadius: 4, backgroundColor: colors.line, alignSelf: "center", marginBottom: 14 },
  panel: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 16 },
  panelLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase" },
  cashValue: { color: colors.yes, fontSize: 34, fontWeight: "700", fontFamily: "monospace", marginTop: 2 },
  splitRow: { flexDirection: "row", gap: 18, marginTop: 12 },
  splitLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase" },
  splitValue: { color: colors.text, fontSize: 15, fontWeight: "700", fontFamily: "monospace", marginTop: 3 },
  topupBtn: { marginTop: 14, paddingVertical: 12, borderRadius: 14, borderWidth: 1, alignItems: "center" },
  topupPrimary: { backgroundColor: "rgba(182,255,46,0.16)", borderColor: "rgba(182,255,46,0.5)" },
  topupIdle: { backgroundColor: colors.panel2, borderColor: colors.line },
  topupText: { fontWeight: "700", fontSize: 14, fontFamily: "monospace" },
  hint: { color: colors.muted, fontSize: 11, textAlign: "center", marginTop: 14 },
});
