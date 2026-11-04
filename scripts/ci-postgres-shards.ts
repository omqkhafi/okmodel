/**
 * Shards for the Postgres suite jobs.
 *
 * A shard runs only test files that need Postgres: files whose import closure
 * reaches a module that reads `REQUIRE_DOCKER` (the gate in
 * `packages/harness/src/docker-gate.ts`, or a file that reads it itself).
 * Every other file runs only in the `test / <group>` jobs, which already run
 * every file. A labelled pull request runs one job per shard per Postgres
 * major, each with its own topology. Local `postgres-suite.ts` without
 * `--shard` still runs every file.
 *
 *   bun ./scripts/ci-postgres-shards.ts isolation
 *   bun ./scripts/ci-postgres-shards.ts --needs-build tx
 *
 * The first prints that shard's files, one path per line. The second prints
 * `yes` when the shard executes tests that import `dist/`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Shard names, in job order. The workflow matrix lists these same names. */
export const POSTGRES_SHARDS = ["isolation", "selection", "consistency", "tx"] as const;

/** One Postgres suite job. */
export type PostgresShard = (typeof POSTGRES_SHARDS)[number];

/**
 * The shard that runs `bun run build`.
 *
 * Its files import the package name or read `dist/`. The other shards load
 * TypeScript source and skip the build.
 */
export const POSTGRES_BUILD_SHARD: PostgresShard = "tx";

/**
 * Postgres files pinned to a shard, from per-file times on Postgres 17
 * (local four-shard run, 2026-11-04). The four longest (isolation property
 * 134s, tx-suite 85s, compatibility 69s, kill storm 66s) sit on four shards.
 * The other pins even out the totals; every unpinned file goes by path hash.
 */
const HEAVY: Readonly<Record<string, PostgresShard>> = {
  "tests/isolation.property.test.ts": "isolation",
  "tests/archive-gate.property.test.ts": "isolation",
  "tests/compatibility.test.ts": "selection",
  "tests/driver-suite.test.ts": "selection",
  "tests/replica-unreachable-pg.test.ts": "selection",
  "tests/migrate-check-pg.test.ts": "selection",
  "tests/replication.test.ts": "selection",
  "tests/gate-sensitivity.test.ts": "selection",
  "tests/fixtures-schema.test.ts": "selection",
  "tests/postgres-kill-storm-pg.test.ts": "consistency",
  "tests/consistency.test.ts": "consistency",
  "tests/topology-conformance.test.ts": "consistency",
  "tests/statements.shape.test.ts": "consistency",
  "tests/error-suite.test.ts": "consistency",
  "tests/tx-suite.test.ts": "tx",
  "tests/harness.test.ts": "tx",
};

/**
 * Files that need the built package and are not under `packages/reference-app/`.
 *
 * The CI groups read this too (`groupNeedsDist`), so it also lists files that
 * do not need Postgres. A reference-app test that needs Postgres always lands
 * on {@link POSTGRES_BUILD_SHARD} by prefix.
 */
const BUILD_FILES: ReadonlySet<string> = new Set([
  "tests/adopt-index-pg.test.ts",
  "tests/baseline-pg.test.ts",
  "tests/client-close.test.ts",
  "tests/early-close.test.ts",
  "tests/package.test.ts",
  "tests/quickstart.test.ts",
  "tests/recipes.test.ts",
  "tests/pull-adopt-pg.test.ts",
  "tests/pull-pg.test.ts",
  "tests/seed-import.test.ts",
]);

/** One shard after the files have been dealt. */
export type PostgresShardGroup = {
  /** Job name after `suite / <version> /`. */
  readonly name: PostgresShard;
  /** Paths from the repository root, `/` separated, sorted. */
  readonly files: readonly string[];
  /** True when this shard must run `bun run build` before the tests. */
  readonly needsBuild: boolean;
};

/**
 * Postgres files pinned to a shard.
 *
 * @returns Paths from the repository root
 */
export function postgresHeavyFiles(): readonly string[] {
  return Object.keys(HEAVY);
}

