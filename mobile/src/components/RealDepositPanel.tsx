// RealDepositPanel (native) — port of src/app/screens/RealDepositPanel.tsx. Real-money "top up":
// there is no button that grants funds, because nothing here can. The user sends a stablecoin from a
// chain of their choosing and the bridge does the rest, so this panel's job is the balance and one
// way in — the address itself lives behind a network choice in DepositSheet, never loose on a screen
// where it can be mistaken for a general-purpose address.
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse } from "@contract/api-types";
import { runRealWorkflow } from "@contract/real-client";
import type { Api } from "../api";
import { usdFromMicro } from "../format";
import { colors } from "../theme";
import { useRealCtx } from "../useRealCtx";
import { DepositSheet } from "./DepositSheet";
import { RealWithdrawCard } from "./RealWithdrawCard";

type Attempt = { id: string; state: string; usdceDeltaMicro: string; pusdDeltaMicro: string };

// The one pocket shape. WalletSheet draws the other pockets with it, so the three read as three kinds
// of money in one wallet, not three widgets — the web shares MUTED/ACTION for the same reason.
export const pocketStyles = StyleSheet.create({
  panel: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 18,
    paddingVertical: 16, paddingHorizontal: 18, marginBottom: 14,
  },
  label: { fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", color: colors.muted, fontWeight: "700" },
  amount: { fontFamily: "monospace", fontWeight: "700", fontSize: 34, lineHeight: 38 },
  note: { fontSize: 12, color: colors.muted, marginTop: 4, lineHeight: 18 },
  actionRow: { flexDirection: "row", gap: 8 },
  action: { flex: 1, marginTop: 14, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, alignItems: "center" },
  actionText: { fontWeight: "700", fontSize: 13 },
  gold: { backgroundColor: colors.gold },
  goldText: { color: "#1a1205" },
  quiet: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line },
  quietText: { color: colors.text },
});

export function RealDepositPanel({ me, api, pusdMicro, onToast, label = "Real balance" }: {
  me: MeResponse | null;
  api: Api;
  pusdMicro: string | null;
  onToast: (m: string) => void;
  // The pocket heading — the wallet sheet names it by purpose ("Real · Predictions").
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const wallet = me?.real.depositWallet ?? null;
  // Withdrawing signs on the device, so it needs the embedded wallet. It arrives a beat after login,
  // hence the disabled state rather than a button that fails when tapped.
  const { ctx } = useRealCtx(me);

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapNote, setWrapNote] = useState("");

  // The GET also re-arms the server-side watcher tier, so this poll is the client's half of deposit
  // detection for everyone who never opens the ops console — which is every user.
  useEffect(() => {
    if (!wallet) return;
    let live = true;
    const load = async () => {
      try {
        const r = (await api("/api/real/funding")) as { attempt: Attempt | null };
        if (live) setAttempt(r.attempt);
      } catch {
        // best-effort status; the balance above stays the source of truth
      }
    };
    void load();
    const id = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [wallet, api]);

  // A DETECTED attempt is USDC.e sitting in the wallet — real money the CLOB counts as $0 until the
  // wrap converts it. This panel is where the person who actually sent the money is looking.
  const detected = attempt?.state === "DETECTED";
  const convert = async () => {
    if (!ctx || wrapBusy) return;
    setWrapBusy(true);
    setWrapNote("starting");
    try {
      const outcome = await runRealWorkflow(api, ctx, "WRAP", setWrapNote);
      if (outcome.status === "done") {
        onToast("Deposit converted — spendable now");
        setAttempt(null);
      } else if (outcome.status === "failed") {
        onToast(`Conversion failed: ${outcome.error ?? "try again"}`);
      } else {
        onToast("Conversion submitted — it lands in a minute or two");
      }
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setWrapBusy(false);
      setWrapNote("");
    }
  };

  return (
    <>
      <View style={pocketStyles.panel}>
        <Text style={pocketStyles.label}>{label}</Text>
        <Text style={[pocketStyles.amount, { color: colors.gold }]}>
          {pusdMicro == null ? "—" : usdFromMicro(pusdMicro)}
        </Text>
        <Text style={pocketStyles.note}>Spendable now. Deposits appear here once they confirm on chain.</Text>

        {!wallet ? (
          <Text style={[pocketStyles.note, { marginTop: 14 }]}>
            Finish the one-time trading-wallet setup in your profile before depositing.
          </Text>
        ) : (
          <View style={pocketStyles.actionRow}>
            <TouchableOpacity onPress={() => setOpen(true)} style={[pocketStyles.action, pocketStyles.gold]}>
              <Text style={[pocketStyles.actionText, pocketStyles.goldText]}>Deposit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setWithdrawOpen((v) => !v)}
              disabled={!ctx}
              style={[pocketStyles.action, pocketStyles.quiet, !ctx && { opacity: 0.5 }]}
            >
              <Text style={[pocketStyles.actionText, pocketStyles.quietText]}>
                {withdrawOpen ? "Close" : ctx ? "Withdraw" : "Withdraw…"}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {detected ? (
          <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line }}>
            <Text style={pocketStyles.note}>
              Your deposit arrived. One signature converts it to pUSD, the balance you trade with.
            </Text>
            <TouchableOpacity
              onPress={() => void convert()}
              disabled={!ctx || wrapBusy}
              style={[pocketStyles.action, pocketStyles.gold, (!ctx || wrapBusy) && { opacity: 0.6 }]}
            >
              <Text style={[pocketStyles.actionText, pocketStyles.goldText]}>
                {wrapBusy ? wrapNote || "Converting…" : "Make it spendable"}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      <DepositSheet visible={open} api={api} pusdMicro={pusdMicro} onClose={() => setOpen(false)} onToast={onToast} />

      {/* Below the panel rather than inside it: the card carries its own panel background, and
          nesting one in the other flattens both. */}
      {withdrawOpen && wallet && ctx ? <RealWithdrawCard api={api} ctx={ctx} /> : null}
    </>
  );
}
