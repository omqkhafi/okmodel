/**
 * Named groups for the CI test jobs.
 *
 * Every discovered test file belongs to one group. The workflow job is
 * `test / <group>`.
 *
 *   bun ./scripts/ci-test-groups.ts "reference app"
 *
 * Prints that group's files, one path per line.
 */

import { discoverTestFiles } from "./postgres-suite.js";
import { repoRoot } from "./root.js";

/** A CI test job and the files it runs. */
export type CiTestGroup = {
  /** Job name after `test /`. */
  readonly name: string;
  /** Paths from the repository root, `/` separated, sorted. */
  readonly files: readonly string[];
};

const MIGRATE = [
  "migrate",
  "lint",
  "backfill",
  "apply",
  "provision",
  "estimate",
  "classify",
  "seed",
  "drift",
  "recipes",
  "safe-rewrite",
  "enum-plan",
  "startup-compat",
  "push-backfill",
  "uuidv7",
  "recreate",
  "protected",
] as const;

const SCHEMA = [
  "pg-",
  "domain",
  "extensions",
  "type-",
  "views",
  "routines",
  "roles",
  "catalog",
  "fixtures",
  "interval",
  "insert",
  "input-",
] as const;

const TENANCY = ["tenancy", "tenant", "traits", "isolation"] as const;

const CLIENT = ["archive", "validate", "relations", "presets", "tx", "write-safety"] as const;

const DRIVERS = [
  "driver-",
  "error-suite",
  "client-close",
  "capabilities",
  "compatibility",
  "connect-floor",
  "error.test",
  "harness",
] as const;

const ROWS = ["pg-read", "pg-write", "pg-rows", "pg-bundle", "collation"] as const;

const TOPOLOGY = ["topology", "routing", "replication", "selection", "consistency"] as const;

const CONTRACTS = [
  "client-id",
  "engine-version",
  "okid",
  "reference",
  "sha256",
  "sql-lex",
  "statements.",
] as const;

const PACKAGE = [
  "api-surface",
  "export-shake",
  "package.",
  "quickstart",
  "release-gate",
  "provenance",
  "specifiers",
  "testing.",
] as const;

/**
 * Groups for one repository, in job order.
 *
 * @param root - Repository root
 * @returns One entry per CI test job
 */
export function ciTestGroups(root: string): readonly CiTestGroup[] {
  const buckets = new Map<string, string[]>(GROUP_NAMES.map((name) => [name, []]));
  for (const file of discoverTestFiles(root)) {
    const name = groupName(file);
    const bucket = buckets.get(name);
    if (bucket === undefined) throw new Error(`no test group for ${file}`);
    bucket.push(file);
  }
  return GROUP_NAMES.map((name) => ({ name, files: buckets.get(name) ?? [] }));
}

const GROUP_NAMES = [
  "reference app",
  "migrate",
  "migrate pg",
  "drivers",
  "rows",
  "topology",
  "schema",
  "columns",
  "schema pg",
  "tenancy",
  "client",
  "client pg",
  "package",
  "contracts",
  "safety",
  "scripts",
] as const;

function groupName(file: string): (typeof GROUP_NAMES)[number] {
  if (file.startsWith("packages/reference-app/")) return "reference app";
  if (file.startsWith("scripts/")) return "scripts";
  const base = file.slice(file.lastIndexOf("/") + 1);
  const pg = file.endsWith("-pg.test.ts");
  if (startsWithOne(base, MIGRATE)) return pg ? "migrate pg" : "migrate";
  if (startsWithOne(base, DRIVERS)) return "drivers";
  if (startsWithOne(base, ROWS)) return "rows";
  if (startsWithOne(base, TOPOLOGY)) return "topology";
  if (startsWithOne(base, SCHEMA)) {
    if (pg) return "schema pg";
    if (base.startsWith("pg-")) return "columns";
    return "schema";
  }
  if (startsWithOne(base, TENANCY)) return pg ? "client pg" : "tenancy";
  if (startsWithOne(base, CLIENT)) return pg ? "client pg" : "client";
  if (startsWithOne(base, PACKAGE)) return "package";
  if (startsWithOne(base, CONTRACTS)) return "contracts";
  if (file.startsWith("tests/")) return "safety";
  throw new Error(`no test group for ${file}`);
}

function startsWithOne(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

if (import.meta.main) {
  const name = process.argv[2];
  const group = ciTestGroups(repoRoot()).find((item) => item.name === name);
  if (group === undefined) {
    console.error(`usage: bun ./scripts/ci-test-groups.ts <${GROUP_NAMES.join("|")}>`);
    process.exit(1);
  }
  if (group.files.length === 0) {
    console.error(`test group ${name} has no files`);
    process.exit(1);
  }
  process.stdout.write(`${group.files.join("\n")}\n`);
}
