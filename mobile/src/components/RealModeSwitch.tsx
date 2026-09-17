// RealModeSwitch (native) — the account's ONE Paper/Real switch, with the consent notice in front of it.
// The phone's counterpart of the web's RealModeCard, reduced to what the phone can do: the switch flips
// me.real.mode (which decides whose money a stock swipe spends) and records consent to the current terms.
// The Polymarket deposit-wallet provisioning the web card carries is NOT here — predictions stay paper on
// the phone. The row is hidden entirely on a build with no wallet (the Play flavor).
import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse } from "@contract/api-types";
import { type Api, statusOf } from "../api";
import { colors } from "../theme";
import * as wallet from "../platform/wallet.flavor";
import { RealModeSheet } from "./RealModeSheet";

export function RealModeSwitch({ me, api, onRefreshMe, onToast }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // No wallet in this build (Play flavor) → no real money, no switch. No account yet → nothing to
  // switch. Both are silent: the row simply isn't there.
  if (!wallet.available || !me) return null;

  const isReal = me.real.mode === "REAL";

  // The server's error code, when the failure carried one. Same convention as the web client.
  const codeOf = (e: unknown): string | undefined =>
    (e as { body?: { error?: string } }).body?.error;

  // POST /api/real/mode { real } — the one call both directions make. Returns true on success.
  const postMode = async (real: boolean): Promise<boolean> => {
    try {
      await api("/api/real/mode", { method: "POST", body: JSON.stringify({ real }) });
      return true;
    } catch (e) {
      const status = statusOf(e);
      const code = codeOf(e);
      if (status === 403 && code === "real_disabled") {
        onToast("Real money isn't enabled for this account yet");
      } else if (status === 403 && code === "consent_required") {
        setSheetOpen(true);
      } else if (status === 409 && code === "terms_version_mismatch") {
        onToast("The terms changed — read them again");
        await onRefreshMe();
        setSheetOpen(true);
      } else if (status === 503) {
        onToast("Sign-in service is busy — try again");
      } else {
        onToast("Couldn't switch mode — try again");
      }
      return false;
    }
  };

  const goReal = async () => {
    if (busy) return;
    // Consent is stale (or never given) → read the terms first; the sheet's accept does the rest.
    if (me.real.consentVersion !== me.real.termsVersion) {
      setSheetOpen(true);
      return;
    }
    setBusy(true);
    try {
      if (await postMode(true)) {
        await onRefreshMe();
        onToast("Real money is on");
      }
    } finally {
      setBusy(false);
    }
  };

  const goPaper = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Leaving real mode is never gated — no consent, no eligibility check.
      try {
        await api("/api/real/mode", { method: "POST", body: JSON.stringify({ real: false }) });
        await onRefreshMe();
        onToast("Back to play money");
      } catch {
        onToast("Couldn't switch mode — try again");
      }
    } finally {
      setBusy(false);
    }
  };

  // The sheet's accept: record consent at the CURRENT terms version, then flip the mode. Both must
  // land before the sheet closes; a failure leaves it open so the user can retry deliberately.
  const accept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/real/consent", {
        method: "POST",
        body: JSON.stringify({ accept: true, version: me.real.termsVersion }),
      });
      await api("/api/real/mode", { method: "POST", body: JSON.stringify({ real: true }) });
      setSheetOpen(false);
      await onRefreshMe();
      onToast("Real money is on");
    } catch (e) {
      const status = statusOf(e);
      const code = codeOf(e);
      if (status === 403 && code === "real_disabled") {
        onToast("Real money isn't enabled for this account yet");
      } else if (status === 409 && code === "terms_version_mismatch") {
        onToast("The terms changed — read them again");
        await onRefreshMe();
      } else if (status === 503) {
        onToast("Sign-in service is busy — try again");
      } else {
        onToast("Couldn't switch mode — try again");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={styles.sectionLabel}>Mode</Text>
      <View style={styles.row}>
        <View style={styles.seg}>
          <TouchableOpacity
            style={[styles.segBtn, !isReal && styles.segBtnOn]}
            onPress={() => void goPaper()}
            disabled={busy || !isReal}
          >
            <Text style={[styles.segText, !isReal && styles.segTextOn]}>Play money</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segBtn, isReal && styles.segBtnOn]}
            onPress={() => void goReal()}
            disabled={busy || isReal}
          >
            <Text style={[styles.segText, isReal && styles.segTextOn]}>Real money</Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={styles.hint}>
        Real money buys tokenized stocks with USDC from your connected wallet. Predictions stay play money on the phone.
      </Text>

      <RealModeSheet
        open={sheetOpen}
        busy={busy}
        onAccept={() => void accept()}
        onClose={() => setSheetOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase",
    fontWeight: "700", marginTop: 22,
  },
  row: {
    marginTop: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, padding: 6,
  },
  seg: { flexDirection: "row", gap: 6 },
  segBtn: {
    flex: 1, borderRadius: 10, paddingVertical: 11, alignItems: "center",
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  segBtnOn: { backgroundColor: colors.energy, borderColor: colors.energy },
  segText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  segTextOn: { color: "#fff" },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 8 },
});
