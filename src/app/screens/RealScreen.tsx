"use client";

// The real-money console: provision the deposit wallet, fund it, run wrap/approvals, recover funds.
// Alpha's only real-money surface — the server allowlist decides who sees anything work here.
import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { provisionReal, runRealWorkflow, type RealCtx, type WorkflowKind } from "@/lib/real-client";
import { RealOrderCard } from "./RealOrderCard";
import { RealWithdrawCard } from "./RealWithdrawCard";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

type Status = {
  eligible: boolean;
  consented: boolean;
  embeddedWalletAddress: string | null;
  depositWalletAddress: string | null;
};
type Attempt = {
  id: string;
  state: string;
  declaredAt: string;
  fundedAt: string | null;
  usdceDeltaMicro: string;
  pusdDeltaMicro: string;
};
type WorkflowRow = { kind: string; state: string; stepIndex: number; error: string | null };

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
const GHOST = { ...BTN, background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--line)" } as const;
const SMALL = { fontSize: 12, padding: "6px 12px" } as const;
const OFF = { opacity: 0.5, cursor: "default" } as const;

// Typed errors from useApi carry the route's own error code; that code is the user-facing truth
// (`nothing_to_redeem` is not a failure), so read it first and only fall back to the HTTP message.
function errText(e: unknown): string {
  const code = (e as { body?: { error?: string } }).body?.error;
  return code || (e instanceof Error ? e.message : String(e));
}
const short = (a: string) => (a.length <= 14 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`);
const usdFromMicro = (micro: string) => `$${(Number(micro) / 1e6).toFixed(2)}`;

export function RealScreen({ api }: { api: Api }) {
  const { wallets } = useWallets();
  const { getAccessToken } = usePrivy();
  // useWallets() is the EVM list (Solana lives in useSolanaWallets), so the embedded EVM wallet is
  // just the Privy-issued entry.
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const embeddedAddress = embedded?.address;

  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState("");
  const [consentBusy, setConsentBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState("");

  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [minUsd, setMinUsd] = useState<number | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [dollars, setDollars] = useState("");
  const [declareBusy, setDeclareBusy] = useState(false);
  const [fundingError, setFundingError] = useState("");
  const [copied, setCopied] = useState("");

  const [runs, setRuns] = useState<WorkflowRow[]>([]);
  const [busyKind, setBusyKind] = useState<WorkflowKind | null>(null);
  const [notes, setNotes] = useState<Partial<Record<WorkflowKind, string>>>({});
  const [runError, setRunError] = useState("");

  const loadStatus = useCallback(async () => {
    setStatusError("");
    try {
      setStatus((await api("/api/real/wallet")) as Status);
    } catch (e) {
      setStatusError(errText(e));
    }
  }, [api]);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(((await api("/api/real/workflow")) as { workflows: WorkflowRow[] }).workflows ?? []);
    } catch (e) {
      setRunError(errText(e));
    }
  }, [api]);

  const loadFunding = useCallback(async () => {
    try {
      setAttempt(((await api("/api/real/funding")) as { attempt: Attempt | null }).attempt);
      setFundingError("");
    } catch (e) {
      setFundingError(errText(e));
    }
  }, [api]);

  const loadDepositAddresses = useCallback(async () => {
    try {
      // POST — the route exports only POST; the default GET 405s. Same bug as RealDepositPanel.
      const res = (await api("/api/real/deposit-address", { method: "POST" })) as {
        minUsd: number;
        addresses: Record<string, unknown>;
      };
      setMinUsd(res.minUsd);
      setAddresses(
        Object.fromEntries(Object.entries(res.addresses).filter((e): e is [string, string] => typeof e[1] === "string")),
      );
    } catch (e) {
      setFundingError(errText(e));
    }
  }, [api]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const consented = status?.consented ?? false;
  const provisioned = !!status?.depositWalletAddress;

  useEffect(() => {
    if (!consented) return;
    void loadRuns();
    if (!provisioned) return; // funding + bridge reads 409 without a deposit wallet
    let first = true;
    void (async () => {
      await loadDepositAddresses();
      await loadFunding();
      first = false;
    })();
    // GET /api/real/funding also RE-ARMS the server-side watcher, so the poll is the client's half
    // of the deposit detection, not just a display refresh. It waits for the first read to settle.
    const id = window.setInterval(() => {
      if (!first) void loadFunding();
    }, 20_000);
    return () => window.clearInterval(id);
  }, [consented, provisioned, loadRuns, loadFunding, loadDepositAddresses]);

  if (!embedded || !embeddedAddress) {
    return (
      <div style={{ padding: "24px 18px", textAlign: "center", ...MUTED }}>
        Embedded wallet is not ready yet — every action here signs with it.
      </div>
    );
  }

  const ctx: RealCtx = {
    wallet: embedded,
    depositWalletAddress: status?.depositWalletAddress ?? null,
    getToken: getAccessToken,
  };

  const setConsent = async (on: boolean) => {
    setConsentBusy(true);
    setStatusError("");
    try {
      await api("/api/real/consent", { method: on ? "POST" : "DELETE", body: on ? "{}" : undefined });
      await loadStatus();
    } catch (e) {
      setStatusError(errText(e));
    } finally {
      setConsentBusy(false);
    }
  };

  const provision = async () => {
    setWalletBusy(true);
    setWalletError("");
    try {
      await provisionReal(api, ctx);
      await loadStatus();
    } catch (e) {
      setWalletError(errText(e));
    } finally {
      setWalletBusy(false);
    }
  };

  const declare = async () => {
    const amountCents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setFundingError("Enter a positive dollar amount.");
      return;
    }
    setDeclareBusy(true);
    setFundingError("");
    try {
      await api("/api/real/funding", { method: "POST", body: JSON.stringify({ amountCents }) });
      setDollars("");
      await loadFunding();
    } catch (e) {
      setFundingError(errText(e));
    } finally {
      setDeclareBusy(false);
    }
  };

  const run = async (kind: WorkflowKind) => {
    setBusyKind(kind);
    setRunError("");
    setNotes((n) => ({ ...n, [kind]: "starting" }));
    try {
      const outcome = await runRealWorkflow(api, ctx, kind, (note) => setNotes((n) => ({ ...n, [kind]: note })));
      if (outcome.status === "failed") setRunError(`${kind}: ${outcome.error}`);
      else setNotes((n) => ({ ...n, [kind]: outcome.status === "done" ? "done" : "submitted to the relayer" }));
    } catch (e) {
      const code = errText(e);
      // Two 409s are ordinary outcomes, not failures — showing them as errors would train the owner
      // to ignore the error line.
      if (code === "nothing_to_redeem" || code === "nothing_to_withdraw") {
        setNotes((n) => ({ ...n, [kind]: "nothing to do" }));
      } else if (code === "neg_risk_redeem_manual") {
        setNotes((n) => ({ ...n, [kind]: "neg-risk market — redemption goes through ops manually" }));
      } else {
        setRunError(`${kind}: ${code}`);
      }
    } finally {
      setBusyKind(null);
      await Promise.all([loadRuns(), loadStatus()]);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(""), 1500);
    } catch (e) {
      setFundingError(errText(e));
    }
  };

  const runButton = (kind: WorkflowKind, label: string) => (
    <button
      type="button"
      onClick={() => run(kind)}
      disabled={busyKind !== null}
      style={{ ...GHOST, ...(busyKind !== null ? OFF : {}) }}
    >
      {busyKind === kind ? "…" : label}
    </button>
  );

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "8px 18px 20px" }}>
      <div style={{ fontFamily: "var(--df)", fontSize: 28, marginTop: 6, textAlign: "center" }}>Real money</div>
      <div style={{ ...MUTED, textAlign: "center", marginTop: 2 }}>
        Live funds on Polygon. Separate from the paper balance — nothing here touches it.
      </div>

      <div style={CARD}>
        <div style={LABEL}>Consent</div>
        <div style={{ ...MUTED, marginTop: 4 }}>
          Real mode spends real money: your own wallet, your own signatures, no server-side keys.
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          {consented ? (
            <>
              <span style={{ fontSize: 13 }}>enabled</span>
              <button
                type="button"
                onClick={() => setConsent(false)}
                disabled={consentBusy}
                style={{ ...GHOST, ...SMALL, ...(consentBusy ? OFF : {}) }}
              >
                Disable
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConsent(true)}
              disabled={consentBusy}
              style={{ ...PRIMARY, ...(consentBusy ? OFF : {}) }}
            >
              Enable real money
            </button>
          )}
          {status && !status.eligible ? <span style={MUTED}>not on the alpha allowlist</span> : null}
        </div>
        {statusError ? <div style={ERR}>{statusError}</div> : null}
      </div>

      <div style={CARD}>
        <div style={LABEL}>Deposit wallet</div>
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.8 }}>
          <div>
            <span style={MUTED}>signer </span>
            {status?.embeddedWalletAddress ? short(status.embeddedWalletAddress) : "—"}
          </div>
          <div>
            <span style={MUTED}>deposit </span>
            {status?.depositWalletAddress ? short(status.depositWalletAddress) : "not provisioned"}
          </div>
        </div>
        {consented && !provisioned ? (
          <>
            <div style={{ ...MUTED, marginTop: 10 }}>
              Deploying asks your device to sign — the wallet is yours, the app never holds its key.
            </div>
            <button
              type="button"
              onClick={provision}
              disabled={walletBusy}
              style={{ ...PRIMARY, marginTop: 10, ...(walletBusy ? OFF : {}) }}
            >
              {walletBusy ? "provisioning…" : "Provision wallet"}
            </button>
          </>
        ) : null}
        {walletError ? <div style={ERR}>{walletError}</div> : null}
      </div>

      <div style={CARD}>
        <div style={LABEL}>Funding</div>
        {minUsd !== null ? <div style={{ ...MUTED, marginTop: 4 }}>Minimum deposit ${minUsd}.</div> : null}
        <div style={{ marginTop: 10 }}>
          {Object.keys(addresses).length === 0 ? (
            <div style={MUTED}>{provisioned ? "loading deposit addresses…" : "provision the wallet first"}</div>
          ) : (
            Object.entries(addresses).map(([chain, address]) => (
              <div key={chain} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                <span style={{ ...MUTED, minWidth: 64 }}>{chain}</span>
                <span style={{ fontSize: 13 }}>{short(address)}</span>
                <button type="button" onClick={() => copy(address)} style={{ ...GHOST, ...SMALL }}>
                  {copied === address ? "copied" : "copy"}
                </button>
              </div>
            ))
          )}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            placeholder="0.00"
            style={{
              font: "inherit",
              fontSize: 14,
              width: 110,
              padding: "10px 12px",
              borderRadius: 12,
              color: "var(--text)",
              background: "var(--panel2)",
              border: "1px solid var(--line)",
            }}
          />
          <button
            type="button"
            onClick={declare}
            disabled={declareBusy || !provisioned}
            style={{ ...GHOST, ...(declareBusy || !provisioned ? OFF : {}) }}
          >
            Declare deposit
          </button>
        </div>
        <div style={{ ...MUTED, marginTop: 10 }}>
          {attempt
            ? `${attempt.state} — USDC.e ${usdFromMicro(attempt.usdceDeltaMicro)}, pUSD ${usdFromMicro(attempt.pusdDeltaMicro)}`
            : "no deposit declared yet"}
        </div>
        {fundingError ? <div style={ERR}>{fundingError}</div> : null}
      </div>

      {/* Ordering needs a bound deposit wallet; without one every intent 409s on no_deposit_wallet. */}
      {consented && provisioned ? <RealOrderCard api={api} ctx={ctx} /> : null}

      <div style={CARD}>
        <div style={LABEL}>Trading setup</div>
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          {runButton("WRAP", "Wrap USDC.e → pUSD")}
          {runButton("APPROVALS", "Set approvals")}
        </div>
        <div style={{ marginTop: 8 }}>
          {(["WRAP", "APPROVALS"] as const).map((k) =>
            notes[k] ? (
              <div key={k} style={MUTED}>
                {k}: {notes[k]}
              </div>
            ) : null,
          )}
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={LABEL}>Runs</div>
          {runs.length === 0 ? (
            <div style={{ ...MUTED, marginTop: 6 }}>none yet</div>
          ) : (
            runs.map((r) => (
              <div key={r.kind} style={{ fontSize: 12, marginTop: 4 }}>
                {r.kind} — {r.state} (step {r.stepIndex})
                {r.error ? <span style={{ color: "var(--no)" }}> — {r.error}</span> : null}
              </div>
            ))
          )}
        </div>
        {runError ? <div style={ERR}>{runError}</div> : null}
      </div>

      <div style={{ ...CARD, borderColor: "var(--gold)" }}>
        <div style={LABEL}>Recovery</div>
        <div style={{ ...MUTED, marginTop: 4 }}>The funds-out path: redeem what resolved, then withdraw.</div>
        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          {runButton("REDEEM", "Redeem resolved")}
          {/* WITHDRAW is the collateral return — positions back into pUSD. Getting the money OFF
              Polygon is the bridge card below, and the two are deliberately separate buttons. */}
          {runButton("WITHDRAW", "Collect into pUSD")}
        </div>
        {consented && provisioned ? <RealWithdrawCard api={api} ctx={ctx} /> : null}
        <div style={{ marginTop: 8 }}>
          {(["REDEEM", "WITHDRAW"] as const).map((k) =>
            notes[k] ? (
              <div key={k} style={MUTED}>
                {k}: {notes[k]}
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}
