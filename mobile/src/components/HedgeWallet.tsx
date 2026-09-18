// S1 wallet components — the native port of the wallet half of the web HedgeScreen: the no-wallet
// intro, the paste-address form (a LIGHT base58 pre-check only — the server does the real
// validation), and the exposure panel (per-major notional, SPL long-tail row, staleness stamp,
// refresh / different-wallet). Every number comes from POST /api/hedge/wallet verbatim.
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { HedgeWalletResponse } from "@contract/api-types";
import { colors } from "../theme";
import { usd } from "../format";

export type LinkError = "invalid" | "unavailable" | "generic";

// Light client-side sanity check ONLY — the server does the real validation (isAddress). Base58
// alphabet (no 0/O/I/l), 32–44 chars covers a 32-byte Solana address.
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const LINK_ERROR_COPY: Record<LinkError, string> = {
  invalid: "That doesn't look like a Solana address — check for typos and paste it again.",
  unavailable:
    "Balances/prices are unreachable right now (upstream outage). The address is saved — hit retry in a moment to read its exposure.",
  generic: "Something went sideways linking that wallet. Try again.",
};

// No-wallet intro: what this surface does + the paste field (the only way in).
export function WalletIntro({ address, busy, error, onAddress, onSubmit }: {
  address: string;
  busy: boolean;
  error: LinkError | null;
  onAddress: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <View style={styles.introPanel}>
      <Text style={styles.introTitle}>Hedge what you hold.</Text>
      <Text style={styles.introCopy}>
        Paste a Solana address — read-only, we never ask for keys. We read the bag and offer paper
        hedges against it: 5–10% of a major (SOL / BTC / ETH) against a matching Polymarket market,
        ~3% of the long tail into a SOL short labeled a <Text style={styles.introStrong}>proxy</Text>{" "}
        (basis risk — it tracks SOL, not your exact tokens). Hedges settle as ordinary paper bets;
        sizing is a product rule, not hedge math.
      </Text>
      <View style={{ marginTop: 14 }}>
        <WalletForm address={address} busy={busy} error={error} onAddress={onAddress} onSubmit={onSubmit} />
      </View>
    </View>
  );
}

