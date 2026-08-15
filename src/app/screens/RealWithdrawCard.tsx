"use client";

// The money-out screen. The bridge address is SINGLE-PURPOSE — it forwards whatever lands on it to
// the recipient it was created for — so a retry must never mint a second one: the server answers
// `withdrawal_in_flight` and this card keeps pointing at the run that already exists.
import { useCallback, useEffect, useState } from "react";
import { withdrawViaBridge, type Api, type RealCtx } from "@/lib/real-client";

type BridgeAsset = { chainId: string; chainName: string; symbol: string; tokenAddress: string; minUsd: number };
type WorkflowInfo = { state: string; stepIndex: number; error: string | null };
type Connected = { evm: string | null; solana: string | null };
type WithdrawalInfo = {
  bridgeAddress: string;
  recipient: string;
  chainId: string;
  amountMicro: string;
  status: string | null;
  txHash: string | null;
};

const SOLANA = "1151111081099710"; // a string chain id, and far past 2^53 — never parse it as a number

const CARD = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 18,
  padding: 16,
  marginTop: 14,
  textAlign: "left",
} as const;
const LABEL = {
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontWeight: 700,
} as const;
const MUTED = { fontSize: 12, color: "var(--muted)" } as const;
const ERR = { marginTop: 10, fontSize: 12, color: "var(--no)" } as const;
const BTN = { font: "inherit", fontSize: 14, padding: "10px 16px", borderRadius: 12, cursor: "pointer" } as const;
const PRIMARY = { ...BTN, background: "var(--gold)", color: "#1a1205", border: "none" } as const;
const SMALL = { ...BTN, fontSize: 12, padding: "8px 10px", background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--line)" } as const;
const OFF = { opacity: 0.5, cursor: "default" } as const;
const FIELD = {
  font: "inherit",
  fontSize: 14,
  padding: "10px 12px",
  borderRadius: 12,
  color: "var(--text)",
  background: "var(--panel2)",
  border: "1px solid var(--line)",
} as const;

const short = (s: string, max = 22) => (s.length <= max ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);
const usd = (micro: string) => `$${(Number(micro) / 1e6).toFixed(2)}`;

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
    <div style={CARD}>
      <div style={LABEL}>Withdraw off Polygon</div>
      <div style={{ ...MUTED, marginTop: 4 }}>
        pUSD leaves the wallet to a one-time bridge address and arrives as the token you pick.
        {chosen ? ` Minimum $${chosen.minUsd}.` : ""}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
        <select value={chainId} onChange={(e) => setChainId(e.target.value)} style={{ ...FIELD, flex: 1, minWidth: 130 }}>
          {chains.length === 0 ? <option value={SOLANA}>Solana</option> : null}
          {chains.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          value={chosen?.tokenAddress ?? ""}
          onChange={(e) => setTokenAddress(e.target.value)}
          style={{ ...FIELD, flex: 1, minWidth: 110 }}
        >
          {tokens.map((t) => (
            <option key={t.tokenAddress} value={t.tokenAddress}>
              {t.symbol}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          // The destination lives on the CHOSEN chain — pasting an EVM address for a Solana
          // withdrawal is the one mistake that cannot be undone.
          placeholder={chainId === SOLANA ? "your Solana address" : "your address on the chosen chain"}
          style={{ ...FIELD, flex: 1, minWidth: 0, boxSizing: "border-box" }}
        />
        <button
          type="button"
          onClick={() => setRecipient(connectedAddress ?? "")}
          disabled={!connectedAddress}
          style={{ ...SMALL, ...(connectedAddress ? {} : OFF) }}
        >
          Use connected
        </button>
      </div>
      {noConnectedHint ? <div style={{ ...MUTED, marginTop: 6 }}>{noConnectedHint}</div> : null}
      {wrongFamily ? (
        <div style={ERR}>this address belongs to another chain — sending there is unrecoverable</div>
      ) : null}

      <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          inputMode="decimal"
          value={dollars}
          onChange={(e) => setDollars(e.target.value)}
          placeholder="all"
          style={{ ...FIELD, width: 110 }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || wrongFamily}
          style={{ ...PRIMARY, ...(busy || wrongFamily ? OFF : {}) }}
        >
          {busy ? "…" : "Withdraw"}
        </button>
      </div>

      {note ? <div style={{ marginTop: 10, fontSize: 12 }}>{note}</div> : null}
      {error ? <div style={ERR}>{error}</div> : null}

      {withdrawal ? (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div style={LABEL}>In flight</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {usd(withdrawal.amountMicro)} → {short(withdrawal.recipient)}
          </div>
          <div style={MUTED}>bridge {short(withdrawal.bridgeAddress)}</div>
          <div style={MUTED}>
            relay {workflow?.state.toLowerCase() ?? "unknown"}
            {withdrawal.status ? ` · bridge ${withdrawal.status.toLowerCase()}` : " · bridge status unavailable"}
          </div>
          {withdrawal.txHash ? <div style={MUTED}>tx {short(withdrawal.txHash)}</div> : null}
          {workflow?.error ? <div style={ERR}>{workflow.error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
