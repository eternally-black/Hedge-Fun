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
        // showWalletUIs:false = AUTO-SIGN. Every CLOB order is an EIP-712 signature — that is the
        // protocol, not a choice — so with the prompt on, a real-money swipe becomes "swipe, then
        // confirm in a modal", which is not a swipe. The deck's whole interaction model is one
        // gesture, and that model is the product.
        //
        // What it trades, stated plainly because it is not visible in the code that calls it: in
        // REAL mode a single swipe spends real funds with no per-order confirmation. The guards
        // that remain are the ones that do not cost a gesture — the server derives every order
        // param itself and the client signs only what /api/real/intent issued, the all-in cap
        // bounds the debit, the daily cap bounds the count, and the irreversible verbs (withdraw,
        // bridge-out) keep their explicit confirmation. Set client-side, which overrides the Privy
        // dashboard, so this decision lives here rather than in a console nobody reads.
        // Solana: "users-without-wallets" — a user who already linked Phantom keeps buying from it;
        // everyone else gets an embedded Solana wallet on login, which is what makes a fee-sponsored
        // xStocks buy possible without the user ever installing a wallet (USDC in, no SOL needed).
        embeddedWallets: { ethereum: { createOnLogin: "all-users" }, solana: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
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
