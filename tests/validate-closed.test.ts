/**
 * OKM1201 from `okm check`, and a failed engine import.
 *
 * The import failure runs in a child process so the mock cannot reach the suite.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OkmError } from "../src/contracts/error.js";
import { repoRoot } from "../scripts/root.js";
import { checkProject } from "../src/tooling/migrate/project.js";

test("okm check reports OKM1201 when validation is on and the project never imports it", async () => {
  const missing = await project(
    `export const app = schema({
      validation: true,
      tables: [table("tasks", { id: identity(), title: text() })],
    });`,
  );
  await expectClosed(missing);

  const typed = await project(
    `export const app = schema({
      validation: true,
      tables: [table("tasks", { id: identity(), title: text() })],
    });`,
    { "types.ts": 'import type { Rule } from "okmodel/validate";\nexport type Unused = Rule;\n' },
  );
  await expectClosed(typed);

  const comment = await project(
    `export const app = schema({
      validation: true,
      tables: [table("tasks", { id: identity(), title: text() })],
    });`,
    { "note.ts": '// import "okmodel/validate"\nexport const note = true;\n' },
  );
  await expectClosed(comment);

  const inline = await project(
    `export const app = schema({
      tables: [table("tasks", { id: identity(), title: text().validate([]) })],
    });`,
  );
  await expectClosed(inline);

  const section = await project(
    `export const app = schema({
      tables: [table("tasks", { id: identity(), title: text() }, { validate: { title: [] } })],
    });`,
  );
  await expectClosed(section);

  const present = await project(
    `export const app = schema({
      validation: true,
      tables: [table("tasks", { id: identity(), title: text() })],
    });`,
    { "app.ts": 'import { v } from "okmodel/validate";\nvoid v;\n' },
  );
  const disabled = await project(
    `export const app = schema({
      validation: false,
      tables: [table("tasks", { id: identity(), title: text() })],
    });`,
  );
  try {
    await checkProject(present);
    await checkProject(disabled);
  } finally {
    rmSync(present, { recursive: true, force: true });
    rmSync(disabled, { recursive: true, force: true });
  }
});

test("a failed validation engine import rejects before a query runs", async () => {
  const proc = Bun.spawn(["bun", "tests/validate-engine-miss.worker.ts"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

async function expectClosed(cwd: string): Promise<void> {
  let failed: OkmError | undefined;
  try {
    await checkProject(cwd);
  } catch (error) {
    if (error instanceof OkmError) failed = error;
    else throw error;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  expect(failed?.code).toBe("OKM1201");
  expect(failed?.category).toBe("input");
  expect(failed?.message).toBe("Validation is enabled but `okmodel/validate` was not imported.");
}

async function project(
  body: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<string> {
  const root = repoRoot();
  const cwd = mkdtempSync(join(tmpdir(), "okm-closed-"));
  const header = `import { identity, schema, table, text } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};\n`;
  writeFileSync(join(cwd, "schema.ts"), `${header}${body}\n`);
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
      'export default defineConfig({ schema: "./schema.ts" });',
      "",
    ].join("\n"),
  );
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(cwd, name), text);
  return cwd;
}
