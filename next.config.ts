import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development is intentionally reachable through arbitrary homelab proxies.
  // Next.js rejects bare wildcards, so this covers all multi-label hosts and
  // keeps the current single-label hostname explicit.
  allowedDevOrigins: ["homelab", "**.*"],
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": [".data/**/*"],
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
