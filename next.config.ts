import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["homelab"],
  output: "standalone",
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
