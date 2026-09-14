"use client";

import { useCallback, useRef, useState } from "react";
import { useLinkAccount, useConnectWallet } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets, useSignAndSendTransaction } from "@privy-io/react-auth/solana";
import { STOCK_TERMS_VERSION } from "@/lib/config";
import type { Me } from "./ui";
import type {
  StockPortfolioResponse,
  StockRealTxResponse,
  StockRealConfirmResponse,
} from "@/lib/api-types";

// The ONLY place the browser touches Solana. Everything else in the stock deck is HTTP; this hook
// owns the one flow that cannot be — building a swap server-side, signing it in the user's own
// wallet, and confirming the landed transaction back to the server.
//
// The shape of the flow is deliberate: the server builds, the device signs, the server books. The
// client never decides what a buy costs, never holds a key, and never marks a position as bought —
// the card advances only when /confirm returns a positionId.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export interface BuyRealTarget { assetId: string; symbol: string }
export interface BuyRealCtx { wallets: string[]; stockConsent: boolean }

// The mainnet chain literal, exactly as @privy-io/react-auth/solana declares it (SolanaChain).
const SOLANA_MAINNET = "solana:mainnet" as const;

// Base58 ENCODER — ~20 lines, no dependency. A Solana signature comes back from the wallet as raw
// bytes; every server route and every explorer speaks base58. The alphabet excludes 0/O/I/l.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!];
  return out;
}

// A pending buy, parked in localStorage between "the wallet sent it" and "the server booked it".
// The tab can die in that window (a phone call, a swipe-away), and the money is already gone — so
// the signature is written down BEFORE the confirm call, and replayed on the next visit.
type PendingEntry = { attemptId: string; sig: string };

function pendingKey(userId: string, payer: string): string {
  return `hf_stock_pending:${userId}:${payer}`;
}

function readPending(key: string): PendingEntry[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is PendingEntry => !!e && typeof e === "object" && typeof (e as PendingEntry).attemptId === "string" && typeof (e as PendingEntry).sig === "string");
  } catch {
    return [];
  }
}

function writePending(key: string, entries: PendingEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(entries));
  } catch { /* storage blocked — the buy still confirms, it just cannot be replayed */ }
}

// Error status + code, read the way page.tsx reads them off a thrown api() failure.
function errStatus(e: unknown): number | undefined {
  return (e as { status?: number }).status;
}
function errCode(e: unknown): string | undefined {
  return (e as { body?: { error?: string } }).body?.error;
}

