// RealPredictionsSetup (native) — the phone's port of the web RealModeCard's setup steps: create the
// signing key, provision the Polymarket deposit wallet, activate trading. Orders sign with the Privy
// embedded EVM wallet through the shared client (@contract/real-client), the same wallet the web
// uses. Funding (deposit, withdraw, convert) lives in the shared RealDepositPanel — the same pocket
// the Wallet sheet shows.
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse } from "@contract/api-types";
import { type Api } from "../api";
import { colors } from "../theme";
import * as wallet from "../platform/wallet.flavor";
import { useRealCtx } from "../useRealCtx";
import { provisionReal, runRealWorkflow } from "@contract/real-client";
import { failText } from "@contract/client-report";
import { RealDepositPanel } from "./RealDepositPanel";

export function RealPredictionsSetup({ me, api, onRefreshMe, onToast }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
}) {
  const { ctx, hasEvmWallet, createEvmWallet } = useRealCtx(me);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The wallet read: pUSD balance and whether the exchange permissions are granted. `tradingReady`
  // null means "not asked, or the chain could not be read" — never a blocker, because an RPC hiccup
  // must not accuse a perfectly good wallet. These hooks sit ABOVE the early return below and read
  // `me` defensively for that reason: hook order cannot depend on a conditional return.
  const [info, setInfo] = useState<{ pusdMicro: string | null; tradingReady: boolean | null } | null>(null);
  // Unmount guard for the activation poll: a user who navigates away mid-poll must not get setState
  // calls on a dead component for the next 30s.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const realOn = me?.real?.mode === "REAL";
  const depositWallet = me?.real?.depositWallet ?? null;

  // Returns the fresh verdict as well as storing it: the activation poll must test THIS read, not
  // the state of the render it started in.
  const readWallet = useCallback(async (force?: boolean): Promise<boolean | null> => {
    try {
      // Unforced on mount: the server's verdict is cached, so this costs nothing. Forced right after
      // the activation batch, when the cached "no" is exactly the answer we must not trust.
      const r = (await api(`/api/real/wallet${force ? "?verify=1" : ""}`)) as {
        pusdMicro?: string | null;
        tradingReady?: boolean | null;
      };
      const next = {
        pusdMicro: typeof r.pusdMicro === "string" ? r.pusdMicro : null,
        tradingReady: typeof r.tradingReady === "boolean" ? r.tradingReady : null,
      };
      if (alive.current) setInfo(next);
      return next.tradingReady;
    } catch {
      // A failed read must never accuse a good wallet — it just leaves the balance unknown.
      if (alive.current) setInfo({ pusdMicro: null, tradingReady: null });
      return null;
    }
  }, [api]);

  // One read whenever real mode turns on with a deposit wallet, and again when that wallet changes.
  // The Play build must not touch money routes at all, and this effect runs above the early return.
  useEffect(() => {
    if (!wallet.available || !realOn || !depositWallet) return;
    void readWallet();
  }, [realOn, depositWallet, readWallet]);

  if (!wallet.available || !realOn) return null;

  const createKey = async () => {
    if (busy) return;
    setBusy("key");
    setError(null);
    try {
      await createEvmWallet();
    } catch (e) {
      setError(failText(e, "Couldn't create the key"));
    } finally {
      setBusy(null);
    }
  };

  const setup = async () => {
    if (busy || !ctx) return;
    setBusy("setup");
    setError(null);
    try {
      await provisionReal(api, ctx);
      await onRefreshMe();
    } catch (e) {
      // The stage and the error's own words, not a fixed string: the 2026-09-13 failure was only ever
      // seen as "Setup failed. Try again." in a screenshot, and that names none of the six stages.
      setError(failText(e, "Setup failed"));
    } finally {
      setBusy(null);
    }
  };

  // One batch, one device signature: allowances for both exchanges and both collateral adapters,
  // plus the operator right that lets a won market pay out by itself instead of leaving the money
  // as a position nobody redeems.
  const activate = async () => {
    if (busy || !ctx) return;
    setBusy("activate");
    setError(null);
    try {
      const outcome = await runRealWorkflow(api, ctx, "APPROVALS");
      if (outcome.status === "failed") {
        // Nothing was submitted, so there is nothing to poll for — reporting the failure and
        // then polling for 30s read as a spinner that ignored its own error.
        setError("Couldn't activate trading. Try again.");
        return;
      }
      // The relayer confirms a beat after it accepts the batch, so the first answer is usually
      // still "not granted". Poll briefly rather than leaving a blocker over a wallet that is
      // already good — and bounded, so a batch that never lands ends as a visible blocker rather
      // than a spinner that never stops.
      for (let i = 0; i < 10; i++) {
        if (!alive.current) return;
        if ((await readWallet(true)) === true) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (alive.current) await onRefreshMe();
    } catch (e) {
      setError(failText(e, "Couldn't activate trading"));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // Setup complete: the money UI is the shared panel, not a second copy of it.
  if (hasEvmWallet && depositWallet && info?.tradingReady !== false) {
    return (
      <View>
        <Text style={styles.sectionLabel}>Predictions wallet</Text>
        <RealDepositPanel me={me} api={api} pusdMicro={info?.pusdMicro ?? null} onToast={onToast} label="Real · Predictions" />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sectionLabel}>Predictions wallet</Text>
      <View style={styles.panel}>
        {!hasEvmWallet ? (
          <>
            <Text style={styles.body}>Create the signing key your predictions use. One tap, no seed phrase.</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => void createKey()} disabled={!!busy}>
              <Text style={styles.primaryBtnText}>{busy === "key" ? "Creating…" : "Create signing key"}</Text>
            </TouchableOpacity>
          </>
        ) : !depositWallet ? (
          <>
            <Text style={styles.body}>One-time setup: create your trading wallet before you can place orders.</Text>
            <TouchableOpacity
              style={[styles.primaryBtn, !ctx && styles.btnOff]}
              onPress={() => void setup()}
              disabled={!!busy || !ctx}
            >
              <Text style={styles.primaryBtnText}>
                {!ctx ? "Waiting for wallet…" : busy === "setup" ? "Setting up…" : "Set up trading wallet"}
              </Text>
            </TouchableOpacity>
          </>
        ) : info?.tradingReady === false ? (
          <>
            <Text style={styles.body}>
              Trading isn&apos;t active yet — one signature grants the exchange its permissions.
            </Text>
            <TouchableOpacity
              style={[styles.primaryBtn, !ctx && styles.btnOff]}
              onPress={() => void activate()}
              disabled={!!busy || !ctx}
            >
              <Text style={styles.primaryBtnText}>
                {busy === "activate" ? "Activating…" : "Activate trading"}
              </Text>
            </TouchableOpacity>
          </>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase",
    fontWeight: "700", marginTop: 22,
  },
  panel: {
    marginTop: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 16, padding: 14,
  },
  body: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  primaryBtn: {
    backgroundColor: colors.energy, borderRadius: 12, paddingVertical: 11, alignItems: "center",
    marginTop: 10,
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  btnOff: { opacity: 0.5 },
  error: { color: colors.no, fontSize: 12, marginTop: 8 },
});
