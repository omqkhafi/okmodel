/**
 * Decides whether a pull request needs the runtime test matrix, and whether
 * it touches workflow files (which requires the full CI tier).
 *
 * Docs-only, site-only, and docs-plus-site changes do not need the runtime
 * matrix. Any other path does. An empty diff runs the matrix, so a missing
 * range fails closed.
 *
 *   bun ./scripts/ci-paths.ts --base <sha> --head <sha>
 *
 * Writes `runtime=`, `workflows=`, `postgres=`, and `lifecycle=` lines to
 * `GITHUB_OUTPUT` when that file is set, and always prints the same lines.
 * `postgres` is true when the diff touches dialects, migrate, or runtime: the
 * pull request then runs Postgres 18. `lifecycle` is true when the diff
 * touches dialects, migrate, or `tests/lifecycle`: the pull request then runs
 * the migration lifecycle property on Postgres 18.
 */

import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { repoRoot } from "./root.js";

/**
 * Whether the runtime test matrix, Postgres, type-cost, and attest apply.
 *
 * @param paths - Paths from the repository root, as `git diff --name-only` prints them
 * @returns False only when every path is under `docs/` or `site/`
 */
export function runtimeRelevant(paths: readonly string[]): boolean {
  if (paths.length === 0) return true;
  return paths.some((path) => !isDocsPath(path) && !isSitePath(path));
}

/**
 * Whether the diff changes a file under `.github/workflows`.
 *
 * @param paths - Paths from the repository root
 * @returns True when a workflow file changed
 */
export function workflowsChanged(paths: readonly string[]): boolean {
  return paths.some(
    (path) => path === ".github/workflows" || path.startsWith(".github/workflows/"),
  );
}

/**
 * Whether a pull request runs the Postgres 18 suite.
 *
 * The paths are `src/dialects`, `src/runtime`, and `src/tooling/migrate`.
 * The suite is selected by path. A label does not start it.
 *
 * @param paths - Paths from the repository root
 * @returns True when any path is in those trees
 */
export function postgres18Relevant(paths: readonly string[]): boolean {
  return paths.some(
    (path) =>
      path === "src/dialects" ||
      path.startsWith("src/dialects/") ||
      path === "src/runtime" ||
      path.startsWith("src/runtime/") ||
      path === "src/tooling/migrate" ||
      path.startsWith("src/tooling/migrate/"),
  );
}

/**
 * Whether a pull request runs the migration lifecycle property on Postgres 18.
 *
 * The paths are `src/dialects`, `src/tooling/migrate`, and `tests/lifecycle`.
 *
 * @param paths - Paths from the repository root
 * @returns True when any path is in those trees
 */
export function lifecycleRelevant(paths: readonly string[]): boolean {
  return paths.some(
    (path) =>
      path === "src/dialects" ||
      path.startsWith("src/dialects/") ||
      path === "src/tooling/migrate" ||
      path.startsWith("src/tooling/migrate/") ||
      path === "tests/lifecycle" ||
      path.startsWith("tests/lifecycle/"),
  );
}

function isDocsPath(path: string): boolean {
  return path === "docs" || path.startsWith("docs/");
}

function isSitePath(path: string): boolean {
  return path === "site" || path.startsWith("site/");
}

/**
 * File list from `git diff --name-only base...head` (the merge-base range).
 *
 * @param root - Repository root
 * @param base - Base commit
 * @param head - Head commit
 * @returns Paths, without blanks
 */
export function diffPaths(root: string, base: string, head: string): readonly string[] {
  const proc = Bun.spawnSync(["git", "diff", "--name-only", `${base}...${head}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString().trim() || "git diff failed");
  }
  return proc.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function writeOutputs(paths: readonly string[]): void {
  const text =
    `runtime=${runtimeRelevant(paths) ? "true" : "false"}\n` +
    `workflows=${workflowsChanged(paths) ? "true" : "false"}\n` +
    `postgres=${postgres18Relevant(paths) ? "true" : "false"}\n` +
    `lifecycle=${lifecycleRelevant(paths) ? "true" : "false"}\n`;
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined && output.length > 0) appendFileSync(output, text);
  process.stdout.write(text);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { base: { type: "string" }, head: { type: "string" } },
    args: process.argv.slice(2),
    strict: true,
  });
  if (values.base === undefined || values.head === undefined) {
    console.error("usage: bun ./scripts/ci-paths.ts --base <sha> --head <sha>");
    process.exit(1);
  }
  try {
    writeOutputs(diffPaths(repoRoot(), values.base, values.head));
  } catch (error: unknown) {
    console.error("[ci-paths]", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
