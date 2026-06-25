"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";

const solanaConnectors = toSolanaWalletConnectors();

export default function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

  // Without an app id Privy can't init — render children so the page still loads
  // (shows the "configure Privy" notice instead of crashing).
  if (!appId) return <>{children}</>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "twitter"],
        // Lead-capture wallet provisioned on signup. EVM for now (Sep trading is
        // Polygon/pUSD); not used transactionally in July paper-mode.
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
        // Solana external wallets (Phantom etc.) enabled in the dashboard need
        // their connectors passed here, else Privy warns and connect is a no-op.
        externalWallets: { solana: { connectors: solanaConnectors } },
        appearance: { theme: "dark", accentColor: "#6366f1" },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
