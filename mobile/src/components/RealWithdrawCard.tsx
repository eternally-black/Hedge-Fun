// RealWithdrawCard (native) — port of src/app/screens/RealWithdrawCard.tsx. The money-out screen.
// The bridge address is SINGLE-PURPOSE — it forwards whatever lands on it to the recipient it was
// created for — so a retry must never mint a second one: the server answers `withdrawal_in_flight`
// and this card keeps pointing at the run that already exists.
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { withdrawViaBridge, type Api, type RealCtx } from "@contract/real-client";
import { usdFromMicro } from "../format";
import { colors } from "../theme";

type BridgeAsset = { chainId: string; chainName: string; symbol: string; tokenAddress: string; minUsd: number };
type WorkflowInfo = { state: string; stepIndex: number; error: string | null };
type Connected = { evm: string | null; solana: string | null };
type WithdrawalInfo = {
  bridgeAddress: string;
  recipient: string;
  chainId: string;
  amountMicro: string;
  status: string | null;
  // Did the bridge answer at all? A null status with statusRead means "nothing has landed yet",
  // which is the normal state for most of a withdrawal's life — not an outage.
  statusRead?: boolean;
  txHash: string | null;
};

const SOLANA = "1151111081099710"; // a string chain id, and far past 2^53 — never parse it as a number

const short = (s: string, max = 22) => (s.length <= max ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);

function errText(e: unknown): string {
  const body = (e as { body?: { error?: string; minUsd?: number } }).body;
  const code = body?.error;
  if (!code) return e instanceof Error ? e.message : String(e);
  if (code === "below_minimum") return `below the bridge's minimum of $${body?.minUsd ?? "?"}`;
  if (code === "insufficient_balance") return "the wallet does not hold that much pUSD";
  if (code === "withdrawal_in_flight") return "a withdrawal is already in flight — this card shows that run";
  return code;
}

function outcomeText(o: { status: string; error?: string }): string {
  if (o.status === "done") return "the bridge has the funds — watch the status below";
  if (o.status === "submitting") return "submitted to the relayer";
  if (o.status === "failed") return `failed: ${o.error ?? "unknown"}`;
  return o.status;
}

