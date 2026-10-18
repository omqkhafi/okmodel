/**
 * The local check to run before a push.
 *
 * Format, lint, typecheck, layers, purity, docs, and the readme, then only
 * the tests whose import graph reaches a file changed since the merge-base
 * with `origin/main`. That selection is `bun test --changed`, which Bun
 * 1.4.2 supports (it landed in 1.3.13). A clean diff exits 0.
 *
 *   bun ./scripts/verify-fast.ts
 */

import { repoRoot } from "./root.js";

/** Commands before the changed-test run, in order. */
export const VERIFY_FAST_STEPS: readonly (readonly string[])[] = [
  ["bun", "run", "format:check"],
  ["bun", "run", "lint"],
  ["bun", "run", "typecheck"],
  ["bun", "run", "layers-check"],
  ["bun", "run", "core-purity"],
  ["bun", "run", "bundle-purity"],
  ["bun", "run", "docs:check"],
  ["bun", "run", "readme:check"],
];

/**
 * `bun test --changed` against a commit.
 *
 * `--pass-with-no-tests` keeps a docs-only diff green.
 *
 * @param base - Commit or branch `git diff` compares against
 * @returns The argv, without a shell
 */
export function changedTestCommand(base: string): readonly string[] {
  return ["bun", "test", `--changed=${base}`, "--pass-with-no-tests"];
}

/**
 * Merge-base of `HEAD` and `origin/main`, else `main`, else `HEAD`.
 *
 * @param root - Repository root
 * @returns The commit `--changed` should use
 */
export function verifyFastBase(root: string): string {
  for (const ref of ["origin/main", "main"]) {
    const base = mergeBase(root, ref);
    if (base !== undefined) return base;
  }
  return "HEAD";
}

function mergeBase(root: string, ref: string): string | undefined {
  const proc = Bun.spawnSync(["git", "merge-base", "HEAD", ref], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return undefined;
  const sha = proc.stdout.toString().trim();
  return sha.length > 0 ? sha : undefined;
}

async function run(root: string, command: readonly string[]): Promise<number> {
  console.error(`[verify:fast] ${command.join(" ")}`);
  const proc = Bun.spawn([...command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  return code ?? 1;
}

async function main(): Promise<void> {
  const root = repoRoot();
  for (const step of VERIFY_FAST_STEPS) {
    const code = await run(root, step);
    if (code !== 0) process.exit(code);
  }
  const code = await run(root, changedTestCommand(verifyFastBase(root)));
  process.exit(code);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("[verify:fast]", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
