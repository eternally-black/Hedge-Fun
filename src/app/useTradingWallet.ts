"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import { usePrivy, type WalletWithMetadata } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import type { HedgeWalletResponse } from "@/lib/api-types";

// WHICH WALLET the app trades from — asked once, answered the same way everywhere. Two consumers
// with two different needs: useBuyReal wants the wallet OBJECT (it has to sign, and for a verified
// list it fetched itself), while every screen that only shows money wants the address. Split across
// two copies of this rule, the HUD would state one wallet's balance while a buy spent another's.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// ── The user's pick ──────────────────────────────────────────────────────────────────────────────
// Which of their verified wallets a user trades from, remembered per browser. Nothing stored (or a
// stored address the server no longer lists as verified) = the embedded wallet. A tiny external
// store rather than component state: the HUD chip, the wallet sheet, the deck CTA and the Profile
// all read it, and a pick on the Profile has to move every one of them in the same render.
const CHOICE_KEY = "hf_trading_wallet:v1";
const choiceListeners = new Set<() => void>();
let choice: string | null | undefined; // undefined = not read from storage yet
function getTradingWalletChoice(): string | null {
  if (choice === undefined) {
    try {
      choice = typeof window === "undefined" ? null : window.localStorage.getItem(CHOICE_KEY);
    } catch {
      choice = null; // storage blocked — the default (embedded) it is
    }
  }
  return choice;
}
export function setTradingWalletChoice(address: string | null): void {
  choice = address;
  try {
    if (address) window.localStorage.setItem(CHOICE_KEY, address);
    else window.localStorage.removeItem(CHOICE_KEY);
  } catch {
    /* storage blocked — the pick still holds for this session */
  }
  choiceListeners.forEach((l) => l());
}
function subscribeChoice(l: () => void): () => void {
  choiceListeners.add(l);
  return () => { choiceListeners.delete(l); };
}
export function useTradingWalletChoice(): string | null {
  return useSyncExternalStore(subscribeChoice, getTradingWalletChoice, () => null);
}

// The picker, for the hook that signs. Kept separate from useTradingWallet because a buy resolves
// its verified list at tap time (it may have just fetched the portfolio), not at render time.
export function useWalletPicker() {
  const { wallets, ready } = useSolanaWallets();
  const { user } = usePrivy();

  // The Privy EMBEDDED Solana wallet. A ConnectedStandardSolanaWallet carries only `address` and
  // `standardWallet`, so "is this one ours" cannot be asked of the connected wallet — it is asked of
  // the LINKED ACCOUNT that created it, where walletClientType === 'privy' is the SDK's own marker.
  const embeddedAddress =
    user?.linkedAccounts.find(
      (a): a is WalletWithMetadata => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy",
    )?.address ?? null;

  // Which wallet a real trade uses. The user's own pick first (Profile → Wallet), when the server
  // lists it as verified: the CONNECTED wallet with that address — or null, because a pick that is
  // not connected in this browser must not silently become a different wallet; the caller asks the
  // user to connect it. No pick = the EMBEDDED wallet whenever the login has one (it is the one the
  // app funds — "send USDC here, fees on us" — and the one the HUD names), so a Phantom linked on the
  // Hedge tab for exposure never becomes the wallet a swipe spends until the user says so. Only a
  // login with no embedded wallet falls back to a connected external wallet the server has verified.
  const chosen = useTradingWalletChoice();
  const pickWallet = useCallback(
    (verified: readonly string[]) => {
      const set = new Set(verified);
      if (chosen && set.has(chosen)) return wallets.find((w) => w.address === chosen) ?? null;
      return (
        wallets.find((w) => w.address === embeddedAddress) ??
        wallets.find((w) => set.has(w.address)) ??
        null
      );
    },
    [chosen, embeddedAddress, wallets],
  );

  return { pickWallet, wallets, embeddedAddress, ready };
}

// The same answer, for a screen that only needs to name the pocket and read its balance. A verified
// pick is named even while that wallet is not connected in this browser — its balance is still the
// user's to see, and a buy from it asks them to connect it.
export function useTradingWallet(verified: readonly string[]): { address: string | null; embedded: boolean; ready: boolean } {
  const { pickWallet, embeddedAddress, ready } = useWalletPicker();
  const chosen = useTradingWalletChoice();
  const address = (chosen && verified.includes(chosen) ? chosen : null) ?? pickWallet(verified)?.address ?? null;
  return { address, embedded: address !== null && address === embeddedAddress, ready };
}

// ensureVerified's one refusal: the POST succeeded but the server could not confirm ownership, so
// the address must NOT be treated as usable.
export function isWalletUnverified(e: unknown): boolean {
  return e instanceof Error && e.message === "wallet_unverified";
}

// Tell the server about a wallet it has not seen. An embedded wallet is a Privy LINKED account, so
// /api/hedge/wallet can verify it through Privy without a signature prompt — but it is a write, and
// both the first trade and the balance read want it done, so it runs at most once per address.
export function useEnsureVerified(api: Api, onRefreshMe?: () => void | Promise<void>): (address: string) => Promise<void> {
  const verifiedOnce = useRef<Set<string>>(new Set());
  return useCallback(
    async (address: string): Promise<void> => {
      if (verifiedOnce.current.has(address)) return;
      verifiedOnce.current.add(address);
      try {
        // 200 is NOT "verified": the route never refuses on a Privy outage, it answers 200 with
        // verified:false. Caching that would leave the wallet unusable for the rest of the session —
        // every balance read 403s and a buy sends an embedded-wallet user into the link flow.
        const r = (await api("/api/hedge/wallet", { method: "POST", body: JSON.stringify({ address }) })) as HedgeWalletResponse;
        if (!r.verified) throw new Error("wallet_unverified");
        await onRefreshMe?.();
      } catch (e) {
        verifiedOnce.current.delete(address); // a failed verify must stay retryable, not stick
        throw e;
      }
    },
    [api, onRefreshMe],
  );
}
