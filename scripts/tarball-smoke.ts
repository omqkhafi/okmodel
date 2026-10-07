/**
 * Packs the repository and runs the README, the quickstart, and the reference app on Docker Postgres.
 *
 * `tests/quickstart.test.ts` installs the tarball in a fresh directory and runs
 * `okm push`, `okm generate` plus `okm migrate apply`, and the run script. Then
 * the tarball is extracted to `packages/reference-app/node_modules/okmodel`, so
 * the reference app resolves `okmodel` from the packed files, and its suite
 * runs. The wire server stays in `check`.
 *
 *   REQUIRE_DOCKER=1 bun ./scripts/tarball-smoke.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { pack } from "../tests/doc-run.js";
import { repoRoot } from "./root.js";

if (import.meta.main) {
  const root = repoRoot();
  const env = { ...process.env, REQUIRE_DOCKER: "1" };
  await run(["bun", "test", "tests/quickstart.test.ts"], root, env);

  const given = process.env.OKMODEL_TARBALL;
  const tarball = given === undefined || given === "" ? pack(root) : given;
  const target = join(root, "packages", "reference-app", "node_modules", "okmodel");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  try {
    await run(["tar", "-xzf", tarball, "-C", target, "--strip-components=1"], root, env);
    await run(["bun", "test", "packages/reference-app"], root, {
      ...env,
      OKMODEL_REFERENCE_TARBALL: "1",
    });
  } finally {
    rmSync(target, { recursive: true, force: true });
    if (tarball !== given) rmSync(tarball, { force: true });
  }
}

async function run(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const proc = Bun.spawn([...args], { cwd, env, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${String(code)}`);
}
