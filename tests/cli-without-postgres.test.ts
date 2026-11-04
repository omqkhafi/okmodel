/**
 * `okm` in a project whose only driver is not postgres.js (a Neon-only app).
 *
 * The CLI and `okmodel/migrate` are bundled with `postgres` external into a
 * temporary package that has no `postgres`. A command that never connects
 * runs. A command that connects says which package to add.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { repoRoot } from "../scripts/root.js";

let project = "";
let okm = "";

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "okm-no-postgres-"));
  const pkg = join(project, "node_modules", "okmodel");
  const src = join(repoRoot(), "src");
  const built = spawnSync(
    "bun",
    [
      "build",
      join(src, "tooling/cli.ts"),
      join(src, "tooling/migrate/index.ts"),
      join(src, "dialects/pg/index.ts"),
      "--outdir",
      join(pkg, "dist"),
      "--root",
      src,
      "--target",
      "node",
      "--format",
      "esm",
      "--splitting",
      "--external",
      "postgres",
    ],
    { encoding: "utf8" },
  );
  expect(built.status, built.stderr).toBe(0);
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "okmodel",
      version: "0.0.0-test",
      type: "module",
      exports: {
        "./pg": "./dist/dialects/pg/index.js",
        "./migrate": "./dist/tooling/migrate/index.js",
      },
    }),
  );
  okm = join(pkg, "dist", "tooling", "cli.js");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  writeFileSync(
    join(project, "schema.ts"),
    [
      'import { schema, table, t } from "okmodel/pg";',
      'export const notes = table("notes", { id: t.identity(), title: t.text() });',
      "export default schema({ tables: [notes] });",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(project, "okmodel.config.ts"),
    [
      'import { defineConfig } from "okmodel/migrate";',
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      '  database: "postgres://okm:okm@127.0.0.1:1/okm",',
      "});",
      "",
    ].join("\n"),
  );
  mkdirSync(join(project, "migrations"), { recursive: true });
}, 60_000);

afterAll(() => {
  if (project !== "") rmSync(project, { recursive: true, force: true });
});

function runOkm(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [okm, ...args], { cwd: project, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("okm generate init runs without the postgres package", () => {
  const result = runOkm("generate", "init");
  expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(project, "migrations", "0001_init.sql"))).toBe(true);
}, 30_000);

test("a command that connects names the postgres package and the install command", () => {
  const result = runOkm("migrate", "status");
  expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("okm needs the postgres package to connect to a database.");
  expect(result.stderr).toContain("bun add -d postgres");
}, 30_000);

test("--json reports the same setup error in the envelope", () => {
  const result = runOkm("push", "--json");
  expect(result.status).toBe(2);
  const doc = JSON.parse(result.stdout) as {
    readonly errors: readonly { readonly summary: string; readonly fix: string }[];
  };
  expect(doc.errors[0]?.summary).toContain("postgres package");
  expect(doc.errors[0]?.fix).toContain("bun add -d postgres");
}, 30_000);
