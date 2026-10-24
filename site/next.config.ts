import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DISCOVERY_LINK } from "./lib/discovery-links";
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
  async headers() {
    const link = { key: "Link", value: DISCOVERY_LINK };
    return [
      { source: "/", headers: [link] },
      { source: "/:path*", headers: [link] },
    ];
  },
  async redirects() {
    return [
      { source: "/docs/start/install", destination: "/docs/start", permanent: true },
      { source: "/docs/start/query", destination: "/docs/start", permanent: true },
      { source: "/docs/start/from-drizzle", destination: "/docs/migrate/from-drizzle", permanent: true },
      { source: "/docs/start/from-existing", destination: "/docs/migrate/from-existing", permanent: true },
      { source: "/docs/config", destination: "/docs/define/config", permanent: true },
      { source: "/docs/config/file", destination: "/docs/define/config", permanent: true },
      { source: "/docs/config/targets", destination: "/docs/define/config/database", permanent: true },
      { source: "/docs/config/paths", destination: "/docs/define/config#schema", permanent: true },
      { source: "/docs/config/pooler", destination: "/docs/define/config#pooler", permanent: true },
      { source: "/docs/config/timeouts", destination: "/docs/define/config#timeouts", permanent: true },
      { source: "/docs/config/lint", destination: "/docs/define/config#lint-from", permanent: true },
      { source: "/docs/config/backfill", destination: "/docs/define/config#backfill", permanent: true },
      { source: "/docs/config/roles", destination: "/docs/define/config/roles", permanent: true },
      { source: "/docs/define/config/schema", destination: "/docs/define/config#schema", permanent: true },
      { source: "/docs/define/config/tables", destination: "/docs/define/config#tables", permanent: true },
      { source: "/docs/define/config/migrations", destination: "/docs/define/config#migrations", permanent: true },
      { source: "/docs/define/config/out", destination: "/docs/define/config#out", permanent: true },
      { source: "/docs/define/config/timeouts", destination: "/docs/define/config#timeouts", permanent: true },
      { source: "/docs/define/config/pooler", destination: "/docs/define/config#pooler", permanent: true },
      { source: "/docs/define/config/lint-from", destination: "/docs/define/config#lint-from", permanent: true },
      { source: "/docs/define/config/backfill", destination: "/docs/define/config#backfill", permanent: true },
      { source: "/docs/define/config/namespace", destination: "/docs/define/config#namespace", permanent: true },
      { source: "/docs/define/config/external", destination: "/docs/define/config#external", permanent: true },
      { source: "/docs/schema", destination: "/docs/define/schema", permanent: true },
      { source: "/docs/schema/tables", destination: "/docs/define/schema/tables", permanent: true },
      { source: "/docs/schema/casing", destination: "/docs/define/schema/casing", permanent: true },
      { source: "/docs/schema/codecs", destination: "/docs/define/schema/codecs", permanent: true },
      { source: "/docs/schema/types", destination: "/docs/define/schema/types", permanent: true },
      { source: "/docs/schema/defaults", destination: "/docs/define/schema/defaults", permanent: true },
      { source: "/docs/schema/requires", destination: "/docs/define/schema/min-postgres", permanent: true },
      { source: "/docs/define/schema/requires", destination: "/docs/define/schema/min-postgres", permanent: true },
      { source: "/docs/schema/traits", destination: "/docs/define/schema/traits", permanent: true },
      { source: "/docs/schema/tenancy", destination: "/docs/define/schema/tenancy", permanent: true },
      { source: "/docs/schema/validation", destination: "/docs/define/schema/validation", permanent: true },
      { source: "/docs/schema/extensions", destination: "/docs/define/schema/extensions", permanent: true },
      { source: "/docs/schema/functions", destination: "/docs/define/schema/functions", permanent: true },
      { source: "/docs/schema/triggers", destination: "/docs/define/schema/triggers", permanent: true },
      { source: "/docs/schema/views", destination: "/docs/define/schema/views", permanent: true },
      { source: "/docs/table", destination: "/docs/define/table", permanent: true },
      { source: "/docs/table/columns", destination: "/docs/define/table/columns", permanent: true },
      { source: "/docs/table/keys", destination: "/docs/define/table/keys", permanent: true },
      { source: "/docs/table/indexes", destination: "/docs/define/table/indexes", permanent: true },
      { source: "/docs/table/checks", destination: "/docs/define/table/checks", permanent: true },
      { source: "/docs/table/defaults", destination: "/docs/define/table/defaults", permanent: true },
      { source: "/docs/table/references", destination: "/docs/define/table/references", permanent: true },
      { source: "/docs/table/relations", destination: "/docs/define/table/relations", permanent: true },
      { source: "/docs/table/visibility", destination: "/docs/define/table/visibility", permanent: true },
      { source: "/docs/table/names", destination: "/docs/define/table/names", permanent: true },
      { source: "/docs/table/traits", destination: "/docs/define/table/traits", permanent: true },
      { source: "/docs/table/tenancy", destination: "/docs/define/table/tenancy", permanent: true },
      { source: "/docs/table/presets", destination: "/docs/define/table/presets", permanent: true },
      { source: "/docs/table/reference", destination: "/docs/define/table/reference-rows", permanent: true },
      { source: "/docs/table/filters", destination: "/docs/define/table/filters", permanent: true },
      { source: "/docs/table/validation", destination: "/docs/define/table/validation", permanent: true },
      { source: "/docs/table/shape", destination: "/docs/define/table/shape", permanent: true },
      { source: "/docs/model/schema", destination: "/docs/define/table", permanent: true },
      { source: "/docs/model/queries", destination: "/docs/define/table/queries", permanent: true },
      { source: "/docs/start/queries", destination: "/docs/define/table/queries", permanent: true },
      { source: "/docs/model/safety", destination: "/docs/define/table/visibility", permanent: true },
      { source: "/docs/ship/migrations", destination: "/docs/define/config#migrations", permanent: true },
      { source: "/docs/ship/drivers", destination: "/docs/define/connect/drivers", permanent: true },
      { source: "/docs/define/connect/close", destination: "/docs/define/connect#close", permanent: true },
      { source: "/docs/define/connect/pool", destination: "/docs/define/connect/session#max", permanent: true },
      { source: "/docs/define/connect/prepared", destination: "/docs/define/connect/session#prepared", permanent: true },
      { source: "/docs/define/connect/tls", destination: "/docs/define/connect/session#tls", permanent: true },
      { source: "/docs/define/connect/search-path", destination: "/docs/define/connect/session#search-path", permanent: true },
      { source: "/docs/define/connect/timeouts", destination: "/docs/define/connect/session#timeouts", permanent: true },
      { source: "/docs/define/connect/require-meta", destination: "/docs/define/connect/check#require-meta", permanent: true },
      { source: "/docs/define/connect/catalog", destination: "/docs/define/connect/check#catalog", permanent: true },
      { source: "/docs/known-limits", destination: "/docs", permanent: true },
      { source: "/docs/reference/known-limits", destination: "/docs", permanent: true },
      { source: "/docs/reference/linter", destination: "/docs", permanent: true },
    ];
  },
  // Own lockfile: keep Turbopack rooted here so `next` resolves from site/node_modules.
  turbopack: {
    root: siteDir,
  },
};

export default withMDX(config);
