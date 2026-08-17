"use client";

// Real-money "top up": there is no button that grants funds, because nothing here can. The user
// sends USDC to an address of their own and the chain does the rest, so this panel's whole job is to
// show that address correctly and say what happens next.
//
// It replaces the paper Top-Up affordance in real mode rather than sitting beside it — a screen that
// offers "free top-up" next to "send real USDC" invites exactly the wrong tap.
import { useCallback, useEffect, useState } from "react";
import type { Me } from "../ui";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

const MUTED = { fontSize: 12, color: "var(--muted)" } as const;

export function RealDepositPanel({ me, api, pusdMicro, onToast }: {
  me: Me | null;
  api: Api;
  pusdMicro: string | null;
  onToast: (m: string) => void;
}) {
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [minUsd, setMinUsd] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const wallet = me?.real.depositWallet ?? null;

  const load = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    setFailed(false);
    try {
      // POST, not GET: the route only exports POST (it calls the bridge and caches per wallet), so
      // the default GET came back 405 and rendered as "deposit addresses are unavailable" — an
      // outage message for what was really a client-side method mismatch.
      const r = (await api("/api/real/deposit-address", { method: "POST" })) as {
        minUsd?: number;
        addresses?: Record<string, unknown>;
      };
      const flat: Record<string, string> = {};
      for (const [chain, v] of Object.entries(r.addresses ?? {})) {
        if (typeof v === "string") flat[chain] = v;
      }
      setAddresses(flat);
      setMinUsd(typeof r.minUsd === "number" ? r.minUsd : null);
    } catch {
      // The bridge mints these; when it is unreachable there is no address to show, and inventing a
      // fallback would be an invitation to send funds nowhere.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api, wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onToast("Address copied");
    } catch {
      onToast("Couldn't copy — select it manually");
    }
  };

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "16px 18px", marginBottom: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase" }}>
        Real balance
      </div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 34, color: "var(--gold)", lineHeight: 1.05 }}>
        {pusdMicro == null ? "—" : `$${(Number(pusdMicro) / 1e6).toFixed(2)}`}
      </div>
      <div style={{ ...MUTED, marginTop: 4 }}>Spendable now. Deposits appear here once they confirm on chain.</div>

      {!wallet ? (
        <div style={{ ...MUTED, marginTop: 14 }}>
          Finish the one-time trading-wallet setup in your profile before depositing.
        </div>
      ) : failed ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: "var(--no)" }}>Deposit addresses are unavailable right now.</div>
          <button
            type="button"
            onClick={load}
            style={{ margin: "8px 0 0", font: "inherit", padding: "8px 14px", borderRadius: 10, background: "var(--panel2)", border: "1px solid var(--line)", color: "var(--text)", fontSize: 12, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      ) : loading && Object.keys(addresses).length === 0 ? (
        <div style={{ ...MUTED, marginTop: 14 }}>Loading deposit addresses…</div>
      ) : (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase" }}>
            Send USDC to
          </div>
          {/* One address PER CHAIN, and the chain label is not decoration: sending on the wrong
              network is the mistake in this flow that nobody can undo. */}
          {Object.entries(addresses).map(([chain, addr]) => (
            <button
              key={chain}
              type="button"
              onClick={() => copy(addr)}
              style={{ margin: "8px 0 0", font: "inherit", width: "100%", textAlign: "left", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 12px", cursor: "pointer", color: "var(--text)" }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--muted)" }}>
                {chain} · tap to copy
              </div>
              <div style={{ fontSize: 12, fontFamily: "monospace", wordBreak: "break-all", marginTop: 3 }}>{addr}</div>
            </button>
          ))}
          <div style={{ ...MUTED, marginTop: 10, lineHeight: 1.45 }}>
            Send only USDC, and only on the network shown above.
            {minUsd != null ? ` Minimum $${minUsd}.` : ""} Funds arrive after the network confirms —
            usually a minute or two.
          </div>
        </div>
      )}
    </div>
  );
}
