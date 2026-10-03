/**
 * Packs the repository and runs the README and the quickstart on Docker Postgres.
 *
 * `tests/quickstart.test.ts` is that run: with `REQUIRE_DOCKER=1` it installs
 * the tarball in a fresh directory and runs `okm push`, `okm generate` plus
 * `okm migrate apply`, and the run script. The wire server stays in `check`.
 *
 *   REQUIRE_DOCKER=1 bun ./scripts/tarball-smoke.ts
 */

import { repoRoot } from "./root.js";

if (import.meta.main) {
  const proc = Bun.spawn(["bun", "test", "tests/quickstart.test.ts"], {
    cwd: repoRoot(),
    env: { ...process.env, REQUIRE_DOCKER: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code === null) throw new Error("bun test did not exit");
  process.exit(code);
}
