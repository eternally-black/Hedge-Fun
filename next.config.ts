import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ship a minimal traced server (.next/standalone) for the Docker image
  // instead of the whole node_modules. Run with `node server.js`.
  output: "standalone",
};

export default nextConfig;
