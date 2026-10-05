/**
 * Trait columns, sealed timestamps, and the SQL the write path emits.
 *
 * Insert and update against Postgres live in `traits-pg.test.ts`.
 */

import { expect, test } from "bun:test";

import type { Catalog, ColumnObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { explainWrite } from "../src/runtime/write.js";
import { timestamps, trait } from "../src/runtime/traits/index.js";

const notes = table("notes", {
  id: t.text().primaryKey(),
  title: t.text(),
});

const external = table(
  "external",
  { id: t.text().primaryKey(), name: t.text() },
  { omitDefaults: "owned outside okmodel" },
);

const app = schema({
  casing: "snake",
  traits: [timestamps()],
  tables: [notes, external],
});

test("a schema with no traits leaves the declared columns unchanged", () => {
  const bare = schema({
    casing: "snake",
    tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],
  });
  expect(columnOf(bare.catalog, "created_at")).toBeUndefined();
  expect(columnOf(bare.catalog, "updated_at")).toBeUndefined();
  const sql = renderCatalog(bare.catalog, "public").join("\n");
  expect(sql).not.toContain("created_at");
  expect(sql).not.toContain("updated_at");
  expect(sql).toContain('"title" text');
});

test("timestamps adds catalog columns with default now() and trait provenance", () => {
  const created = columnOf(app.catalog, "created_at", "notes");
  const updated = columnOf(app.catalog, "updated_at", "notes");
  expect(created?.definition).toMatchObject({
    dataType: "timestamptz",
    nullable: false,
    defaultExpression: "now()",
  });
  expect(updated?.definition.defaultExpression).toBe("now()");
  expect(created?.provenance).toMatchObject({ origin: "trait", name: "timestamps" });
  expect(updated?.provenance).toMatchObject({ origin: "trait", name: "timestamps" });
  const sql = renderCatalog(app.catalog, "public");
  const notesSql = sql.find((statement) => statement.includes('"notes"')) ?? "";
  const externalSql = sql.find((statement) => statement.includes('"external"')) ?? "";
  expect(notesSql).toContain('"created_at" timestamptz not null default now()');
  expect(notesSql).toContain('"updated_at" timestamptz not null default now()');
  expect(externalSql).not.toContain("created_at");
  expect(columnOf(app.catalog, "created_at", "external")).toBeUndefined();
});

test("omitDefaults needs a reason and a declared field conflicts", () => {
  const blank = capture(() =>
    schema({
      traits: [timestamps()],
      tables: [table("notes", { id: t.text().primaryKey() }, { omitDefaults: "  " })],
    }),
  );
  expect(blank.code).toBe("OKM1060");
  expect(blank.message).toContain("omitDefaults needs a reason");

  const clash = capture(() =>
    schema({
      traits: [timestamps()],
      tables: [table("notes", { id: t.text().primaryKey(), createdAt: t.text() })],
    }),
  );
  expect(clash.code).toBe("OKM1012");
  expect(clash.message).toContain("notes.createdAt");
  expect(clash.message).toContain("timestamps");
});

test("a table trait is enough, and trigger enforcement and methods are not yet", () => {
  const local = schema({
    casing: "snake",
    tables: [
      table("notes", { id: t.text().primaryKey(), title: t.text() }, { traits: [timestamps()] }),
    ],
  });
  expect(columnOf(local.catalog, "created_at")?.provenance.origin).toBe("trait");

  const labeled = trait("labeled", { fields: { label: t.text().default("x") } });
  const custom = schema({
    tables: [table("notes", { id: t.text().primaryKey() }, { traits: [labeled] })],
  });
  expect(columnOf(custom.catalog, "label")?.definition.defaultExpression).toBe("'x'");

  const trigger = capture(() => timestamps({ enforce: "trigger" }));
  expect(trigger.code).toBe("OKM1061");
  expect(trigger.message).toContain("0.3");
  const methods = capture(() => trait("labeled", { fields: { label: t.text() }, methods: {} }));
  expect(methods.code).toBe("OKM1061");
  expect(methods.message).toContain("methods");
  expect(() => trait("labeled", { fields: { label: t.text() }, presets: {} })).not.toThrow();
});

test("insert leaves the clock to the default and update sets updatedAt to now()", async () => {
  const inserted = await explainWrite(app, "insert", "notes", { id: "1", title: "a" }, {}, {});
  const insert = inserted.statements[0]?.text ?? "";
  const head = insert.split(" values ")[0] ?? "";
  expect(head).not.toContain("created_at");
  expect(head).not.toContain("updated_at");
  expect(insert).toContain("created_at");

  const updated = await explainWrite(
    app,
    "update",
    "notes",
    { where: { id: "1" }, set: { title: "b" } },
    {},
    {},
  );
  const update = updated.statements[0]?.text ?? "";
  expect(update).toContain('"updated_at" = now()');
  expect(update).not.toContain("created_at");

  const upsert = await explainWrite(
    app,
    "insert",
    "notes",
    { id: "1", title: "a" },
    { onConflict: { on: "id", update: ["title"] } },
    {},
  );
  expect(upsert.statements[0]?.text).toContain('"updated_at" = now()');

  await expectCode(
    explainWrite(app, "insert", "notes", { id: "1", title: "a", createdAt: "no" }, {}, {}),
  );
  await expectCode(
    explainWrite(
      app,
      "insert",
      "notes",
      { id: "1", title: "a", updatedAt: "no" },
      { allow: ["updatedAt"] },
      {},
    ),
  );
  await expectCode(
    explainWrite(
      app,
      "update",
      "notes",
      { where: { id: "1" }, set: { createdAt: "no" } },
      { allow: ["createdAt"] },
      {},
    ),
  );
});

async function expectCode(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    expect(error).toMatchObject({ code: "OKM1190" });
    return;
  }
  throw new Error("expected OKM1190");
}

function capture(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}

function columnOf(source: Catalog, field: string, tableName?: string): ColumnObject | undefined {
  return source.objects.find((object): object is ColumnObject => {
    if (object.kind !== "column" || object.identity.name !== field) return false;
    return tableName === undefined || object.identity.parent.name === tableName;
  });
}
