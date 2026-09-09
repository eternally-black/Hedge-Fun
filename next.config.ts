import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ship a minimal traced server (.next/standalone) for the Docker image
  // instead of the whole node_modules. Run with `node server.js`.
  output: "standalone",
  // Rewrite @privy-io/react-auth's barrel imports to direct imports at build time — the package is
  // a large barrel (200-800ms import / cold-start cost) and we import several hooks from it.
  experimental: { optimizePackageImports: ["@privy-io/react-auth"] },
  // S8 (plan §2.7): browser integrity becomes a money control under Path A. CSP ships
  // Report-Only until Gate-0's live browser session verifies the Privy/SDK surfaces under it —
  // flipping to enforcement is a one-word change; the allowlist follows the app's real upstreams.
  // The report-uri points at /api/csp-report, which forwards violations to GlitchTip — the header
  // alone collects nothing.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Caddy terminates TLS and adds nothing; a first visit over plain http is strippable without it.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          {
            key: "Content-Security-Policy-Report-Only",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://auth.privy.io https://*.privy.io https://clob.polymarket.com https://gamma-api.polymarket.com https://bridge.polymarket.com https://polymarket.com https://relayer-v2.polymarket.com https://polygon-bor-rpc.publicnode.com wss://*.privy.io https://*.walletconnect.com wss://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.org; frame-src https://auth.privy.io https://*.privy.io; frame-ancestors 'none'; report-uri /api/csp-report",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
