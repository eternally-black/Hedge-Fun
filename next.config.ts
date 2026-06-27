import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ship a minimal traced server (.next/standalone) for the Docker image
  // instead of the whole node_modules. Run with `node server.js`.
  output: "standalone",
  // Rewrite @privy-io/react-auth's barrel imports to direct imports at build time — the package is
  // a large barrel (200-800ms import / cold-start cost) and we import several hooks from it.
  experimental: { optimizePackageImports: ["@privy-io/react-auth"] },
};

export default nextConfig;
