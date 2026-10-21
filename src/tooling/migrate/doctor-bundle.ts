/**
 * `okm doctor --bundle`: one local JSON file a tester sends by hand (O-6, D307).
 *
 * The bundle holds facts about the toolchain and the project layout, and the
 * codes the checks that need no database raise. It never holds a connection
 * string, a host, a user, a URL, a table or column name, SQL text, a row value,
 * a path outside the project, or an environment variable value. Nothing here
 * opens a socket or imports an adapter.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { OkmError } from "../../contracts/error.js";
import { WARNING_RULES } from "../../runtime/warnings/catalog.js";
import { POSTGRES_FEATURES } from "../capabilities/postgres.js";
import { assertSupported } from "../capabilities/check.js";
import { featuresUsed } from "../capabilities/used.js";
import { readPackageVersion } from "../cli/version.js";
import { tagOutcome } from "../cli/outcome.js";
import { DRIVER_OF, scanProject, type ProjectScan } from "../init/detect.js";
import { findWorkspaceRoot, listWorkspaces } from "../workspaces.js";
import { listAllows, allowFindings, WEAK_ALLOW_CODE } from "./allows.js";
import { projectFilterUses } from "./filter-scan.js";
import { lintMigrationDirectory, type Finding } from "./lint.js";
import { COLUMN_RULES, STEP_RULES } from "./lint-rules.js";
import type { MigrateConfig } from "./config.js";
import { projectPath, type ProjectContext } from "./paths.js";
import { loadConfig, offlineFindings, openProject } from "./project.js";
import { schemaAdvice } from "./schema-rules.js";

/** `bundleFormat` of the file. A change to any key name or meaning raises it. */
export const BUNDLE_FORMAT = 1;

/** Project-relative path of the bundle when `--out` is not given. */
export const DEFAULT_BUNDLE_PATH = ".okm/doctor-bundle.json";

/** Files okmodel writes under `.okm/`. A name outside this list is never reported. */
const ARTIFACT_FILES: readonly string[] = [
  "catalog.hash",
  "catalog.json",
  "init.json",
  "namespace",
  "raw.d.ts",
  "raw.lock.json",
  "types.d.ts",
];

/** Directories okmodel creates under `.okm/`. */
const ARTIFACT_DIRECTORIES: readonly string[] = ["dev-db"];

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const KNOWN_CODE = /^(?:OKM\d{4}|coupling)$/;

/** One installed driver package. `version` is `null` when it is not in `node_modules`. */
export type BundleAdapter = {
  readonly name: string;
  readonly package: string;
  readonly version: string | null;
};

/** One entry under `.okm/`. A file carries its SHA-256, a directory does not. */
export type BundleArtifact =
  | { readonly kind: "file"; readonly name: string; readonly sha256: string }
  | { readonly kind: "directory"; readonly name: string };

/** Result of one rule in the database-free checks. */
export type BundleRule = {
  readonly result: "pass" | "fail";
  readonly severity: "error" | "warning";
};

/** The document `okm doctor --bundle` writes. Normative shape: `schemas/cli-1/doctor.json`. */
export type DoctorBundle = {
  readonly adapters: readonly BundleAdapter[];
  readonly artifacts: readonly BundleArtifact[];
  readonly bundleFormat: typeof BUNDLE_FORMAT;
  readonly capabilities: {
    readonly dialect: "postgres";
    readonly emulated: readonly string[];
    readonly features: number;
    readonly native: number;
    readonly refused: readonly string[];
    readonly used: readonly string[];
  };
  readonly checks: {
    readonly codes: readonly string[];
    readonly failures: readonly string[];
    readonly result: "pass" | "fail";
    readonly rules: Readonly<Record<string, BundleRule>>;
    readonly scope: "offline";
  };
  readonly config: {
    readonly ambiguous: number;
    readonly file: string | null;
    readonly found: boolean;
    readonly loaded: boolean;
    readonly targets: number;
  };
  readonly dialect: {
    readonly name: "postgres";
    readonly package: "okmodel";
    readonly version: string;
  };
  readonly layout: {
    readonly configInWorkspaceRoot: boolean;
    readonly migrations: number;
    readonly monorepo: boolean;
    readonly workspacePackages: number;
  };
  readonly okmodel: { readonly version: string };
  readonly packageManager: "bun" | "npm" | "pnpm" | "yarn" | "unknown";
  readonly runtime: {
    readonly arch: string;
    readonly bun: string | null;
    readonly node: string;
    readonly os: string;
  };
};

/**
 * Collects the bundle for one project. It does not throw for a broken project:
 * a stage that fails is recorded as a code in `checks.failures`.
 *
 * @param project - Project directory and config path
 * @returns The bundle document
 */
