"use client";

// The RealCtx every real-money call needs, in one place. Both the profile's mode card and the deck's
// real swipe path need it, and duplicating the "which wallet is the embedded one" logic in two
// screens is how they drift apart.
import { usePrivy, useWallets } from "@privy-io/react-auth";
import type { RealCtx } from "@/lib/real-client";
import type { Me } from "./ui";

export function useRealCtx(me: Me | null): { ctx: RealCtx | null; walletReady: boolean } {
  const { wallets, ready } = useWallets();
  const { getAccessToken } = usePrivy();
  // useWallets() is the EVM list (Solana lives in useSolanaWallets), so the embedded EVM wallet is
  // the Privy-issued entry. It appears a beat after login, hence the null until it does.
  const embedded = wallets.find((w) => w.walletClientType === "privy");

  // `ready` is Privy's own "the wallets are ready to be used". Before it, an entry can already be
  // listed while its signing proxy is still coming up, and the first signature — which is what the
  // wallet setup asks for — throws from inside the SDK ("Wallet proxy not initialized"). Holding the
  // ctx back keeps the button at "Waiting for wallet…" for that beat instead of a failed setup.
  if (!ready || !embedded) return { ctx: null, walletReady: false };
  return {
    ctx: {
      wallet: embedded,
      depositWalletAddress: me?.real.depositWallet ?? null,
      getToken: getAccessToken,
    },
    // Provisioned = the deposit wallet exists server-side. Signing works before that; ORDERS do not,
    // because the intent route refuses without one.
    walletReady: !!me?.real.depositWallet,
  };
}
