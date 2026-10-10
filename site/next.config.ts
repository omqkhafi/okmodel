import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readRootPackage } from "./lib/package-meta";
import { npmPackageUrl } from "./lib/shared";

const withMDX = createMDX();

/** This package (`site/`). Its own lockfile is the install root. */
const siteDir = dirname(fileURLToPath(import.meta.url));
const pkg = readRootPackage();

const config: NextConfig = {
  reactStrictMode: true,
  // Dev binds as `localhost`; browsing via `http://127.0.0.1` is a different origin.
  allowedDevOrigins: ["127.0.0.1"],
  logging: {
    incomingRequests: {
      ignore: [/\/json(?:\/|$)/],
    },
  },
  env: {
    NEXT_PUBLIC_OKMODEL_VERSION: pkg.version,
    NEXT_PUBLIC_NPM_URL: npmPackageUrl(pkg.name),
  },
  // TypeScript 7 drops the JS compiler API Next uses by default.
  experimental: {
    useTypeScriptCli: true,
  },
  typescript: {
    tsconfigPath: "tsconfig.build.json",
  },
  // Own lockfile: keep Turbopack rooted here so `next` resolves from site/node_modules.
  turbopack: {
    root: siteDir,
  },
};

export default withMDX(config);
