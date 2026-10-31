import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep the example on the Node.js runtime (Fluid compute / Vercel Node).
  serverExternalPackages: ["postgres", "okmodel"],
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
