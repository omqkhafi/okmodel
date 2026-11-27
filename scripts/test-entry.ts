/**
 * Local `bun test` entry.
 *
 * Prints one stderr line when `bun --version` is not the pin in
 * `.bun-version`, then runs `bun test` with the same arguments.
 * CI calls `bun test` directly and does not go through this file.
 *
 *   bun ./scripts/test-entry.ts
 *   bun ./scripts/test-entry.ts tests/foo.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";
import { bunPinWarning } from "./verify-fast.js";

const root = repoRoot();
try {
  const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
  const warning = bunPinWarning(Bun.version, pinned, "bun test");
  if (warning !== undefined) console.error(warning);
} catch {
  // A missing pin is reported by verify:fast. This entry stays on the tests.
}

const proc = Bun.spawnSync(["bun", "test", ...process.argv.slice(2)], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(proc.exitCode ?? 1);
