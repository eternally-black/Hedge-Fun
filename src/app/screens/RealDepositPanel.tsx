"use client";

// Real-money "top up": there is no button that grants funds, because nothing here can. The user
// sends a stablecoin from a chain of their choosing and the bridge does the rest, so this panel's
// job is the balance and one way in — the address itself lives behind a network choice in
// DepositSheet, never loose on a screen where it can be mistaken for a general-purpose address.
//
// It replaces the paper Top-Up affordance in real mode rather than sitting beside it — a screen that
// offers "free top-up" next to "send real USDC" invites exactly the wrong tap.
import { useEffect, useState } from "react";
import { type Me, usdFromMicro } from "../ui";
import { useRealCtx } from "../useRealCtx";
import { runRealWorkflow } from "@/lib/real-client";
import { DepositSheet } from "./DepositSheet";
import { RealWithdrawCard } from "./RealWithdrawCard";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

type Attempt = { id: string; state: string; usdceDeltaMicro: string; pusdDeltaMicro: string };

const MUTED = { fontSize: 12, color: "var(--muted)" } as const;
const ACTION = {
  margin: "14px 0 0",
  font: "inherit",
  flex: 1,
  padding: "12px 16px",
  borderRadius: 12,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
} as const;

export function RealDepositPanel({ me, api, pusdMicro, onToast }: {
  me: Me | null;
  api: Api;
  pusdMicro: string | null;
  onToast: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const wallet = me?.real.depositWallet ?? null;
  // Withdrawing signs on the device, so it needs the embedded wallet — the same ctx the profile's
  // mode card uses. It arrives a beat after login, hence the disabled state rather than a button
  // that fails when tapped.
  const { ctx } = useRealCtx(me);

  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapNote, setWrapNote] = useState("");

  // The GET also re-arms the server-side watcher tier, so this poll is the client's half of
  // deposit detection for everyone who never opens the ops console — which is every tester.
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
    const id = window.setInterval(load, 20_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [wallet, api]);

  // A DETECTED attempt is USDC.e sitting in the wallet — real money the CLOB counts as $0 until
  // the wrap converts it. The ops console had the only button; the deposit panel is where the
  // person who actually sent the money is looking.
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
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "16px 18px", marginBottom: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase" }}>
        Real balance
      </div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 34, color: "var(--gold)", lineHeight: 1.05 }}>
        {pusdMicro == null ? "—" : usdFromMicro(pusdMicro)}
      </div>
      <div style={{ ...MUTED, marginTop: 4 }}>Spendable now. Deposits appear here once they confirm on chain.</div>

      {!wallet ? (
        <div style={{ ...MUTED, marginTop: 14 }}>
          Finish the one-time trading-wallet setup in your profile before depositing.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            style={{ ...ACTION, background: "var(--gold)", color: "#1a1205", border: "none" }}
          >
            Deposit
          </button>
          <button
            type="button"
            onClick={() => setWithdrawOpen((v) => !v)}
            disabled={!ctx}
            style={{
              ...ACTION,
              background: "var(--panel2)",
              color: "var(--text)",
              border: "1px solid var(--line)",
              ...(ctx ? {} : { opacity: 0.5, cursor: "default" }),
            }}
          >
            {withdrawOpen ? "Close" : ctx ? "Withdraw" : "Withdraw…"}
          </button>
        </div>
      )}

      {detected ? (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div style={{ ...MUTED, lineHeight: 1.5 }}>
            Your deposit arrived. One signature converts it to pUSD, the balance you trade with.
          </div>
          <button
            type="button"
            onClick={convert}
            disabled={!ctx || wrapBusy}
            style={{
              ...ACTION,
              width: "100%",
              background: "var(--gold)",
              color: "#1a1205",
              border: "none",
              ...(!ctx || wrapBusy ? { opacity: 0.6, cursor: "default" } : {}),
            }}
          >
            {wrapBusy ? wrapNote || "Converting…" : "Make it spendable"}
          </button>
        </div>
      ) : null}

      {open ? <DepositSheet api={api} pusdMicro={pusdMicro} onClose={() => setOpen(false)} onToast={onToast} /> : null}
    </div>

    {/* Below the panel rather than inside it: the card carries its own panel background, and nesting
        one in the other flattens both. Same card the ops console uses — the destination checks and
        the read-back confirmation are exactly where the money leaves. */}
    {withdrawOpen && wallet && ctx ? <RealWithdrawCard api={api} ctx={ctx} /> : null}
    </>
  );
}
