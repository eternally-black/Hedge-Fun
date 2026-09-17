"use client";

import { useCallback, useState } from "react";
import { useLinkAccount } from "@privy-io/react-auth";
import type { HedgeWalletResponse } from "@/lib/api-types";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export type LinkError = "invalid" | "unavailable" | "generic";

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const LINK_ERROR_COPY: Record<LinkError, string> = {
  invalid: "That doesn't look like a Solana address — check for typos and paste it again.",
  unavailable:
    "Balances/prices are unreachable right now (upstream outage). The address is saved — hit retry in a moment to read its exposure.",
  generic: "Something went sideways linking that wallet. Try again.",
};

// ONE wallet-link flow for every surface that offers it (the Hedge tab, the Profile), so the two can
// never drift: POST /api/hedge/wallet — a pasted address is linked READ-ONLY, a wallet connected
// through Privy (Phantom etc.) signs Privy's challenge and is linked VERIFIED — and the exposure
// response goes to the caller, which decides what to redraw. Privy's modal owns the connect UX; we
// only post the address it hands back.
export function useHedgeWalletLink(
  api: Api,
  opts: { onLinked: (res: HedgeWalletResponse) => void | Promise<void>; onToast: (m: string) => void },
) {
  const { onLinked, onToast } = opts;
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LinkError | null>(null);

  // Returns success so a caller without a visible form can toast instead of showing the inline error.
  const link = useCallback(
    async (addr: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = (await api("/api/hedge/wallet", { method: "POST", body: JSON.stringify({ address: addr }) })) as HedgeWalletResponse;
        setAddress("");
        await onLinked(res);
        return true;
      } catch (e) {
        const status = (e as { status?: number }).status;
        setError(status === 400 ? "invalid" : status === 502 ? "unavailable" : "generic");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, onLinked],
  );

  // Light client-side pre-check only; the server does the real base58 check.
  const submit = useCallback(() => {
    const addr = address.trim();
    if (!BASE58_RE.test(addr)) { setError("invalid"); return; }
    void link(addr);
  }, [address, link]);

  const { linkWallet: linkViaPrivy } = useLinkAccount({
    onSuccess: ({ linkedAccount }) => {
      if (linkedAccount?.type === "wallet" && linkedAccount.chainType === "solana") void link(linkedAccount.address);
    },
    onError: (error) => {
      if (error !== "exited_link_flow") onToast("Couldn't connect the wallet — paste the address instead");
    },
  });
  const connect = useCallback(() => {
    if (busy) return;
    linkViaPrivy({ walletChainType: "solana-only", description: "Connect the Solana wallet you hedge with" });
  }, [busy, linkViaPrivy]);

  const clearError = useCallback(() => setError(null), []);

  return { address, setAddress, busy, error, clearError, link, submit, connect };
}

// The paste-an-address form shared by the Hedge intro, the "different wallet" panel and the Profile.
// Validation is a light client-side pre-check only; the server does the real base58 check.
export function WalletForm({
  address,
  busy,
  error,
  onAddress,
  onSubmit,
  onConnect,
}: {
  address: string;
  busy: boolean;
  error: LinkError | null;
  onAddress: (v: string) => void;
  onSubmit: () => void;
  onConnect: () => void; // Privy wallet-connect: the linked wallet is VERIFIED, a paste is read-only
}) {
  return (
    <div>
      <input
        value={address}
        onChange={(e) => onAddress(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !busy) onSubmit(); }}
        placeholder="Solana address (base58)"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Solana address"
        style={{ width: "100%", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 14px", color: "var(--text)", fontFamily: "var(--nf)", fontSize: 12, outline: "none" }}
      />
      {error && (
        <div style={{ fontSize: 11, color: "var(--no)", marginTop: 6, lineHeight: 1.4 }}>{LINK_ERROR_COPY[error]}</div>
      )}
      <button
        type="button"
        onClick={busy ? undefined : onSubmit}
        disabled={busy}
        style={{
          width: "100%", marginTop: 10, padding: "12px 14px", borderRadius: 14, fontFamily: "var(--nf)",
          fontWeight: 700, fontSize: 14, cursor: busy ? "default" : "pointer",
          border: "1px solid color-mix(in srgb,var(--energy) 50%,transparent)",
          background: "color-mix(in srgb,var(--energy) 16%,transparent)",
          color: "var(--energy)", opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Reading wallet…" : "Link wallet"}
      </button>
      <button
        type="button"
        onClick={busy ? undefined : onConnect}
        disabled={busy}
        style={{
          width: "100%", marginTop: 8, padding: "11px 14px", borderRadius: 14, fontFamily: "var(--nf)",
          fontWeight: 700, fontSize: 13, cursor: busy ? "default" : "pointer",
          border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--text)", opacity: busy ? 0.6 : 1,
        }}
      >
        Connect wallet (Phantom)
      </button>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, lineHeight: 1.4 }}>
        A connected wallet is verified and can be offered as a withdrawal destination. A pasted address is read-only.
      </div>
    </div>
  );
}
