import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function buildRunner(root: string): string {
  const entry = join(import.meta.dir, "..", "packages", "harness", "src", "driver-run.ts");
  const built = Bun.spawnSync({
    cmd: [
      "bun",
      "build",
      entry,
      "--outdir",
      root,
      "--format",
      "esm",
      "--target",
      "node",
      "--splitting",
      "--chunk-naming=shared/[hash].js",
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
  return join(root, "driver-run.js");
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

test("the packed bun driver loads its chunk and maps the pool config", () => {
  const outfile = buildRunner(scratch());
  const built = readFileSync(outfile, "utf8");
  const source = readFileSync(
    join(import.meta.dir, "..", "packages", "harness", "src", "driver-run.ts"),
    "utf8",
  );
  const branch = source.slice(
    source.indexOf('typeof Bun === "undefined"'),
    source.indexOf("function networked"),
  );
  const specs = [...built.matchAll(/import\("(\.\/shared\/[^"]+\.js)"\)/g)].map(
    (match) => match[1] ?? "",
  );
  expect(built.includes('from "bun"')).toBe(false);
  expect(specs.length).toBeGreaterThan(0);
  for (const spec of specs) expect(existsSync(join(outfile, "..", spec))).toBe(true);
  const shared = join(outfile, "..", "shared");
  const bunChunk = readdirSync(shared).find((name) =>
    readFileSync(join(shared, name), "utf8").includes('from "bun"'),
  );
  expect(bunChunk).toBeTruthy();
  expect(branch).toContain("url: config.url ?? url");
  expect(branch).toContain("searchPath: config.schema");
  expect(branch).toContain("timeouts: config.timeouts");
  const packed = join(import.meta.dir, "..", "dist", "tooling", "driver-run.js");
  expect(existsSync(packed)).toBe(true);
  expect(readFileSync(packed, "utf8").includes('from "bun"')).toBe(false);
});

test("the packed runner does not statically import bun", () => {
  const outfile = buildRunner(scratch());
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
