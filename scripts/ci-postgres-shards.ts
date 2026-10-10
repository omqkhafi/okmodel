/**
 * Shards for the Postgres suite jobs.
 *
 * Every discovered test file belongs to one shard. A labelled pull request
 * runs one job per shard per Postgres major, each with its own topology, so
 * the files that stall one database run at the same time. Local
 * `postgres-suite.ts` without `--shard` still runs every file.
 *
 *   bun ./scripts/ci-postgres-shards.ts isolation
 *   bun ./scripts/ci-postgres-shards.ts --needs-build tx
 *
 * The first prints that shard's files, one path per line. The second prints
 * `yes` when the shard executes tests that import `dist/`.
 */

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
 * Files that held the runner while nothing else started, on labelled run
 * 38069113040 (`suite / 18`, Postgres suite step 626s). The number is that
 * stall, and the four longest sit on four shards.
 */
const HEAVY: Readonly<Record<string, PostgresShard>> = {
  "tests/isolation.property.test.ts": "isolation",
  "tests/compatibility.test.ts": "isolation",
  "tests/archive-gate.property.test.ts": "isolation",
  "tests/presets.test.ts": "isolation",
  "tests/topology.test.ts": "isolation",
  "tests/selection.test.ts": "selection",
  "tests/driver-suite.test.ts": "selection",
  "tests/replica-unreachable-pg.test.ts": "selection",
  "tests/migrate-check-pg.test.ts": "selection",
  "tests/replication.test.ts": "selection",
  "tests/consistency.test.ts": "consistency",
  "tests/topology-conformance.test.ts": "consistency",
  "tests/statements.shape.test.ts": "consistency",
  "tests/error-suite.test.ts": "consistency",
  "tests/presets.property.test.ts": "consistency",
  "tests/tx-suite.test.ts": "tx",
  "tests/routing.test.ts": "tx",
  "tests/testing.test.ts": "tx",
  "tests/gate-sensitivity.test.ts": "tx",
  "tests/fixtures-schema.test.ts": "tx",
  "tests/harness.test.ts": "tx",
};

/**
 * Files that need the built package and are not under `packages/reference-app/`.
 *
 * A reference-app test always lands on {@link POSTGRES_BUILD_SHARD} by prefix.
 */
const BUILD_FILES: ReadonlySet<string> = new Set([
  "tests/client-close.test.ts",
  "tests/early-close.test.ts",
  "tests/package.test.ts",
  "tests/quickstart.test.ts",
  "tests/recipes.test.ts",
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
 * Files pinned to a shard because they dominated the suite step.
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

/**
 * Deals every file into exactly one shard.
 *
 * A file that needs `dist/` goes to {@link POSTGRES_BUILD_SHARD}. A heavy
 * file goes to its pin. The rest are dealt in sorted order across
 * {@link POSTGRES_SHARDS}, so a new file has a stable shard.
 *
 * @param files - Discovered test files, repository-root paths
 * @returns One group per shard, in {@link POSTGRES_SHARDS} order
 */
export function assignPostgresShards(files: readonly string[]): readonly PostgresShardGroup[] {
  const buckets = new Map<PostgresShard, string[]>(POSTGRES_SHARDS.map((name) => [name, []]));
  const rest: string[] = [];
  for (const file of files) {
    if (postgresFileNeedsBuild(file)) {
      buckets.get(POSTGRES_BUILD_SHARD)?.push(file);
      continue;
    }
    const pinned = HEAVY[file];
    if (pinned !== undefined) {
      buckets.get(pinned)?.push(file);
      continue;
    }
    rest.push(file);
  }
  rest.sort();
  for (let index = 0; index < rest.length; index += 1) {
    const file = rest[index];
    const name = POSTGRES_SHARDS[index % POSTGRES_SHARDS.length];
    if (file === undefined || name === undefined) continue;
    buckets.get(name)?.push(file);
  }
  return POSTGRES_SHARDS.map((name) => ({
    name,
    files: [...(buckets.get(name) ?? [])].sort(),
    needsBuild: name === POSTGRES_BUILD_SHARD,
  }));
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
  const group = assignPostgresShards(discoverTestFiles(repoRoot())).find(
    (item) => item.name === name,
  );
  if (group === undefined || group.files.length === 0) {
    console.error(`postgres shard ${name} has no files`);
    process.exit(1);
  }
  process.stdout.write(`${group.files.join("\n")}\n`);
}
