// The phone's RealCtx — twin of src/app/useRealCtx.ts (web). Predictions sign with the Privy
// embedded EVM wallet: the SAME wallet the web uses, so one account has one Polymarket deposit
// wallet regardless of where it was provisioned. Never the Seeker's MWA wallet — that one is
// Solana-only and cannot sign an EIP-712 order.
import { useCallback, useMemo } from "react";
import { usePrivy, useEmbeddedEthereumWallet } from "@privy-io/expo";
import type { MeResponse } from "@contract/api-types";
import type { RealCtx } from "@contract/real-client";
import type { Eip1193Provider } from "@contract/real-signer";
import { API_BASE } from "../lib/config";
import { FLAVOR } from "./platform/flavor";

export function useRealCtx(me: MeResponse | null): {
  ctx: RealCtx | null; // null until Privy is ready AND the account has an embedded EVM wallet
  walletReady: boolean; // the Polymarket deposit wallet is provisioned (orders need it)
  hasEvmWallet: boolean;
  createEvmWallet: () => Promise<void>;
} {
  const { isReady, getAccessToken } = usePrivy();
  const { wallets, create } = useEmbeddedEthereumWallet();

  // Index 0 is the wallet the web created and the server syncs as the account's signer; a phone-first
  // account may only have whatever the SDK handed back, so fall back to the first one.
  const wallet = wallets.find((w) => w.walletIndex === 0) ?? wallets[0];
  const address = wallet?.address ?? null;
  const depositWallet = me?.real.depositWallet ?? null;

  const ctx = useMemo<RealCtx | null>(() => {
    if (!isReady || !wallet) return null;
    return {
      wallet: {
        address: wallet.address,
        getEthereumProvider: async () => (await wallet.getProvider()) as unknown as Eip1193Provider,
      },
      depositWalletAddress: depositWallet,
      getToken: getAccessToken,
      // The SDK fetches /api/builder/sign itself, outside our `api` wrapper, and the phone has no
      // origin to resolve a relative path against.
      apiBase: API_BASE,
      // Money routes accept a native client only with x-hf-client (src/lib/real.ts sameOrigin).
      clientHeaders: { "x-hf-client": FLAVOR },
    };
    // Keyed on the ADDRESS, not the wallet object: a re-render hands back a new wallets array and a
    // new object identity, and a ctx that changes identity every render churns every consumer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, address, depositWallet, getAccessToken]);

  // An account created on the phone (or before the web's createOnLogin) has no EVM wallet yet; the
  // web's is found as index 0 otherwise.
  const createEvmWallet = useCallback(async () => {
    await create();
  }, [create]);

  return { ctx, walletReady: !!depositWallet, hasEvmWallet: !!wallet, createEvmWallet };
}