// The paste-an-address form shared by the intro and the "different wallet" panel. Validation is a
// light client-side pre-check only; the server does the real base58 check.
export function WalletForm({ address, busy, error, onAddress, onSubmit }: {
  address: string;
  busy: boolean;
  error: LinkError | null;
  onAddress: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <View>
      <TextInput
        value={address}
        onChangeText={onAddress}
        onSubmitEditing={() => { if (!busy) onSubmit(); }}
        placeholder="Solana address (base58)"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        editable={!busy}
        accessibilityLabel="Solana address"
        style={styles.input}
      />
      {error && <Text style={styles.errorText}>{LINK_ERROR_COPY[error]}</Text>}
      <TouchableOpacity
        onPress={busy ? undefined : onSubmit}
        disabled={busy}
        style={[styles.linkBtn, busy && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel="Link wallet"
      >
        <Text style={styles.linkBtnText}>{busy ? "Reading wallet…" : "Link wallet"}</Text>
      </TouchableOpacity>
    </View>
  );
}

// The exposure summary returned by POST /api/hedge/wallet, rendered verbatim (server numbers).
export function ExposurePanel({ exposure, nowMs, busy, onRefresh, onToggleForm, formOpen }: {
  exposure: HedgeWalletResponse;
  nowMs: number;
  busy: boolean;
  onRefresh: () => void;
  onToggleForm: () => void;
  formOpen: boolean;
}) {
  return (
    <View style={styles.panel}>
      <View style={styles.panelTopRow}>
        <Text style={styles.panelLabel}>Your wallet</Text>
        <Text style={styles.panelAddr}>{shortAddr(exposure.address)}</Text>
        <Text style={styles.panelStamp}>updated {ago(exposure.snapshotFetchedAt, nowMs)}</Text>
      </View>
      <Text style={styles.totalValue}>{usd(exposure.totalNotionalCents)}</Text>
      <Text style={styles.totalLabel}>current exposure</Text>

      {exposure.majors.length > 0 && (
        <View style={styles.assetList}>
          {exposure.majors.map((a) => (
            <View key={a.asset} style={styles.assetRow}>
              <Text style={styles.assetName}>{a.asset}</Text>
              <Text style={styles.assetAmount}>{fmtAmount(a.amount)}</Text>
              <Text style={styles.assetNotional}>{usd(a.notionalCents)}</Text>
            </View>
          ))}
          {exposure.splAggregateCents > 0 && (
            <View style={styles.assetRow}>
              <Text style={[styles.assetName, { color: colors.muted }]}>SPL</Text>
              <Text style={styles.assetTail}>long tail</Text>
              <Text style={styles.assetNotional}>{usd(exposure.splAggregateCents)}</Text>
            </View>
          )}
        </View>
      )}
      {exposure.totalNotionalCents === 0 && (
        <Text style={styles.emptyNote}>
          Nothing priced in this wallet yet — hedges show up once there&apos;s exposure to cover.
        </Text>
      )}

      <View style={styles.panelBtns}>
        <GhostButton onPress={onRefresh} disabled={busy}>{busy ? "Reading…" : "↻ Refresh"}</GhostButton>
        <GhostButton onPress={onToggleForm}>{formOpen ? "Cancel" : "Different wallet"}</GhostButton>
        <Text style={styles.readOnlyNote}>Read-only — never your keys</Text>
      </View>
    </View>
  );
}

function GhostButton({ onPress, disabled, children }: {
  onPress: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TouchableOpacity
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={[styles.ghostBtn, disabled && { opacity: 0.6 }]}
      accessibilityRole="button"
    >
      <Text style={styles.ghostBtnText}>{children}</Text>
    </TouchableOpacity>
  );
}

function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

// UI token amount arrives as a decimal STRING (no float drift on the wire) — trim for display only.
function fmtAmount(a: string): string {
  const n = Number(a);
  if (!Number.isFinite(n)) return a;
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function ago(iso: string, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const styles = StyleSheet.create({
  introPanel: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 18, paddingVertical: 18, paddingHorizontal: 16, marginTop: 10,
  },
  introTitle: { color: colors.text, fontSize: 24, lineHeight: 26, fontWeight: "900" },
  introCopy: { color: colors.muted, fontSize: 12, lineHeight: 19, marginTop: 8 },
  introStrong: { color: colors.text, fontWeight: "700" },
  input: {
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 14, color: colors.text, fontFamily: "monospace", fontSize: 12,
  },
  errorText: { fontSize: 11, color: colors.no, marginTop: 6, lineHeight: 16 },
  linkBtn: {
    marginTop: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, alignItems: "center",
    borderWidth: 1, borderColor: "rgba(255,61,205,0.5)", backgroundColor: "rgba(255,61,205,0.16)",
  },
  linkBtnText: { color: colors.energy, fontFamily: "monospace", fontWeight: "700", fontSize: 14 },
  panel: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 18, paddingVertical: 14, paddingHorizontal: 16, marginTop: 10,
  },
  panelTopRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  panelLabel: { fontSize: 10, letterSpacing: 1.4, color: colors.muted, textTransform: "uppercase" },
  panelAddr: { fontFamily: "monospace", fontSize: 11, color: colors.text },
  panelStamp: { marginLeft: "auto", fontSize: 10, color: colors.muted },
  totalValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 30, color: colors.text, lineHeight: 34, marginTop: 8 },
  totalLabel: { fontSize: 10, letterSpacing: 1.2, color: colors.muted, textTransform: "uppercase", marginTop: 2 },
  assetList: { marginTop: 12, gap: 6 },
  assetRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  assetName: { fontWeight: "700", color: colors.text, width: 44, fontSize: 12 },
  assetAmount: { fontFamily: "monospace", color: colors.muted, fontSize: 12 },
  assetTail: { color: colors.muted, fontSize: 12 },
  assetNotional: { marginLeft: "auto", fontFamily: "monospace", fontWeight: "700", color: colors.text, fontSize: 12 },
  emptyNote: { fontSize: 11, color: colors.muted, marginTop: 10, lineHeight: 16 },
  panelBtns: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 },
  ghostBtn: {
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 12,
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  ghostBtnText: { fontSize: 11, fontWeight: "700", color: colors.muted },
  readOnlyNote: { marginLeft: "auto", fontSize: 10, color: colors.muted },
});