export async function collectBundle(project: ProjectContext): Promise<DoctorBundle> {
  const root = project.cwd;
  const ambiguous = project.ambiguous?.length ?? 0;
  const found = ambiguous === 0 && existsSync(project.configPath);
  const version = readPackageVersion();
  const ran = found ? await runChecks(project) : emptyRun();
  const config = ran.config;
  const workspaceRoot = findWorkspaceRoot(root);
  const scans = [scan(root), workspaceRoot === undefined ? undefined : scan(workspaceRoot)];
  const migrations = projectPath(root, config?.migrations ?? "migrations");
  const support = Object.values(POSTGRES_FEATURES);
  return {
    adapters: adaptersOf(root, scans),
    artifacts: artifactsOf(projectPath(root, config?.out ?? ".okm")),
    bundleFormat: BUNDLE_FORMAT,
    capabilities: {
      dialect: "postgres",
      emulated: featureKeys("emulated"),
      features: support.length,
      native: support.filter((entry) => entry.support === "native").length,
      refused: featureKeys("refused"),
      used: ran.used,
    },
    checks: checksOf(ran),
    config: {
      ambiguous,
      file: found ? basename(project.configPath) : null,
      found,
      loaded: config !== undefined,
      targets: config === undefined ? 0 : targetCount(config),
    },
    dialect: { name: "postgres", package: "okmodel", version },
    layout: {
      configInWorkspaceRoot: workspaceRoot !== undefined && workspaceRoot === root,
      migrations: countSql(migrations),
      monorepo: workspaceRoot !== undefined,
      workspacePackages: workspaceRoot === undefined ? 0 : listWorkspaces(workspaceRoot).length,
    },
    okmodel: { version },
    packageManager: packageManagerOf(
      workspaceRoot === undefined ? scans[0] : (scans[1] ?? scans[0]),
    ),
    runtime: {
      arch: process.arch,
      bun: process.versions.bun ?? null,
      node: process.versions.node,
      os: process.platform,
    },
  };
}

/**
 * Pretty JSON for a bundle. Keys sort at every depth, so the same project
 * writes the same bytes.
 *
 * @param bundle - Bundle from {@link collectBundle}
 * @returns JSON text ending in a newline
 */
export function bundleText(bundle: DoctorBundle): string {
  return `${JSON.stringify(sortKeys(bundle), null, 2)}\n`;
}

/**
 * Writes the bundle. An existing file is refused unless `force` is set.
 *
 * @param path - Absolute path
 * @param shown - The path as the user wrote it, for messages
 * @param text - Output of {@link bundleText}
 * @param force - `--force-file`
 * @returns Bytes written
 */
export function writeBundle(path: string, shown: string, text: string, force: boolean): number {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { flag: force ? "w" : "wx" });
  } catch (error) {
    const errno = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    if (errno === "EEXIST") {
      throw tagOutcome(
        new OkmError("invalid", `${shown} already exists.`, {
          fix: { summary: "Pass --force-file to replace it, or choose another file with --out." },
        }),
        "guard",
      );
    }
    throw tagOutcome(
      new OkmError("invalid", `Could not write ${shown} (${errno}).`, {
        fix: { summary: "Pass --out <file> with a path okm can create." },
      }),
      "usage",
    );
  }
  return Buffer.byteLength(text);
}

type Hit = { readonly code: string; readonly severity: "error" | "warning" };

type Run = {
  readonly config: MigrateConfig | undefined;
  readonly hits: readonly Hit[];
  readonly failures: readonly string[];
  readonly used: readonly string[];
};

function emptyRun(): Run {
  return { config: undefined, hits: [], failures: [], used: [] };
}

/**
 * The checks `okm check` and `okm migrate check` run before they connect.
 * Only codes and severities leave this function, never a finding's text.
 */
async function runChecks(project: ProjectContext): Promise<Run> {
  const hits: Hit[] = [];
  const failures = new Set<string>();
  const attempt = async <T>(step: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await step();
    } catch (error) {
      failures.add(codeOf(error));
      return undefined;
    }
  };
  const opened = await attempt(() => openProject(project));
  if (opened === undefined) {
    const config = await attempt(() => loadConfig(project));
    return { config, hits, failures: sorted(failures), used: [] };
  }
  const { cwd, config } = opened;
  const used = featuresUsed(opened.built.catalog);
  await attempt(() => assertSupported(used, POSTGRES_FEATURES, "postgres"));
  const directory = projectPath(cwd, config.migrations ?? "migrations");
  const findings: Finding[] = [];
  findings.push(...((await attempt(() => offlineFindings(opened))) ?? []));
  findings.push(...((await attempt(() => lintMigrationDirectory(directory))) ?? []));
  findings.push(...((await attempt(() => allowFindings(listAllows(directory)))) ?? []));
  for (const item of findings) hits.push({ code: safeCode(item.code), severity: item.severity });
  const advised = await attempt(() =>
    schemaAdvice(opened.built, projectFilterUses(cwd, config), config.warnings ?? {}),
  );
  for (const item of advised?.advice ?? []) {
    hits.push({
      code: safeCode(item.code),
      severity: item.level === "error" ? "error" : "warning",
    });
  }
  return { config, hits, failures: sorted(failures), used };
}

