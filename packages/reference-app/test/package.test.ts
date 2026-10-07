/**
 * The app compiles against the `okmodel` it resolves, and the tarball job uses the tarball.
 *
 * The declarations are the built ones (`dist/*.d.ts`), so this runs after
 * `bun run build`, or on the packed package in the tarball job.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

import { appDir, okmodelRoot } from "./support.js";

test("the reference app typechecks against the okmodel declarations it resolves", () => {
  const proc = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", join(appDir, "tsconfig.json")], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.stdout.toString() + proc.stderr.toString()).toBe("");
  expect(proc.exitCode).toBe(0);
}, 60_000);

test("okmodel resolves from the tarball when the tarball job runs the app", () => {
  const fromTarball = join(appDir, "node_modules", "okmodel");
  if (process.env.OKMODEL_REFERENCE_TARBALL === "1") {
    expect(okmodelRoot()).toBe(fromTarball);
  } else {
    expect(okmodelRoot()).not.toBe(fromTarball);
  }
});
