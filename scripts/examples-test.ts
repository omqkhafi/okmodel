/**
 * Installs each framework example and runs its tests against the topology.
 *
 *   bun ./scripts/examples-test.ts
 *
 * Requires `dist/` (run `bun run build` first) and Postgres (`bun run db:up`).
 * Set `OKM_EXAMPLES_NIGHTLY=1` and Neon credentials for the Workers live test.
 * Each example gets a `node_modules/okmodel` symlink to the repository root so
 * framework deps stay out of the root lockfile.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./root.js";

const EXAMPLES = ["express", "hono", "nextjs", "tanstack-start", "workers-neon"] as const;

const root = repoRoot();

if (!existsSync(join(root, "dist/contracts/index.js"))) {
  console.error("examples-test: dist/ missing; run bun run build first");
  process.exit(1);
}

for (const name of EXAMPLES) {
  const dir = join(root, "examples", name);
  console.log(`\n[examples] install ${name}`);
  const install = Bun.spawnSync(["bun", "install"], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  if (install.exitCode !== 0) {
    console.error(`[examples] install failed: ${name}`);
    process.exit(install.exitCode ?? 1);
  }
}

const testFiles = EXAMPLES.map((name) => join("examples", name, `${name}.test.ts`));
console.log(`\n[examples] bun test ${testFiles.join(" ")}`);
const started = Date.now();
const test = Bun.spawnSync(["bun", "test", ...testFiles], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    REQUIRE_DOCKER: process.env.REQUIRE_DOCKER ?? "1",
  },
});
const elapsedMs = Date.now() - started;
console.log(`[examples] finished in ${(elapsedMs / 1000).toFixed(1)}s`);
process.exit(test.exitCode ?? 1);