export function useBuyReal(p: {
  api: Api;
  me: Me | null;
  onToast: (m: string) => void;
  onDone?: (r: { symbol: string; qtyBase: string; costCents: number }) => void;
}): {
  buyReal: (target: BuyRealTarget, stakeCents: number, ctx?: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => Promise<void>;
  busy: boolean;
  consentOpen: boolean;
  acceptConsent: () => Promise<void>;
  closeConsent: () => void;
  replayPending: () => Promise<number>;
} {
  const { api, me, onToast, onDone } = p;
  const [busy, setBusy] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  // The buy that was interrupted by the consent sheet. Held in a ref, not state: resuming it must
  // not re-render, and it must survive the sheet's own open/close churn.
  const pendingBuy = useRef<{ target: BuyRealTarget; stakeCents: number; ctx: BuyRealCtx; opts?: { hedgeSuggestionId?: string } } | null>(null);

  const { wallets: solWallets } = useSolanaWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();

  // Linking a wallet is a VERIFYING action: Privy makes the wallet sign a challenge, and the server
  // records the address as verified. A pasted address is read-only and cannot pay for a swap.
  const { linkWallet } = useLinkAccount({
    onSuccess: ({ linkedAccount }) => {
      if (linkedAccount?.type === "wallet" && linkedAccount.chainType === "solana") {
        void api("/api/hedge/wallet", { method: "POST", body: JSON.stringify({ address: linkedAccount.address }) })
          .then(() => onToast("Wallet linked — tap Buy on Solana again"))
          .catch(() => onToast("Couldn't link that wallet — try again"));
      }
    },
    onError: (error) => {
      if (error !== "exited_link_flow") onToast("Couldn't connect the wallet — try again");
    },
  });
  const { connectWallet } = useConnectWallet();

  // The whole buy, from ctx resolution to a booked position. Defined as a stable inner function so
  // acceptConsent can resume it without re-entering buyReal's own ctx fetch.
  const runBuy = useCallback(
    async (target: BuyRealTarget, stakeCents: number, ctx: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => {
      // 1. Wallet. The verified set is the server's; the connected set is Privy's. A wallet that is
      //    verified but not connected this session needs a connect, not a link.
      const verified = new Set(ctx.wallets);
      const w = solWallets.find((x) => verified.has(x.address));
      if (!w) {
        if (ctx.wallets.length > 0) {
          connectWallet({ walletChainType: "solana-only" });
          onToast("Connect the wallet you linked, then tap again");
        } else {
          linkWallet({ walletChainType: "solana-only", description: "Connect the Phantom wallet you buy stocks with" });
        }
        return;
      }

      // 2. Build. The server derives the swap from the asset + stake; nothing is spent here.
      let tx: StockRealTxResponse;
      try {
        tx = (await api("/api/stocks/real/tx", {
          method: "POST",
          body: JSON.stringify({ assetId: target.assetId || undefined, symbol: target.symbol, stakeCents, payer: w.address, hedgeSuggestionId: opts?.hedgeSuggestionId }),
        })) as StockRealTxResponse;
      } catch (e) {
        const status = errStatus(e);
        const code = errCode(e);
        if (status === 403 && code === "stock_consent_required") {
          pendingBuy.current = { target, stakeCents, ctx, opts };
          setConsentOpen(true);
        } else if (status === 403 && code === "wallet_not_verified") {
          linkWallet({ walletChainType: "solana-only", description: "Connect the Phantom wallet you buy stocks with" });
        } else if (status === 409 && code === "price_impact") {
          onToast("Too thin to buy right now");
        } else if (status === 409 && code === "asset_halted") {
          onToast("Trading is halted for this stock");
        } else if (status === 502 && code === "swap_unavailable") {
          onToast("Jupiter is busy — try again");
        } else if (status === 502 && code === "rpc_unavailable") {
          onToast("Solana RPC is busy — your buy will be picked up automatically");
        } else {
          onToast("Couldn't start that buy — try again");
        }
        return;
      }

      // 3. Sign + send. The wallet owns this step; a rejection is the user's own decision and is
      //    silent (no toast for a deliberate cancel).
      const bytes = Uint8Array.from(atob(tx.swapTransaction), (c) => c.charCodeAt(0));
      onToast("Confirm in your wallet…");
      let sig: string;
      try {
        const { signature } = await signAndSendTransaction({ transaction: bytes, wallet: w, chain: SOLANA_MAINNET });
        sig = encodeBase58(signature);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/reject|denied|cancel/i.test(msg)) return; // the user said no — nothing to report
        if (/insufficient|lamports|fee/i.test(msg)) onToast("Your wallet needs a little SOL for network fees");
        else onToast("Couldn't send the transaction");
        return;
      }

      // 4. Write the signature down BEFORE telling the server. If the tab dies between here and the
      //    confirm, the next visit replays it — the money is already gone at this point.
      const key = me ? pendingKey(me.user.id, w.address) : null;
      if (key) writePending(key, [...readPending(key), { attemptId: tx.attemptId, sig }]);

      // 5. Best-effort "sent" stamp, so the server's poller can recover this buy even if the client
      //    never confirms. A failure here is not fatal — the confirm below is the real path.
      try {
        await api("/api/stocks/real/sent", { method: "POST", body: JSON.stringify({ attemptId: tx.attemptId, sig }) });
      } catch { /* the poller sweep covers this */ }

      onToast("Confirming on Solana…");

      // 6. Confirm, with retries. A 404 means the tx has not landed yet — the chain is a beat behind
      //    the wallet's own "sent" answer. Six attempts, 2s apart, is ~12s of patience.
      let confirmed: StockRealConfirmResponse | null = null;
      for (let i = 0; i < 6; i++) {
        try {
          confirmed = (await api("/api/stocks/real/confirm", {
            method: "POST",
            body: JSON.stringify({ attemptId: tx.attemptId, sig }),
          })) as StockRealConfirmResponse;
          break;
        } catch (e) {
          if (errStatus(e) === 404) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          const code = errCode(e);
          if (errStatus(e) === 409 && code === "tx_failed") onToast("The transaction failed on Solana");
          else if (errStatus(e) === 409 && code === "not_this_buy") onToast("That transaction didn't match the buy");
          else if (errStatus(e) === 409 && code === "attempt_expired") onToast("That buy expired — try again");
          else if (errStatus(e) === 502) onToast("Solana RPC is busy — your buy will be picked up automatically");
          else onToast("Couldn't confirm the buy — it will be picked up automatically");
          return;
        }
      }
      if (!confirmed) {
        onToast("Still confirming — your buy will be picked up automatically");
        return;
      }

      // 7. Booked. Drop the pending entry and hand the result up; the caller advances the card.
      if (key) writePending(key, readPending(key).filter((e) => e.sig !== sig));
      onToast(`Bought ${target.symbol} on Solana ✓`);
      onDone?.({ symbol: target.symbol, qtyBase: confirmed.qtyBase, costCents: confirmed.costCents });
    },
    [api, connectWallet, linkWallet, me, onDone, onToast, signAndSendTransaction, solWallets],
  );

  // The consent sheet's accept. POSTs the CURRENT terms version, so a stale tab cannot accept a
  // text it never rendered, then resumes the buy that opened the sheet.
  const acceptConsent = useCallback(async () => {
    setBusy(true);
    try {
      await api("/api/stocks/consent", { method: "POST", body: JSON.stringify({ version: STOCK_TERMS_VERSION }) });
      setConsentOpen(false);
      const held = pendingBuy.current;
      pendingBuy.current = null;
      if (held) await runBuy(held.target, held.stakeCents, { ...held.ctx, stockConsent: true }, held.opts);
    } catch {
      onToast("Couldn't record your acceptance — try again");
    } finally {
      setBusy(false);
    }
  }, [api, onToast, runBuy]);

  const closeConsent = useCallback(() => {
    setConsentOpen(false);
    pendingBuy.current = null;
  }, []);


  const buyReal = useCallback(
    async (target: BuyRealTarget, stakeCents: number, ctx?: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => {
      setBusy(true);
      try {
        // ctx is optional so a caller that has not loaded the portfolio yet can still buy — the
        // portfolio route is the authoritative source of both the verified wallets and consent.
        let resolved = ctx;
        if (!resolved) {
          try {
            const pf = (await api("/api/stocks/portfolio")) as StockPortfolioResponse;
            resolved = { wallets: pf.wallets, stockConsent: pf.stockConsent };
          } catch {
            onToast("Couldn't read your wallet — try again");
            return;
          }
        }
        if (!resolved.stockConsent) {
          pendingBuy.current = { target, stakeCents, ctx: resolved, opts };
          setConsentOpen(true);
          return;
        }
        await runBuy(target, stakeCents, resolved, opts);
      } finally {
        setBusy(false);
      }
    },
    [api, onToast, runBuy],
  );

  // Replay: a buy whose tab died between send and confirm. One attempt each, no retry loop — the
  // server's own poller is the backstop, and a client that hammers confirm on every load is worse
  // than one that tries once and leaves the rest to the sweep.
  const replayPending = useCallback(async (): Promise<number> => {
    if (!me) return 0;
    let landed = 0;
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`hf_stock_pending:${me.user.id}:`)) keys.push(k);
      }
    } catch {
      return 0;
    }
    for (const key of keys) {
      const entries = readPending(key);
      const keep: PendingEntry[] = [];
      for (const entry of entries) {
        try {
          await api("/api/stocks/real/confirm", { method: "POST", body: JSON.stringify({ attemptId: entry.attemptId, sig: entry.sig }) });
          landed++;
        } catch (e) {
          const status = errStatus(e);
          // 200 or 409 = the attempt is resolved (booked, or terminally failed) — drop it either way.
          // 404/5xx = still in flight or the chain is unreachable — keep it for the next visit.
          if (status !== 404 && status !== undefined && status < 500) continue;
          keep.push(entry);
        }
      }
      writePending(key, keep);
    }
    return landed;
  }, [api, me]);

  return { buyReal, busy, consentOpen, acceptConsent, closeConsent, replayPending };
}
