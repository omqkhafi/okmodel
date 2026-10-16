/**
 * Preview recipe on an empty database (D279, §19.8).
 *
 * Apply installs the head snapshot. Seed runs after it. The action script
 * refuses a missing target and does not create or drop a database.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../src/adapters/pg/postgresjs.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { listenPostgres } from "./doc-run.js";

const root = repoRoot();

test("apply --target preview installs the head snapshot and seed runs", async () => {
  const server = await listenPostgres();
  const cwd = writeProject(server.url);
  try {
    await run(["generate", "init"], { cwd, stdout: () => undefined });
    const applied: string[] = [];
    await run(["migrate", "apply", "--target", "preview"], {
      cwd,
      stdout: (text) => applied.push(text),
    });
    expect(applied.join("")).toContain("applied provisioned@");
    const seeded: string[] = [];
    await run(["seed", "seed.ts", "--target", "preview"], {
      cwd,
      stdout: (text) => seeded.push(text),
    });
    expect(seeded.join("")).toContain("notes 1");
    const pool = open({ url: server.url, max: 1 });
    try {
      const count = await pool.execute('select count(*)::text from "public"."notes"');
      expect(count.rows[0]?.[0]).toBe("1");
    } finally {
      await pool.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await server.close();
  }
}, 60_000);

test("the action refuses a blank target and never creates or drops a database", () => {
  const script = readFileSync(join(root, ".github/actions/migrate/run.sh"), "utf8");
  expect(script).toContain('migrate apply --target "$target"');
  expect(script).not.toContain("--target preview");
  expect(script.toLowerCase()).not.toContain("createdb");
  expect(script.toLowerCase()).not.toContain("drop database");
  const result = Bun.spawnSync(["bash", join(root, ".github/actions/migrate/run.sh")], {
    env: { ...process.env, INPUT_TARGET: "   ", INPUT_PREVIEW: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("error OKM1853: --target needs a name.");
  expect(result.stdout.toString()).not.toContain("migrate apply");
});

function writeProject(url: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-preview-"));
  const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
  const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));
  writeFileSync(
    join(cwd, "schema.ts"),
    `import { id, schema, table, text } from ${pg};\nexport const app = schema({ tables: [table("notes", { id: id({ default: "none" }), title: text() })] });\n`,
  );
  writeFileSync(
    join(cwd, "seed.ts"),
    [
      "export default async function seed(t: {",
      "  factories(definitions: {",
      "    notes(x: { words(count: number): string }): { title: string };",
      "  }): { notes: { create(): Promise<unknown> } };",
      "}): Promise<void> {",
      "  const factories = t.factories({ notes: (x) => ({ title: x.words(2) }) });",
      "  await factories.notes.create();",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      "  targets: {",
      `    preview: { url: ${JSON.stringify(url)} },`,
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}