/**
 * Whether a file reads `dist/` or imports the package by name.
 *
 * @param file - Path from the repository root
 * @returns True when the file belongs on {@link POSTGRES_BUILD_SHARD}
 */
export function postgresFileNeedsBuild(file: string): boolean {
  return file.startsWith("packages/reference-app/") || BUILD_FILES.has(file);
}

/**
 * Whether `name` is one of {@link POSTGRES_SHARDS}.
 *
 * @param name - Argument from the command line or the workflow matrix
 * @returns True when `name` is a shard
 */
export function isPostgresShard(name: string): name is PostgresShard {
  return (POSTGRES_SHARDS as readonly string[]).includes(name);
}

/**
 * Reads `--shard <name>` from a `postgres-suite` argument list.
 *
 * @param argv - `process.argv`, including the runtime and the script
 * @returns The shard, or undefined when `--shard` is absent
 */
export function parsePostgresShard(argv: readonly string[]): PostgresShard | undefined {
  const index = argv.indexOf("--shard");
  if (index === -1) return undefined;
  const name = argv[index + 1];
  if (name === undefined || !isPostgresShard(name)) {
    throw new Error(
      `usage: bun ./scripts/postgres-suite.ts [--shard ${POSTGRES_SHARDS.join("|")}]`,
    );
  }
  return name;
}

/** A module that decides whether Postgres tests run, skip, or fail. */
const POSTGRES_GATE = /process\.env(?:\.REQUIRE_DOCKER\b|\[["']REQUIRE_DOCKER["']\])/;

/**
 * Module specifiers a file loads at runtime: `import … from`, `export … from`,
 * a bare `import "…"`, and `import("…")` with a string literal. `import type`
 * and `export type` load nothing and are left out.
 */
const SPECIFIER =
  /(?:^|[\s;}])(?:import|export)(?!\s+type\s)(?:[\s\w{},*$]*?\sfrom\s*|\s*\(\s*|\s+)["']([^"']+)["']/g;

/**
 * Test files that need Postgres.
 *
 * A file needs Postgres when its import closure reaches a module that reads
 * `REQUIRE_DOCKER`: the harness gate behind `postgresTest`, or a test that
 * reads it itself. That is the rule the tests use to skip without a
 * database, so a file outside this list runs the same tests with or without
 * one. Relative imports and workspace packages (`@okmodel/*` exports) are
 * followed; other packages are not, since `src/` never reads the gate.
 *
 * @param root - Repository root
 * @param files - Test files, repository-root paths
 * @returns The files that need Postgres, in input order
 */
export function postgresTestFiles(root: string, files: readonly string[]): readonly string[] {
  const workspaces = workspaceExports(root);
  const modules = new Map<string, { readonly gate: boolean; readonly imports: string[] }>();
  const read = (file: string): { readonly gate: boolean; readonly imports: string[] } => {
    const known = modules.get(file);
    if (known !== undefined) return known;
    const source = readFileSync(join(root, file), "utf8");
    const imports: string[] = [];
    for (const match of source.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(root, workspaces, file, match[1] ?? "");
      if (target !== undefined) imports.push(target);
    }
    const module = { gate: POSTGRES_GATE.test(source), imports };
    modules.set(file, module);
    return module;
  };
  return files.filter((file) => {
    const seen = new Set([file]);
    const pending = [file];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const module = read(next);
      if (module.gate) return true;
      for (const target of module.imports) {
        if (seen.has(target)) continue;
        seen.add(target);
        pending.push(target);
      }
    }
    return false;
  });
}

/**
 * `@okmodel/*` package names and their string `exports`, as root paths.
 *
 * @param root - Repository root
 * @returns Package name to subpath (`.`, `./fixtures`) to file
 */
function workspaceExports(root: string): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const packages = new Map<string, Readonly<Record<string, string>>>();
  const dir = join(root, "packages");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return packages;
  }
  for (const entry of entries) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(dir, entry, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null) continue;
    const { name, exports } = manifest as { name?: unknown; exports?: unknown };
    if (typeof name !== "string" || typeof exports !== "object" || exports === null) continue;
    const paths: Record<string, string> = {};
    for (const [subpath, target] of Object.entries(exports)) {
      if (typeof target === "string") paths[subpath] = toRootPath(join("packages", entry, target));
    }
    packages.set(name, paths);
  }
  return packages;
}

