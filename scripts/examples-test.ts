/**
 * Installs each framework example and runs its tests against the topology.
 *
 *   bun ./scripts/examples-test.ts
 *
 * Requires `dist/` (run `bun run build` first) and Postgres (`bun run db:up`).
 * Set `OKM_EXAMPLES_NIGHTLY=1` and Neon credentials for the Workers live test.
 * Each example gets a `node_modules/okmodel` symlink to the repository root so
 * framework deps stay out of the root lockfile.
 *
 * Tests run with `cwd` set to the example directory so the root `bunfig.toml`
 * `pathIgnorePatterns` for `examples/**` (which keeps `bun test --changed`
 * out of these apps) does not hide the files.
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

const started = Date.now();
let failed = false;

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

  console.log(`[examples] bun test ./${name}.test.ts (cwd examples/${name})`);
  const test = Bun.spawnSync(["bun", "test", `./${name}.test.ts`], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      REQUIRE_DOCKER: process.env.REQUIRE_DOCKER ?? "1",
    },
  });
  if (test.exitCode !== 0) {
    failed = true;
    console.error(`[examples] test failed: ${name}`);
  }
}

const elapsedMs = Date.now() - started;
console.log(`[examples] finished in ${(elapsedMs / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