function checksOf(ran: Run): DoctorBundle["checks"] {
  const rules = new Map<string, { result: "pass" | "fail"; severity: "error" | "warning" }>();
  for (const [code, severity] of knownRules()) rules.set(code, { result: "pass", severity });
  for (const hit of ran.hits) {
    const before = rules.get(hit.code);
    const severity = before?.severity === "error" || hit.severity === "error" ? "error" : "warning";
    rules.set(hit.code, { result: "fail", severity });
  }
  const codes = new Set<string>([...ran.hits.map((hit) => hit.code), ...ran.failures]);
  const failed = ran.failures.length > 0 || ran.hits.some((hit) => hit.severity === "error");
  return {
    codes: sorted(codes),
    failures: ran.failures,
    result: failed ? "fail" : "pass",
    rules: Object.fromEntries(
      [...rules.entries()].sort((left, right) => compare(left[0], right[0])),
    ),
    scope: "offline",
  };
}

function knownRules(): readonly (readonly [string, "error" | "warning"])[] {
  return [
    ...STEP_RULES.map((rule) => [rule.code, rule.severity] as const),
    ...COLUMN_RULES.map((rule) => [rule.code, rule.severity] as const),
    ...WARNING_RULES.filter((rule) => rule.phase === "check").map(
      (rule) => [rule.code, rule.defaultLevel === "error" ? "error" : "warning"] as const,
    ),
    [WEAK_ALLOW_CODE, "warning"] as const,
  ];
}

function codeOf(error: unknown): string {
  return error instanceof OkmError ? safeCode(error.code) : "unknown";
}

function safeCode(code: string): string {
  return KNOWN_CODE.test(code) ? code : "unknown";
}

function featureKeys(support: "emulated" | "refused"): readonly string[] {
  return Object.entries(POSTGRES_FEATURES)
    .filter(([, entry]) => entry.support === support)
    .map(([key]) => key)
    .sort(compare);
}

function targetCount(config: MigrateConfig): number {
  return (config.database === undefined ? 0 : 1) + Object.keys(config.targets ?? {}).length;
}

function scan(directory: string): ProjectScan | undefined {
  try {
    return scanProject(directory, undefined);
  } catch {
    return undefined;
  }
}

function packageManagerOf(scanned: ProjectScan | undefined): DoctorBundle["packageManager"] {
  return scanned?.pm ?? "unknown";
}

function adaptersOf(
  root: string,
  scans: readonly (ProjectScan | undefined)[],
): readonly BundleAdapter[] {
  const names = new Set<string>();
  for (const scanned of scans) {
    for (const driver of scanned?.installedDrivers ?? []) names.add(driver);
  }
  const packages = Object.entries(DRIVER_OF).filter(([, driver]) => names.has(driver));
  return packages
    .map(([pkg, driver]) => ({ name: driver, package: pkg, version: installedVersion(root, pkg) }))
    .sort((left, right) => compare(left.name, right.name));
}

function installedVersion(root: string, pkg: string): string | null {
  let directory = root;
  for (let depth = 0; depth < 8; depth += 1) {
    const file = join(directory, "node_modules", pkg, "package.json");
    if (existsSync(file)) return versionIn(file);
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

function versionIn(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : null;
    return typeof version === "string" && SEMVER.test(version) ? version : null;
  } catch {
    return null;
  }
}

function artifactsOf(directory: string): readonly BundleArtifact[] {
  const found: BundleArtifact[] = [];
  for (const name of ARTIFACT_FILES) {
    const file = join(directory, name);
    if (!isKind(file, "file")) continue;
    found.push({
      kind: "file",
      name,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    });
  }
  for (const name of ARTIFACT_DIRECTORIES) {
    if (isKind(join(directory, name), "directory")) found.push({ kind: "directory", name });
  }
  return found.sort((left, right) => compare(left.name, right.name));
}

function isKind(path: string, kind: "file" | "directory"): boolean {
  try {
    const stat = lstatSync(path);
    return kind === "file" ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

function countSql(directory: string): number {
  if (!isKind(directory, "directory")) return 0;
  return readdirSync(directory).filter((file) => file.endsWith(".sql")).length;
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort(compare);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort(compare)) out[key] = sortKeys(record[key]);
  return out;
}
