/**
 * Cycle-2 coverage that used to live only in QA scripts (DM-1 to DM-12,
 * B-07, B-08): doctor codes, okm dev, backfill step numbering, and the
 * known-limits honesty statements.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failedAt } from "../src/runtime/compat-words.js";
import { run } from "../src/tooling/migrate/commands.js";
import { doctorProject } from "../src/tooling/migrate/doctor.js";
import { repoRoot } from "../scripts/root.js";

const root = repoRoot();

test("okm doctor explains OKM1401 and OKM1210 without a project", async () => {
  const outcome = await doctorProject(root, "OKM1401");
  expect(outcome).toContain("OKM1401");
  expect(outcome.toLowerCase()).toMatch(/outcome|commit|never arrived|unknown/);

  const temporal = await doctorProject(root, "OKM1210");
  expect(temporal).toContain("OKM1210");
  expect(temporal).toContain("Temporal");
});

test("okm doctor lists triggers for a project with none", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-dm-doctor-"));
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'const notes = table("notes", { id: t.text().primaryKey(), title: t.text() });',
        "export default schema({ tables: [notes] });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        'export default defineConfig({ schema: "./schema.ts", migrations: "./migrations" });',
        "",
      ].join("\n"),
    );
    expect(await doctorProject(cwd, undefined)).toBe("no triggers\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("okm dev creates .okm/dev-db without watching or applying", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "okm-dm-dev-"));
  try {
    writeFileSync(
      join(cwd, "schema.ts"),
      [
        `import { schema, table, t } from ${JSON.stringify(join(root, "src/dialects/pg/index.ts"))};`,
        'const notes = table("notes", { id: t.text().primaryKey() });',
        "export default schema({ tables: [notes] });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, "okmodel.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(join(root, "src/tooling/migrate/index.ts"))};`,
        'export default defineConfig({ schema: "./schema.ts", migrations: "./migrations" });',
        "",
      ].join("\n"),
    );
    const lines: string[] = [];
    await run(["dev"], { cwd, stdout: (text) => lines.push(text) });
    const printed = lines.join("");
    expect(printed).toContain("dev-db");
    expect(existsSync(join(cwd, ".okm", "dev-db"))).toBe(true);
    expect(printed.toLowerCase()).not.toContain("watch");
    expect(printed.toLowerCase()).not.toContain("applied");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("okm dev --help no longer claims a schema watch", async () => {
  const lines: string[] = [];
  await run(["dev", "--help"], { stdout: (text) => lines.push(text) });
  const help = lines.join("");
  expect(help).toContain("dev");
  expect(help).not.toContain("Watch the schema and reload.");
  expect(help.toLowerCase()).toMatch(/pglite|dev-db|target/);
});

test("status failedAt stays 0-based; apply messages are 1-based", () => {
  expect(failedAt(0)).toBe("failed at step 0 (resume with okm migrate apply)");
  expect(failedAt(1)).toBe("failed at step 1 (resume with okm migrate apply)");
  const runner = readFileSync(join(root, "src/tooling/migrate/runner.ts"), "utf8");
  expect(runner).toContain("step ${String(item.index + 1)}");
  expect(runner).toContain("failed at step ${String(index + 1)}");
});

test("known-limits records DM and B-07/B-08 honesty statements", () => {
  const limits = readFileSync(join(root, "docs/known-limits.md"), "utf8");
  expect(limits).toContain("Node 22 and 24 need a polyfill");
  expect(limits).toContain("okmodel.config.ts");
  expect(limits).toContain("column snapshot");
  expect(limits).toContain("describe(schema)");
  expect(limits).toContain("listen` is a driver capability");
  expect(limits).toContain("no untyped `sql.raw");
  expect(limits).toContain("joined columns are not projected");
  expect(limits).toContain("okm dev` opens a database and returns");
  expect(limits).toContain("okmodel/safety` is an opt-in import");
  expect(limits).toContain("## Not tested");
  expect(limits).toContain("Real Neon");
  expect(limits).toContain("Native Windows");
  expect(limits).toContain("GitHub Action on real GitHub");
  expect(limits).toContain("Long soak and performance");
  expect(limits).toContain("Minimum Bun for `okmodel/pg/bun` is 1.4");
  expect(limits).toContain("1-based step index");
  expect(limits).toContain("OpenTelemetry spans");
  expect(limits).toContain("error.cause");

  const readme = readFileSync(join(root, "README.md"), "utf8");
  expect(readme).toContain("temporal-polyfill");
  expect(readme).toContain("Node 22 and 24");

  const guide = readFileSync(join(root, "docs/guide.md"), "utf8");
  expect(guide).toContain("temporal-polyfill");
  expect(guide).toContain("OpenTelemetry spans");
  expect(guide).toContain("does not watch, reload, or apply");
  expect(guide).toContain("Queries every target");

  const spec = readFileSync(join(root, "docs/okmodel-api-design.md"), "utf8");
  expect(spec).toContain("okmodel.config.ts");
  expect(spec).not.toMatch(/config file `okm\.config\.ts`/);
  expect(spec).toContain("no `client.listen` / `db.listen`");
  expect(spec).toContain("Untyped `sql.raw");
});

test("testing helpers still export factories and isolation", async () => {
  const { testing } = await import("../src/tooling/testing/index.js");
  const { open } = await import("../src/adapters/pg/pglite.js");
  const { schema, table, text, id } = await import("../src/dialects/pg/index.js");
  const notes = table("notes", { id: id({ default: "none" }), title: text() });
  const app = schema({ tables: [notes] });
  const harness = await testing(app, { driver: open(), seed: 1 });
  try {
    const factories = harness.factories({
      notes: (x) => ({ title: x.words(2) }),
    });
    const row = await factories.notes.create();
    const title = row.title;
    expect(typeof title).toBe("string");
    expect((title as string).length).toBeGreaterThan(0);
  } finally {
    await harness.close();
  }
});

test("view keys are camelCased on the client", async () => {
  const { open } = await import("../src/adapters/pg/pglite.js");
  const { connect } = await import("../src/runtime/pg/pglite.js");
  const { schema, table, t } = await import("../src/dialects/pg/index.js");
  const { view } = await import("../src/dialects/pg/view/index.js");
  const notes = table("notes", { id: t.text().primaryKey(), title: t.text() });
  const active = view("active_notes", {
    columns: [
      { name: "id", type: "text" },
      { name: "title", type: "text" },
    ],
    query: "select id, title from notes",
  });
  const app = schema({ tables: [notes], views: [active] });
  const pool = await open();
  try {
    await pool.execute("create table notes (id text primary key, title text)");
    await pool.execute("create view active_notes as select id, title from notes");
    const db = await connect(pool, { schema: app });
    expect("activeNotes" in db.views).toBe(true);
    expect("active_notes" in db.views).toBe(false);
  } finally {
    await pool.close();
  }
});
