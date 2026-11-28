/**
 * The watch fallback when `process.getBuiltinModule` is missing.
 *
 * Node 22.18 (the package floor) has `getBuiltinModule` — it has since 22.3.
 * This process hides it. `stop()` from inside the handler then keeps the
 * outside wait. The child has a timeout so a deadlock fails the test.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";

test("stop inside the handler waits when AsyncLocalStorage cannot be read", () => {
  const proc = Bun.spawnSync(["bun", join(repoRoot(), "tests/watch-stop-fallback.worker.ts")], {
    cwd: repoRoot(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  expect(proc.exitCode, out).toBe(0);
});
