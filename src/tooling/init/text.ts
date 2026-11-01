/**
 * File bodies `okm init` writes.
 *
 * The schema uses the public `okmodel/pg` builders. The client reads
 * `process.env.DATABASE_URL` and has no fallback URL and no credential.
 */

import { migrationGitAttributes } from "../migrate/project.js";
import type { InitDriver, InitSupportedTenancy } from "./guards.js";

/** Connect import and whether `connect` returns a promise. */
const DRIVERS: Readonly<
  Record<InitDriver, { readonly specifier: string; readonly await: boolean }>
> = {
  postgresjs: { specifier: "okmodel/pg/postgresjs", await: false },
  pg: { specifier: "okmodel/pg/pg", await: false },
  "bun-sql": { specifier: "okmodel/pg/bun", await: false },
  pglite: { specifier: "okmodel/pg/pglite", await: true },
  neon: { specifier: "okmodel/pg/neon", await: true },
};

/** npm package for a driver, when the driver is not built into the runtime. */
export const DRIVER_PACKAGES: Readonly<Partial<Record<InitDriver, string>>> = {
  postgresjs: "postgres",
  pg: "pg",
  pglite: "@electric-sql/pglite",
  neon: "@neondatabase/serverless",
};

/**
 * `.gitattributes` body shared with `okm generate init`.
 *
 * @returns The file text
 */
export function initGitAttributes(): string {
  return migrationGitAttributes();
}

/**
 * Lines added to `.gitignore`.
 *
 * `.okm` is not listed. `okm init` writes `.okm/init.json`, and that file is
 * committed. `.env` is listed because init never writes it and it can hold a
 * URL.
 *
 * @returns The lines, without a trailing blank
 */
export function gitignoreEntries(): readonly string[] {
  return [".env", ".env.local"];
}

/**
 * `okmodel.config.ts` body.
 *
 * `lint` is described in a comment. `defineConfig` does not accept that field.
 * `database` is set only when `DATABASE_URL` is a non-empty string, so an
 * offline `okm check` has no target to dial.
 *
 * @param dir - Base directory for `schema.ts`, such as `db`
 * @param baseSpecifier - Import of `okmodel.base.ts`. Omitted for one package
 * @returns The file text
 */
export function configText(dir: string, baseSpecifier?: string): string {
  const schema = `./${dir}/schema.ts`;
  if (baseSpecifier === undefined) {
    return `import { defineConfig } from "okmodel/migrate";

// \`database\` is one target named default. A protected target is
// \`{ url, protected: true }\` and refuses non-expand work (OKM1850).
// Several environments use \`targets\`. Pass --target when there is more
// than one. Omitting it is OKM1853.
// Reviewed migrations are linted strict (lint: { migrations: "strict" }).
// \`okm init\` writes this file. \`okm generate init\` writes the first migration.

const database = process.env.DATABASE_URL;

export default defineConfig({
  schema: ${JSON.stringify(schema)},
  migrations: "./migrations",
  ...(typeof database === "string" && database.length > 0 ? { database } : {}),
});
`;
  }
  return `import { defineConfig } from "okmodel/migrate";
import { settings } from ${JSON.stringify(baseSpecifier)};

// Targets stay in this package. Shared lint, roles, and target names
// live in okmodel.base.ts. That file has no database URL and no protected flag.

const database = process.env.DATABASE_URL;

export default defineConfig({
  ...settings,
  schema: ${JSON.stringify(schema)},
  migrations: "./migrations",
  ...(typeof database === "string" && database.length > 0 ? { database } : {}),
});
`;
}

/**
 * `okmodel.base.ts` body.
 *
 * Shared lint, roles, and target names. No database URL and no protected flag.
 *
 * @returns The file text
 */
export function baseText(): string {
  return `// Shared settings. Each package names its own targets in okmodel.config.ts.
// This file has no database URL and no protected flag.

export const settings = {
  lint: { migrations: "strict" },
  roles: {
    migration: "migration",
    app: "app",
  },
};
`;
}

/**
 * `schema.ts` body.
 *
 * The example table is `users`. Column tenancy adds `tenantId`; the table
 * does not declare that column.
 *
 * @param tenancy - `none` or `column`
 * @returns The file text
 */