export function RealWithdrawCard({ api, ctx }: { api: Api; ctx: RealCtx }) {
  const [assets, setAssets] = useState<BridgeAsset[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowInfo | null>(null);
  const [withdrawal, setWithdrawal] = useState<WithdrawalInfo | null>(null);
  const [chainId, setChainId] = useState(SOLANA);
  const [tokenAddress, setTokenAddress] = useState("");
  const [recipient, setRecipient] = useState("");
  const [dollars, setDollars] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState<Connected>({ evm: null, solana: null });
  // The read-back step: the exact terms are shown, and the run starts on a second, deliberate tap.
  // Any edit below clears it, so a confirmation can never belong to different terms than the ones
  // it was granted for.
  const [confirming, setConfirming] = useState(false);
  // When the read-back was armed. A double-tap puts the second tap on the re-rendered button before
  // a human could possibly have read the terms it just revealed, which turns a two-step confirmation
  // for an irreversible transfer back into one tap. The dwell below makes the second tap a decision.
  const armedAt = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = (await api("/api/real/withdraw")) as {
        workflow: WorkflowInfo | null;
        withdrawal: WithdrawalInfo | null;
        assets?: BridgeAsset[];
        connected?: Connected;
      };
      setWorkflow(res.workflow);
      setWithdrawal(res.withdrawal);
      setAssets(res.assets ?? []);
      setConnected(res.connected ?? { evm: null, solana: null });
    } catch (e) {
      setError(errText(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The relay state, the bridge status and the outgoing tx change over minutes, so while a run is
  // watchable, ask again. ponytail: fixed 10s poll, only while the card is open; backoff if the
  // bridge complains.
  const inFlight = Boolean(withdrawal && !withdrawal.txHash);
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(id);
  }, [inFlight, refresh]);

  const chains = [...new Map(assets.map((a) => [a.chainId, a.chainName])).entries()];
  const tokens = assets.filter((a) => a.chainId === chainId);
  const chosen = tokens.find((t) => t.tokenAddress === tokenAddress) ?? tokens.find((t) => t.symbol === "USDC") ?? tokens[0];

  const connectedAddress = chainId === SOLANA ? connected.solana : connected.evm;
  const noConnectedHint =
    connectedAddress
      ? null
      : chainId === SOLANA
        ? "link a Solana wallet first, or paste an address"
        : "no embedded wallet available";
  // Sending to an address of the wrong chain family is the one mistake in this flow that cannot be
  // undone, so it disables the button instead of merely warning.
  const wrongFamily =
    recipient.trim() !== "" &&
    (chainId === SOLANA
      ? recipient.trim().startsWith("0x")
      : !/^0x[0-9a-fA-F]{40}$/.test(recipient.trim()));

  // First tap validates and asks; the second one spends. One handler, so the checks a user sees
  // before confirming are the same checks that run before the money moves.
  const submit = async () => {
    const dest = recipient.trim();
    if (!chosen || !dest) {
      setError("choose a destination first");
      return;
    }
    const amount = dollars.trim();
    if (amount !== "" && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
      setError("enter a positive amount, or leave it empty to send everything");
      return;
    }
    if (!confirming) {
      setError("");
      setNote("");
      armedAt.current = Date.now();
      setConfirming(true);
      return;
    }
    // Too fast to have read the read-back panel: ignore rather than spend.
    if (Date.now() - armedAt.current < 700) return;
    setConfirming(false);
    setBusy(true);
    setError("");
    setNote("");
    try {
      const outcome = await withdrawViaBridge(
        api,
        ctx,
        {
          chainId,
          tokenAddress: chosen.tokenAddress,
          recipient: dest,
          amountMicro: amount === "" ? undefined : String(Math.round(Number(amount) * 1_000_000)),
        },
        setNote,
      );
      setNote(outcomeText(outcome));
      setDollars("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Withdraw off Polygon</Text>
      <Text style={[styles.muted, styles.introText]}>
        pUSD leaves the wallet to a one-time bridge address and arrives as the token you pick.
        {chosen ? ` Minimum $${chosen.minUsd}.` : ""}
      </Text>

      <View style={styles.pillRow}>
        {chains.length === 0 ? (
          <TouchableOpacity
            onPress={() => { setConfirming(false); setChainId(SOLANA); }}
            style={[styles.pill, chainId === SOLANA && styles.pillOn]}
          >
            <Text style={[styles.pillText, chainId === SOLANA && styles.pillTextOn]}>Solana</Text>
          </TouchableOpacity>
        ) : null}
        {chains.map(([id, name]) => (
          <TouchableOpacity
            key={id}
            onPress={() => { setConfirming(false); setChainId(id); }}
            style={[styles.pill, chainId === id && styles.pillOn]}
          >
            <Text style={[styles.pillText, chainId === id && styles.pillTextOn]}>{name}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.pillRow}>
        {tokens.map((t) => (
          <TouchableOpacity
            key={t.tokenAddress}
            onPress={() => { setConfirming(false); setTokenAddress(t.tokenAddress); }}
            style={[styles.pill, chosen?.tokenAddress === t.tokenAddress && styles.pillOn]}
          >
            <Text style={[styles.pillText, chosen?.tokenAddress === t.tokenAddress && styles.pillTextOn]}>
              {t.symbol}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.row}>
        <TextInput
          value={recipient}
          onChangeText={(v) => { setConfirming(false); setRecipient(v); }}
          // The destination lives on the CHOSEN chain — pasting an EVM address for a Solana
          // withdrawal is the one mistake that cannot be undone.
          placeholder={chainId === SOLANA ? "your Solana address" : "your address on the chosen chain"}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.field, styles.flexField]}
        />
        <TouchableOpacity
          onPress={() => { setConfirming(false); setRecipient(connectedAddress ?? ""); }}
          disabled={!connectedAddress}
          style={[styles.small, !connectedAddress && styles.off]}
        >
          <Text style={styles.smallText}>Use connected</Text>
        </TouchableOpacity>
      </View>
      {noConnectedHint ? <Text style={[styles.muted, styles.hintText]}>{noConnectedHint}</Text> : null}
      {wrongFamily ? (
        <Text style={styles.err}>this address belongs to another chain — sending there is unrecoverable</Text>
      ) : null}

      <View style={styles.amountRow}>
        <TextInput
          value={dollars}
          onChangeText={(v) => { setConfirming(false); setDollars(v); }}
          placeholder="all"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="decimal-pad"
          style={[styles.field, styles.amountField]}
        />
        <TouchableOpacity
          onPress={() => void submit()}
          disabled={busy || wrongFamily}
          style={[styles.primary, (busy || wrongFamily) && styles.off]}
        >
          <Text style={styles.primaryText}>{busy ? "…" : confirming ? "Confirm send" : "Withdraw"}</Text>
        </TouchableOpacity>
        {confirming ? (
          <TouchableOpacity onPress={() => setConfirming(false)} style={styles.small}>
            <Text style={styles.smallText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {confirming ? (
        <View style={styles.section}>
          <Text style={styles.label}>Check before sending</Text>
          {/* The address is rendered IN FULL and wrapped — a truncated one hides exactly the middle
              characters an address-swapping clipboard attack changes. This is irreversible. */}
          <Text selectable style={styles.confirmAddress}>{recipient.trim()}</Text>
          <Text style={[styles.muted, styles.confirmLine]}>
            {dollars.trim() === "" ? "entire pUSD balance" : `$${dollars.trim()}`} as {chosen?.symbol ?? "?"} on{" "}
            {chosen?.chainName ?? "?"}
          </Text>
          {/* The bridge charges and publishes no rate anywhere in its API, so this states the one
              measured data point instead of quoting a number nobody guaranteed (see the web card).
              ponytail: replace with the delivered amount once /status is known to carry it. */}
          <Text style={styles.muted}>
            the bridge takes a fee and does not publish a rate — a $2.00 withdrawal delivered
            1.99386 USDC, so expect slightly less than this to arrive
          </Text>
          <Text style={styles.muted}>this cannot be undone or recalled</Text>
        </View>
      ) : null}

      {note ? <Text style={styles.note}>{note}</Text> : null}
      {error ? <Text style={styles.err}>{error}</Text> : null}

      {withdrawal ? (
        <View style={styles.section}>
          {/* The heading comes off the SAME predicate that drives the poll, so the label and the
              polling can never disagree about whether anything is still moving. "Sent", not
              "delivered": a txHash means the bridge broadcast the forwarding transaction, which is the
              last thing observable from here. */}
          <Text style={styles.label}>
            {workflow?.state === "FAILED" ? "Last withdrawal — failed" : inFlight ? "In flight" : "Sent"}
          </Text>
          <Text style={styles.amountLine}>
            {usdFromMicro(withdrawal.amountMicro)} → {short(withdrawal.recipient)}
          </Text>
          <Text style={styles.muted}>bridge {short(withdrawal.bridgeAddress)}</Text>
          <Text style={styles.muted}>
            relay {workflow?.state.toLowerCase() ?? "unknown"}
            {withdrawal.status
              ? ` · bridge ${withdrawal.status.toLowerCase()}`
              : withdrawal.statusRead
                ? " · nothing at the bridge yet"
                : " · bridge status unavailable"}
          </Text>
          {withdrawal.txHash ? <Text style={styles.muted}>tx {short(withdrawal.txHash)}</Text> : null}
          {workflow?.error ? <Text style={styles.err}>{workflow.error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 18,
    paddingVertical: 16, paddingHorizontal: 18, marginBottom: 14,
  },
  label: { fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", color: colors.muted, fontWeight: "700" },
  muted: { fontSize: 12, color: colors.muted },
  err: { marginTop: 10, fontSize: 12, color: colors.no },
  introText: { marginTop: 4 },
  hintText: { marginTop: 6 },
  pillRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 },
  pill: {
    flexGrow: 1, minWidth: 110, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
  },
  pillOn: { backgroundColor: colors.energy, borderColor: colors.energy },
  pillText: { color: colors.text, fontSize: 14 },
  pillTextOn: { color: "#ffffff", fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, marginTop: 10, alignItems: "center" },
  amountRow: { flexDirection: "row", gap: 10, marginTop: 10, alignItems: "center", flexWrap: "wrap" },
  field: {
    fontSize: 14, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, color: colors.text,
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  flexField: { flex: 1, minWidth: 0 },
  amountField: { width: 110 },
  small: {
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.panel2,
    borderWidth: 1, borderColor: colors.line,
  },
  smallText: { color: colors.text, fontSize: 12 },
  primary: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.gold },
  primaryText: { color: "#1a1205", fontSize: 14, fontWeight: "700" },
  off: { opacity: 0.5 },
  section: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10 },
  confirmAddress: { fontSize: 13, marginTop: 4, fontFamily: "monospace", color: colors.text },
  confirmLine: { marginTop: 4 },
  note: { marginTop: 10, fontSize: 12, color: colors.text },
  amountLine: { fontSize: 13, marginTop: 4, color: colors.text },
});
