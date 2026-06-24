"use client";

import { PrivyProvider } from "@privy-io/react-auth";

export default function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

  // Without an app id Privy can't init — render children so the page still loads
  // (shows the "configure Privy" notice instead of crashing).
  if (!appId) return <>{children}</>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        // ponytail: twitter off until X OAuth keys are added in the Privy dashboard;
        // re-add "twitter" here once enabled there.
        loginMethods: ["email"],
        // Lead-capture wallet provisioned on signup. EVM for now (Sep trading is
        // Polygon/pUSD); not used transactionally in July paper-mode.
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
        appearance: { theme: "dark", accentColor: "#6366f1" },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
