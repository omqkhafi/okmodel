/**
 * Extension declarations, catalog records, and migration SQL.
 *
 * The definition object produces the record. Core does not parse it.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { extensionObject } from "../src/contracts/catalog/extension.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { citext as citextExtension } from "../src/dialects/pg/ext/citext.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { catalogsEqual } from "../src/tooling/migrate/equal.js";
import { run } from "../src/tooling/migrate/commands.js";
import { formatPlan, planMigration } from "../src/tooling/migrate/plan.js";

const provenance = { origin: "extension" as const, name: "citext" };

function codeOf(error: unknown): string | undefined {
  return error instanceof OkmError ? error.code : undefined;
}

test("an empty extension list is accepted and adds no record", () => {
  const app = schema({
    tables: [table("tasks", { id: t.id() })],
    extensions: [],
  });
  expect(app.catalog.objects.some((object) => object.kind === "extension")).toBe(false);
});

test("citext() contributes one extension record", () => {
  const app = schema({
    tables: [table("people", { email: t.citext() })],
    extensions: [citextExtension()],
  });
  const found = app.catalog.objects.find((object) => object.kind === "extension");
  expect(found?.identity).toEqual({ kind: "extension", name: "citext" });
  expect(found?.definition).toEqual({ schema: "public", relocatable: true });
  expect(found?.provenance).toEqual({ origin: "extension", name: "citext" });
});

test("a second definition is OKM1813 and a plain object is OKM1810", () => {
  const twice = schema({
    tables: [table("people", { email: t.citext() })],
    extensions: [citextExtension(), citextExtension()],
  });
  expect(codeOf(capture(() => twice.catalog))).toBe("OKM1813");
  const plain = schema({
    tables: [table("people", { id: t.id() })],
    extensions: [citextExtension(), { name: "vector" }],
  });
  expect(codeOf(capture(() => plain.catalog))).toBe("OKM1810");
});

test("a citext column without the declaration fails at catalog build", () => {
  const omitted = schema({ tables: [table("people", { email: t.citext() })] });
  expect(codeOf(capture(() => omitted.catalog))).toBe("OKM1020");
  const other = schema({
    tables: [table("people", { email: t.citext() })],
    extensions: [extension("pg_trgm")],
  });
  expect(codeOf(capture(() => other.catalog))).toBe("OKM1810");
});

test("create extension is emitted before the table and drop is not cascade", () => {
  const after = schema({
    tables: [table("people", { email: t.citext() })],
    extensions: [citextExtension({ version: "1.6" })],
  });
  const plan = planMigration({ before: catalog([]), after: after.catalog, name: "add" });
  const sql = plan.steps.map((step) => step.sql);
  const created = sql.findIndex((statement) => statement.startsWith("create extension"));
  const tableSql = sql.findIndex((statement) => statement.startsWith("create table"));
  expect(created).toBeGreaterThanOrEqual(0);
  expect(created).toBeLessThan(tableSql);
  expect(sql[created]).toContain("version '1.6'");
  expect(sql.join("\n").toLowerCase()).not.toContain("cascade");

  const removed = planMigration({
    before: after.catalog,
    after: catalog([]),
    name: "drop",
  });
  const drop = removed.steps
    .map((step) => step.sql)
    .find((statement) => statement.startsWith("drop extension"));
  expect(drop).toBe('drop extension "citext"');
});

test("an exact upgrade is path-unverified and a downgrade is OKM1814", () => {
  const from = schema({
    tables: [table("people", { id: t.id() })],
    extensions: [citextExtension({ version: "1.6" })],
  });
  const to = schema({
    tables: [table("people", { id: t.id() })],
    extensions: [citextExtension({ version: "1.8" })],
  });
  const plan = planMigration({ before: from.catalog, after: to.catalog, name: "up" });
  expect(plan.steps.map((step) => step.sql)).toEqual([
    "alter extension \"citext\" update to '1.8'",
  ]);
  expect(plan.steps[0]?.path).toBe("unverified");
  expect(formatPlan(plan)).toContain("-- path: unverified");
  const down = schema({
    tables: [table("people", { id: t.id() })],
    extensions: [citextExtension({ version: "1.4" })],
  });
  expect(codeOf(capture(() => planMigration({ before: to.catalog, after: down.catalog })))).toBe(
    "OKM1814",
  );
});

test("a move is set schema and a non-relocatable move is OKM1814", () => {
  const from = schema({
    tables: [table("people", { id: t.id() })],
    extensions: [citextExtension()],
  });
  const moved = schema({
    tables: [table("people", { id: t.id() })],
    extensions: [citextExtension({ schema: "exts" })],
  });
  const plan = planMigration({ before: from.catalog, after: moved.catalog, name: "move" });
  expect(plan.steps.map((step) => step.sql)).toEqual([
    'alter extension "citext" set schema "exts"',
  ]);
  const stuck = schema({
    tables: [table("people", { id: t.id() })],
    extensions: [citextExtension({ schema: "exts", relocatable: false })],
  });
  expect(codeOf(capture(() => planMigration({ before: from.catalog, after: stuck.catalog })))).toBe(
    "OKM1814",
  );
});

test("an unpinned declaration matches an installed version", () => {
  const pinned = catalog([
    extensionObject({ name: "citext", schema: "public", version: "1.6", provenance }),
  ]);
  const loose = catalog([extensionObject({ name: "citext", schema: "public", provenance })]);
  expect(catalogsEqual(pinned, loose)).toBe(true);
  const other = catalog([
    extensionObject({ name: "citext", schema: "exts", version: "1.6", provenance }),
  ]);
  expect(catalogsEqual(pinned, other)).toBe(false);
});

test("similar plans as a schema-qualified operator and gin is the catalog index", async () => {
  const trigram = pgTrgm();
  expect(trigram.gin("title").expression).toBe('using gin ("title" gin_trgm_ops)');
  const app = schema({
    tables: [
      table(
        "notes",
        { title: t.text() },
        { indexes: (column) => [trigram.gin(column.title.name)] },
      ),
    ],
    extensions: [trigram],
  });
  const index = app.catalog.objects.find((object) => object.kind === "index");
  expect(index?.kind === "index" ? index.definition.expression : undefined).toBe(
    'using gin ("title" gin_trgm_ops)',
  );
  const plan = planMigration({ before: catalog([]), after: app.catalog, name: "gin" });
  expect(plan.steps.map((step) => step.sql).join("\n")).toContain(
    'using gin ("title" gin_trgm_ops)',
  );
  const pool = await openPglite();
  try {
    const db = await connect(pool, { schema: app });
    await db.connected;
    const planned = await db.notes
      .find({ where: { title: trigram.similar("hi") }, limit: 1 })
      .sql();
    expect(planned.text).toContain('operator("public".%)');
    expect(planned.params).toEqual(["hi", "1"]);
  } finally {
    await pool.close();
  }
});

test("okm ext test and scaffold are not available", async () => {
  expect((await rejection(() => run(["ext", "test"]))).message).toContain("not available yet");
  expect((await rejection(() => run(["ext", "scaffold"]))).message).toContain("not available yet");
});

async function rejection(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected a rejection");
}

function capture(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}
