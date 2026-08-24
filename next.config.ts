import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": [".data/**/*"],
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
