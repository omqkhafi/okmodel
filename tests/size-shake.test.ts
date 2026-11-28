/**
 * Startup-only shake checks.
 *
 * Traits, tenancy, and the clock are read from the startup chunks. A lazy
 * `scope-pool` chunk is not a failure. A static tenancy import is.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoRoot } from "../scripts/root.js";
import {
  measureSingleFileConnect,
  shakenOperatorProblems,
  SINGLE_FILE_CONNECT_METHOD,
} from "../scripts/size.js";

const root = repoRoot();

test("a featureless app does not keep tenancy on the startup graph", () => {
  expect(shakenOperatorProblems(root)).toEqual([]);
}, 60_000);

test("a static tenancy import fails the startup check", () => {
  const dir = mkdtempSync(join(tmpdir(), "okm-tenancy-"));
  const pg = join(root, "src/dialects/pg/index.ts");
  const connectFrom = join(root, "src/runtime/pg/postgresjs.ts");
  const tenancy = join(root, "src/runtime/tenancy/index.ts");
  writeFileSync(
    join(dir, "app.ts"),
    [
      `import { eq, schema, table, text } from ${JSON.stringify(pg)};`,
      `import { connect } from ${JSON.stringify(connectFrom)};`,
      `import { columnTenancy } from ${JSON.stringify(tenancy)};`,
      'const users = table("users", { email: text() });',
      "export const app = schema({ tables: [users] });",
      "export const tenancy = columnTenancy;",
      "export function read(url: string) {",
      "  const db = connect(url, { schema: app });",
      '  return db.users.find({ where: { email: eq("a@b.c") }, limit: 1 });',
      "}",
      "",
    ].join("\n"),
  );
  try {
    const problems = shakenOperatorProblems(dir, "app.ts");
    expect(problems.some((problem) => problem.includes("okmodel/tenancy"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("the single-file connect bundle lists the catalog compiler", () => {
  const measured = measureSingleFileConnect(root);
  expect(measured.method).toBe(SINGLE_FILE_CONNECT_METHOD);
  expect(measured.minBytes).toBeGreaterThan(0);
  expect(measured.gzipBytes).toBeGreaterThan(0);
  expect(measured.gzipBytes).toBeLessThan(measured.minBytes);
  expect(measured.compilerInputs.some((file) => file.includes("catalog-compile"))).toBe(true);
});
