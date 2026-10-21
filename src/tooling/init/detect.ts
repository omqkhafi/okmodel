/**
 * Read-only project detection for `okm init`.
 *
 * No network and no database. Env files other than `.env.example` are not
 * opened. Lockfiles are not parsed; only their names are used.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { untrustedText, type UntrustedText } from "../untrusted.js";
import { CONFIG_FILE } from "../migrate/paths.js";
import {
  initError,
  isInitPackageManager,
  type InitDriver,
  type InitPackageManager,
} from "./guards.js";
import { assertReadable, resolveInside } from "./paths.js";

/** npm names that mean a driver is already installed. */
const DRIVER_OF: Readonly<Record<string, InitDriver>> = {
  postgres: "postgresjs",
  pg: "pg",
  "@neondatabase/serverless": "neon",
  "@electric-sql/pglite": "pglite",
};

/** Package managers in lockfile precedence order. */
const LOCKS: readonly (readonly [string, InitPackageManager])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** Runtimes init reports. */
export type InitRuntime = "bun" | "workers" | "next" | "node";

/** What detection found. Package names are untrusted. */
export type ProjectScan = {
  readonly pm: InitPackageManager;
  readonly runtime: InitRuntime;
  /** Driver packages already declared. Bun.sql is not implied by the runtime. */
  readonly installedDrivers: readonly InitDriver[];
  readonly packageName?: UntrustedText;
  readonly orm: readonly string[];
  readonly typescript: "absent" | "ok" | "warn";
  readonly git: boolean;
  readonly okmodel: boolean;
  readonly ancestorConfig: boolean;
  readonly databaseEnv: "DATABASE_URL";
  /** `.env.example` text, kept off the JSON document. */
  readonly envExample: string | undefined;
  readonly packageText: string;
};

/**
 * Reads the project enough to choose a package manager, driver, and runtime.
 *
 * @param root - Project directory, already real
 * @param pmOverride - `--pm`, when the user passed it
 * @returns The scan
 */
export function scanProject(root: string, pmOverride: InitPackageManager | undefined): ProjectScan {
  const packageText = readText(root, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageText);
  } catch {
    initError(
      "invalid",
      "package.json is not JSON.",
      "Fix package.json so okm init can edit dependencies and scripts.",
      "failed",
    );
  }
  const record = isRecord(parsed) ? parsed : {};
  const bags = [record.dependencies, record.devDependencies, record.optionalDependencies];
  const names = dependencyNames(bags);
  return {
    pm: pmOverride ?? detectPm(root, record.packageManager),
    runtime: detectRuntime(root, record.packageManager),
    installedDrivers: detectDrivers(names),
    ...(typeof record.name === "string"
      ? { packageName: untrustedText(record.name, "package.json") }
      : {}),
    orm: detectOrm(names),
    typescript: detectTypeScript(root),
    git: existsSync(join(root, ".git")),
    okmodel: names.has("okmodel"),
    ancestorConfig: hasAncestorConfig(root),
    databaseEnv: "DATABASE_URL",
    envExample: readOptional(root, ".env.example"),
    packageText,
  };
}

function detectPm(root: string, packageManager: unknown): InitPackageManager {
  for (const [file, pm] of LOCKS) {
    if (existsSync(join(root, file))) return pm;
  }
  if (typeof packageManager === "string") {
    const name = packageManager.split("@")[0] ?? "";
    if (isInitPackageManager(name)) return name;
  }
  return "npm";
}

function detectRuntime(root: string, packageManager: unknown): InitRuntime {
  const bunLock = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"));
  const bunField = typeof packageManager === "string" && packageManager.startsWith("bun@");
  if (bunLock || bunField) return "bun";
  if (existsSync(join(root, "wrangler.toml")) || existsSync(join(root, "wrangler.jsonc"))) {
    return "workers";
  }
  const next = ["js", "mjs", "cjs", "ts", "mts"].some((ext) =>
    existsSync(join(root, `next.config.${ext}`)),
  );
  if (next) return "next";
  return "node";
}

function detectDrivers(names: ReadonlySet<string>): readonly InitDriver[] {
  const found: InitDriver[] = [];
  for (const [pkg, driver] of Object.entries(DRIVER_OF)) {
    if (names.has(pkg)) found.push(driver);
  }
  return found;
}

function detectOrm(names: ReadonlySet<string>): readonly string[] {
  const notes: string[] = [];
  if (names.has("drizzle-orm")) notes.push("drizzle-orm");
  if (names.has("prisma") || names.has("@prisma/client")) notes.push("prisma");
  if (names.has("kysely")) notes.push("kysely");
  if (names.has("typeorm")) notes.push("typeorm");
  return notes;
}

function detectTypeScript(root: string): "absent" | "ok" | "warn" {
  const text = readOptional(root, "tsconfig.json");
  if (text === undefined) return "absent";
  const resolution = moduleResolution(text);
  if (resolution === "node16" || resolution === "nodenext" || resolution === "bundler") return "ok";
  return "warn";
}

function moduleResolution(text: string): string | undefined {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed) || !isRecord(parsed.compilerOptions)) return undefined;
    const value = parsed.compilerOptions.moduleResolution;
    return typeof value === "string" ? value.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function hasAncestorConfig(root: string): boolean {
  let dir = dirname(root);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, CONFIG_FILE))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function dependencyNames(bags: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const bag of bags) {
    if (!isRecord(bag)) continue;
    for (const name of Object.keys(bag)) names.add(name);
  }
  return names;
}

function readText(root: string, rel: string): string {
  assertReadable(rel);
  return readFileSync(resolveInside(root, rel), "utf8");
}

function readOptional(root: string, rel: string): string | undefined {
  assertReadable(rel);
  const path = join(root, rel);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  return readFileSync(path, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
