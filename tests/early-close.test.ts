/**
 * Closing a client before it connects leaves no unhandled rejection (QA-M5).
 *
 * Each child process closes at once against a refused port, waits for
 * `connected`, and exits. The parent checks the exit code, the outcome text,
 * and that stderr is empty. The Node child loads `dist/`; `bun run build`
 * writes it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "bun:test";

const root = process.cwd();

async function run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr };
}

test("bun: an early close leaves the connect error on connected and no unhandled rejection", async () => {
  const outcome = await run(["bun", "tests/early-close.worker.ts"]);
  expect(outcome.code).toBe(0);
  expect(outcome.stderr).not.toContain("nhandled");
  expect(outcome.stdout.startsWith("rejected:unavailable:")).toBe(true);
  expect(outcome.stdout).toContain("closed before it connected");
});

test("node: an early close from dist leaves no unhandled rejection", async () => {
  if (!existsSync(join(root, "dist/runtime/pg/postgresjs.js"))) {
    throw new Error("dist/runtime/pg/postgresjs.js is missing. bun run build writes it.");
  }
  const outcome = await run(["node", "tests/early-close.node.mjs"]);
  expect(outcome.code).toBe(0);
  expect(outcome.stderr).not.toContain("nhandled");
  expect(outcome.stdout.startsWith("rejected:unavailable:")).toBe(true);
  expect(outcome.stdout).toContain("closed before it connected");
});