export function schemaText(tenancy: InitSupportedTenancy): string {
  const tenancyImport =
    tenancy === "column" ? 'import { columnTenancy } from "okmodel/tenancy";\n' : "";
  const tenancyField =
    tenancy === "column" ? '\n  tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),' : "";
  return `${tenancyImport}import { schema, table, t } from "okmodel/pg";

// Example table. Delete \`users\` and take it out of \`tables\` when you add your own.
// Requires PostgreSQL 15 or newer (minPostgres: 15).

export const users = table("users", {
  id: t.id(),
  email: t.text(),
  createdAt: t.timestamptz(),
});

export const app = schema({
  minPostgres: 15,
  tables: [users],${tenancyField}
});

declare module "okmodel" {
  interface Register {
    readonly schema: typeof app;
  }
}
`;
}

/**
 * `client.ts` body for the detected driver.
 *
 * @param driver - Selected driver
 * @returns The file text
 */
export function clientText(driver: InitDriver): string {
  const spec = DRIVERS[driver];
  const call = spec.await ? "await connect" : "connect";
  return `import { connect } from ${JSON.stringify(spec.specifier)};

import { app } from "./schema.ts";

const url = process.env.DATABASE_URL;
if (url === undefined || url.length === 0) {
  throw new Error("DATABASE_URL is not set");
}

// Defaults. The library leaves them off until this object is set.
// find 100: find, descendants, ancestors. include 20: to-many include.
// page 50: page(). groupBy 500: grouped aggregate. max 1000: ceiling.
// .all(reason) reads past them. A limit on the call wins.
export const db = ${call}(url, {
  schema: app,
  ${LIMITS_OBJECT}
});
`;
}

/** The `limits` object `okm init` writes on `connect`. */
export const LIMITS_OBJECT =
  "limits: { find: 100, include: 20, page: 50, groupBy: 500, max: 1000 },";

/**
 * Whether `text` already passes `limits` to `connect`.
 *
 * @param text - Client source
 * @returns `true` when a `limits` property is present
 */
export function clientHasLimits(text: string): boolean {
  return /\blimits\s*:/.test(text);
}

/**
 * The block init prints when a generated client has no `limits`.
 *
 * @param path - Project-relative client path
 * @returns The hint, including the snippet and `okm init --limits`
 */
export function limitsHint(path: string): string {
  return [
    `${path} has no limits. The library does not set them on its own.`,
    "Add this to connect:",
    `  ${LIMITS_OBJECT}`,
    "find 100: find, descendants, ancestors. include 20: to-many include.",
    "page 50: page(). groupBy 500: grouped aggregate. max 1000: ceiling.",
    ".all(reason) reads past them. A limit on the call wins.",
    `okm init --limits applies this when ${path} is still the file init wrote.`,
  ].join("\n");
}

/**
 * Script command prefix for one package manager.
 *
 * Bun uses \`bun run --bun okm\` so the \`okm\` bin runs on Bun. npm uses
 * \`npx\`. pnpm and yarn use \`dlx\`.
 *
 * @param pm - Package manager
 * @returns The prefix, without a trailing space
 */
export function scriptPrefix(pm: "bun" | "pnpm" | "yarn" | "npm"): string {
  switch (pm) {
    case "bun":
      return "bun run --bun okm";
    case "pnpm":
      return "pnpm dlx okm";
    case "yarn":
      return "yarn dlx okm";
    case "npm":
      return "npx okm";
  }
}

/**
 * The three commands a finished init prints, in the package manager's syntax.
 *
 * @param pm - Package manager
 * @returns Exactly three lines
 */
export function nextSteps(pm: "bun" | "pnpm" | "yarn" | "npm"): readonly [string, string, string] {
  const prefix = scriptPrefix(pm);
  return [`${prefix} check`, `${prefix} migrate plan init`, `${prefix} migrate apply`];
}

/** Script names init adds when they are absent. There is no describe script. */
export const INIT_SCRIPTS = ["db:check", "db:plan", "db:apply", "db:status"] as const;

/**
 * Script body for one {@link INIT_SCRIPTS} name.
 *
 * @param pm - Package manager
 * @param name - Script name
 * @returns The command
 */
export function scriptCommand(
  pm: "bun" | "pnpm" | "yarn" | "npm",
  name: (typeof INIT_SCRIPTS)[number],
): string {
  const prefix = scriptPrefix(pm);
  switch (name) {
    case "db:check":
      return `${prefix} check`;
    case "db:plan":
      return `${prefix} migrate plan`;
    case "db:apply":
      return `${prefix} migrate apply`;
    case "db:status":
      return `${prefix} migrate status`;
  }
}