function resolveSpecifier(
  root: string,
  workspaces: ReadonlyMap<string, Readonly<Record<string, string>>>,
  from: string,
  specifier: string,
): string | undefined {
  if (specifier.startsWith(".")) {
    const base = join(root, dirname(from), specifier);
    const candidates = [
      base,
      base.replace(/\.([cm]?)js$/, ".$1ts"),
      base.replace(/\.jsx$/, ".tsx"),
      `${base}.ts`,
      join(base, "index.ts"),
    ];
    const found = candidates.find((candidate) => isFile(candidate));
    return found === undefined ? undefined : toRootPath(relative(root, found));
  }
  for (const [name, paths] of workspaces) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    return paths[`.${specifier.slice(name.length)}`];
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toRootPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * FNV-1a over the path's UTF-16 code units.
 *
 * @param path - Repository-root path
 * @returns An unsigned 32-bit hash
 */
function pathHash(path: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The shard for one Postgres file.
 *
 * A file that needs `dist/` goes to {@link POSTGRES_BUILD_SHARD}. A heavy file
 * goes to its pin. Any other file goes where the hash of its path sends it,
 * so adding or deleting a file moves no other file.
 *
 * @param file - Repository-root path
 * @returns The shard that runs it
 */
export function postgresShardOf(file: string): PostgresShard {
  if (postgresFileNeedsBuild(file)) return POSTGRES_BUILD_SHARD;
  const pinned = HEAVY[file];
  if (pinned !== undefined) return pinned;
  return POSTGRES_SHARDS[pathHash(file) % POSTGRES_SHARDS.length] ?? POSTGRES_BUILD_SHARD;
}

/**
 * Puts every Postgres file into exactly one shard.
 *
 * @param files - Files from {@link postgresTestFiles}, repository-root paths
 * @returns One group per shard, in {@link POSTGRES_SHARDS} order
 */
export function assignPostgresShards(files: readonly string[]): readonly PostgresShardGroup[] {
  const buckets = new Map<PostgresShard, string[]>(POSTGRES_SHARDS.map((name) => [name, []]));
  for (const file of files) buckets.get(postgresShardOf(file))?.push(file);
  return POSTGRES_SHARDS.map((name) => ({
    name,
    files: [...(buckets.get(name) ?? [])].sort(),
    needsBuild: name === POSTGRES_BUILD_SHARD,
  }));
}

/**
 * The shards for one checkout.
 *
 * @param root - Repository root
 * @param discovered - Every discovered test file
 * @returns {@link assignPostgresShards} over the files that need Postgres
 */
export function postgresShards(
  root: string,
  discovered: readonly string[],
): readonly PostgresShardGroup[] {
  return assignPostgresShards(postgresTestFiles(root, discovered));
}

if (import.meta.main) {
  const needsBuild = process.argv[2] === "--needs-build";
  const name = needsBuild ? process.argv[3] : process.argv[2];
  if (name === undefined || !isPostgresShard(name)) {
    console.error(
      `usage: bun ./scripts/ci-postgres-shards.ts <${POSTGRES_SHARDS.join("|")}> | --needs-build <shard>`,
    );
    process.exit(1);
  }
  if (needsBuild) {
    process.stdout.write(name === POSTGRES_BUILD_SHARD ? "yes\n" : "no\n");
    process.exit(0);
  }
  const { discoverTestFiles } = await import("./postgres-suite.js");
  const { repoRoot } = await import("./root.js");
  const root = repoRoot();
  const group = postgresShards(root, discoverTestFiles(root)).find((item) => item.name === name);
  if (group === undefined || group.files.length === 0) {
    console.error(`postgres shard ${name} has no files`);
    process.exit(1);
  }
  process.stdout.write(`${group.files.join("\n")}\n`);
}
