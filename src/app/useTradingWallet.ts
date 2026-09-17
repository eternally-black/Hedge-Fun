"use client";

import { useCallback, useRef } from "react";
import { usePrivy, type WalletWithMetadata } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import type { HedgeWalletResponse } from "@/lib/api-types";

// WHICH WALLET the app trades from — asked once, answered the same way everywhere. Two consumers
// with two different needs: useBuyReal wants the wallet OBJECT (it has to sign, and for a verified
// list it fetched itself), while every screen that only shows money wants the address. Split across
// two copies of this rule, the HUD would state one wallet's balance while a buy spent another's.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

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

  // Which wallet a real trade uses: the EMBEDDED wallet whenever the login has one — it is the one
  // the app funds ("send USDC here, fees on us") and the one the HUD names, and a Phantom linked on
  // the Hedge tab is linked to be READ for exposure, not to quietly become the wallet a swipe spends.
  // Only a login with no embedded wallet falls back to a connected external wallet the server has
  // verified.
  const pickWallet = useCallback(
    (verified: readonly string[]) => {
      const set = new Set(verified);
      return (
        wallets.find((w) => w.address === embeddedAddress) ??
        wallets.find((w) => set.has(w.address)) ??
        null
      );
    },
    [embeddedAddress, wallets],
  );

  return { pickWallet, wallets, embeddedAddress, ready };
}

// The same answer, for a screen that only needs to name the pocket and read its balance.
export function useTradingWallet(verified: readonly string[]): { address: string | null; embedded: boolean; ready: boolean } {
  const { pickWallet, embeddedAddress, ready } = useWalletPicker();
  const address = pickWallet(verified)?.address ?? null;
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
