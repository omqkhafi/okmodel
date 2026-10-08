/**
 * Runs every test file against the Docker Postgres topology.
 *
 * The file list is discovered. `POSTGRES_EXCLUSIONS` is the only place a file
 * may be left out, and each entry says why. `POSTGRES_KNOWN_FAILURES` names a
 * file that fails on a major, with the reason. The suite still runs that file.
 * A known failure that starts passing fails the run.
 *
 *   REQUIRE_DOCKER=1 bun ./scripts/postgres-suite.ts
 */

import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { postgresVersionFromEnv, type PostgresVersion } from "../packages/harness/src/version.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { repoRoot } from "./root.js";

/** A test file the Docker run does not execute, and why. */
export type PostgresExclusion = {
  /** Path from the repository root, with `/` separators. */
  readonly file: string;
  /** Why this file cannot run against the topology. */
  readonly reason: string;
};

/**
 * Files the Docker run does not execute.
 *
 * Every current test file can run on the topology, so this list is empty.
 * A new omission goes here with its reason. A path in this list is not run.
 */
export const POSTGRES_EXCLUSIONS: readonly PostgresExclusion[] = [];

/** A test file that fails on one or more majors, and why. */
export type PostgresKnownFailure = {
  /** Path from the repository root, with `/` separators. */
  readonly file: string;
  /** Majors on which the file is expected to fail. */
  readonly versions: readonly PostgresVersion[];
  /** What the failure is. The product code is left as it is. */
  readonly reason: string;
};

/**
 * Files that fail on a listed major.
 *
 * The suite runs them and requires a non-zero exit. On any other major they
 * join the passing set.
 */
export const POSTGRES_KNOWN_FAILURES: readonly PostgresKnownFailure[] = [];

/** Which files the suite runs, skips, and expects to fail. */
export type PostgresSuitePlan = {
  readonly version: PostgresVersion;
  /** Discovered files that must pass. */
  readonly run: readonly string[];
  /** Files named in {@link POSTGRES_EXCLUSIONS}. */
  readonly excluded: readonly PostgresExclusion[];
  /** Files that must fail on this major. */
  readonly known: readonly PostgresKnownFailure[];
};

const TEST_FILE = /(?:\.test|\.spec|_test)\.[cm]?[jt]sx?$/;

/**
 * Test files Bun would pick up, as paths relative to `root`.
 *
 * @param root - Repository root
 * @returns Sorted relative paths
 */
export function discoverTestFiles(root: string): readonly string[] {
  const files: string[] = [];
  walk(root, root, files);
  files.sort();
  return files;
}

/**
 * Splits the discovered files for one Postgres major.
 *
 * @param root - Repository root
 * @param version - Major the topology is running
 * @returns The plan for that major
 */
export function postgresSuitePlan(root: string, version: PostgresVersion): PostgresSuitePlan {
  const excluded = new Set(POSTGRES_EXCLUSIONS.map((item) => item.file));
  const known = POSTGRES_KNOWN_FAILURES.filter((item) => item.versions.includes(version));
  const knownFiles = new Set(known.map((item) => item.file));
  const run: string[] = [];
  for (const file of discoverTestFiles(root)) {
    if (excluded.has(file) || knownFiles.has(file)) continue;
    run.push(file);
  }
  return { version, run, excluded: POSTGRES_EXCLUSIONS, known };
}

function walk(root: string, dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(root, path, files);
      continue;
    }
    if (info.isFile() && TEST_FILE.test(entry)) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
}

/**
 * A TCP probe of the topology primary. A refused connection means every
 * Postgres test in the run will skip.
 *
 * @param url - `postgres://` URL of the primary
 * @returns False when nothing listens
 */
export async function postgresReachable(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  if (!Number.isInteger(port)) return false;
  try {
    const socket = await Bun.connect({
      hostname: parsed.hostname,
      port,
      socket: {
        data() {},
        error() {},
      },
      // Bun.connect has no timeout option; the race below bounds the probe.
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fails the suite on CI when no database listens; otherwise says so loudly.
 *
 * A `DATABASE_URL` pointing at an existing server is orthogonal: the probe
 * only reads the topology primary, and nothing about `DATABASE_URL` changes.
 *
 * @param files - How many files the plan would run
 */
async function preflightPostgres(files: number): Promise<void> {
  const url = primaryUrl();
  const probe = postgresReachable(url);
  // A hung probe must not surface as an unhandled rejection after the race.
  probe.catch(() => {});
  const status = await Promise.race([
    probe.then((ok): "up" | "down" => (ok ? "up" : "down")),
    Bun.sleep(2_000).then((): "slow" => "slow"),
  ]);
  if (status === "up") return;
  console.error(
    `[postgres-suite] Postgres is not reachable at ${url}: ` +
      `${String(files)} files would run with every Postgres test SKIPPED.`,
  );
  if (process.env.CI === "true") {
    console.error("[postgres-suite] CI=true: failing instead of running a skipped Postgres suite.");
    process.exit(1);
  }
}

async function runBunTest(
  root: string,
  files: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const proc = Bun.spawn(["bun", "test", ...files], {
    cwd: root,
    env: { ...process.env, REQUIRE_DOCKER: "1", ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code === null) throw new Error("bun test did not exit");
  return code;
}

/**
 * Counts the skipped Postgres tests the children recorded.
 *
 * Each `postgresTest` skip appends one byte to `path`. The count is exact:
 * only harness-gated Postgres skips write it, never a bare `test.skip`.
 *
 * @param path - Counter file the children shared
 * @returns Skipped Postgres tests
 */
export function readSkipCount(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").length - 1;
  } catch {
    return 0;
  }
}

if (import.meta.main) {
  const root = repoRoot();
  const plan = postgresSuitePlan(root, postgresVersionFromEnv());
  console.error(
    `[postgres-suite] Postgres ${plan.version}: ${String(plan.run.length)} files, ${String(plan.excluded.length)} excluded, ${String(plan.known.length)} known failures`,
  );
  await preflightPostgres(plan.run.length);
  for (const item of plan.excluded) {
    console.error(`[postgres-suite] excluded ${item.file}: ${item.reason}`);
  }
  if (plan.run.length === 0) {
    console.error("[postgres-suite] no files to run");
    process.exit(1);
  }
  const scratch = mkdtempSync(join(tmpdir(), "okm-postgres-skips-"));
  const skipFile = join(scratch, "skips");
  const childEnv = { OKM_POSTGRES_SKIP_FILE: skipFile };
  let code = await runBunTest(root, plan.run, childEnv);
  let unexpectedPass: string | undefined;
  if (code === 0) {
    for (const item of plan.known) {
      console.error(`[postgres-suite] known failure ${item.file}: ${item.reason}`);
      const failed = await runBunTest(root, [item.file], childEnv);
      if (failed === 0) {
        unexpectedPass = item.file;
        code = 1;
        break;
      }
    }
  }
  const skipped = readSkipCount(skipFile);
  rmSync(scratch, { recursive: true, force: true });
  if (skipped > 0) console.error(`${String(skipped)} Postgres tests SKIPPED`);
  if (unexpectedPass !== undefined) {
    console.error(
      `[postgres-suite] ${unexpectedPass} passed on Postgres ${plan.version}. Remove it from POSTGRES_KNOWN_FAILURES.`,
    );
  }
  if (code !== 0) process.exit(code);
}
