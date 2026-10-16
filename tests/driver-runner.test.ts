import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, expect } from "bun:test";

import { driverRunnerPath } from "../src/tooling/driver-test.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "okm-driver-runner-"));
  roots.push(root);
  return root;
}

test("a shared chunk finds driver-run.js under dist/tooling", () => {
  const root = scratch();
  const shared = join(root, "dist", "shared");
  const tooling = join(root, "dist", "tooling");
  mkdirSync(shared, { recursive: true });
  mkdirSync(tooling, { recursive: true });
  writeFileSync(join(tooling, "driver-run.js"), "");
  expect(driverRunnerPath(shared)).toBe(join(tooling, "driver-run.js"));
});

test("a file beside the module is the runner when the source tree is absent", () => {
  const here = scratch();
  writeFileSync(join(here, "driver-run.js"), "");
  expect(driverRunnerPath(here)).toBe(join(here, "driver-run.js"));
});

test("the packed runner does not statically import bun", async () => {
  const root = scratch();
  const outfile = join(root, "driver-run.js");
  const entry = join(import.meta.dir, "..", "packages", "harness", "src", "driver-run.ts");
  const built = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      entry,
      "--outfile",
      outfile,
      "--format",
      "esm",
      "--target",
      "node",
      "--external",
      "postgres",
      "--external",
      "@electric-sql/pglite",
      "--external",
      "pg",
      "--external",
      "bun",
      "--external",
      "@neondatabase/serverless",
    ],
    cwd: join(import.meta.dir, ".."),
  });
  expect(built.exitCode).toBe(0);
  expect(readFileSync(outfile, "utf8").includes('from "bun"')).toBe(false);
});

test("a source checkout prefers driver-run.ts", () => {
  const root = scratch();
  const here = join(root, "src", "tooling");
  const source = join(root, "packages", "harness", "src", "driver-run.ts");
  mkdirSync(here, { recursive: true });
  mkdirSync(join(root, "packages", "harness", "src"), { recursive: true });
  writeFileSync(source, "");
  writeFileSync(join(here, "driver-run.js"), "");
  expect(driverRunnerPath(here)).toBe(source);
});
