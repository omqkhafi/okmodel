/**
 * Cycle-2 coverage that used to live only in QA scripts (DM-1 to DM-12,
 * B-07, B-08): doctor codes, okm dev, backfill step numbering, and the
 * area-page honesty statements that used to sit on known-limits.
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

test("area pages quote the runtime floor the code already names", () => {
  const bun = readFileSync(join(root, ".bun-version"), "utf8").trim();
  const bunMinor = bun.split(".").slice(0, 2).join(".");
  const drivers = readFileSync(join(root, "site/content/docs/operate/drivers.mdx"), "utf8");
  const why = readFileSync(join(root, "site/content/docs/start/why-okmodel.mdx"), "utf8");
  expect(drivers).toContain(bunMinor);
  expect(why).toContain(bunMinor);
  expect(why).toMatch(/Deno[^\n]*Unsupported|Unsupported[^\n]*Deno/i);

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const nodeMajor = /\d+/.exec(manifest.engines?.node ?? "")?.[0];
  if (nodeMajor === undefined) throw new Error("package.json engines.node is missing");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const guide = readFileSync(join(root, "docs/guide.md"), "utf8");
  expect(readme).toContain(`Node ${nodeMajor}`);
  for (const text of [why, readme, guide]) expect(text).not.toContain("known-limits");

  const message = readFileSync(join(root, "src/dialects/pg/time.ts"), "utf8");
  const page = readFileSync(join(root, "site/content/docs/schema/time-columns.mdx"), "utf8");
  for (const fact of ["Node 22", "Node 24", "Cloudflare Workers"]) {
    expect(message, fact).toContain(fact);
    expect(page, fact).toContain(fact);
  }
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
  const active = view("active_notes", { tables: [] }, (q) =>
    q.sql({
      columns: [
        { name: "id", type: t.text() },
        { name: "title", type: t.text() },
      ],
      query: "select id, title from notes",
    }),
  );
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
