/**
 * Client id defaults: catalog, schema default, and insert on PGlite.
 */

import { expect, test } from "bun:test";

import { open as openPglite } from "../src/adapters/pg/pglite.js";
import { catalogHash } from "../src/contracts/catalog/document.js";
import type { Catalog, ColumnObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { okid, uuidv4, uuidv7 } from "../src/runtime/ids/index.js";
import { connect } from "../src/runtime/pg/pglite.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("a literal default stays in the catalog and a function does not", () => {
  const literal = schema({
    tables: [table("notes", { id: t.text().primaryKey(), title: t.text().default("draft") })],
  });
  const generated = schema({
    tables: [
      table("notes", {
        id: t.text().primaryKey(),
        title: t.text().default(() => "draft"),
      }),
    ],
  });
  expect(expression(literal, "title")).toBe("'draft'");
  expect(expression(generated, "title")).toBeUndefined();
  expect(label(generated, "title")).toBe("client");
  expect(catalogHash(literal.catalog)).not.toBe(catalogHash(generated.catalog));
});

test("changing an okid generator does not change the catalog hash", () => {
  const short = schema({
    tables: [table("users", { id: t.id({ default: okid({ prefix: "a_" }) }) })],
  });
  const long = schema({
    tables: [
      table("users", { id: t.id({ default: okid({ prefix: "b_", length: 32, sortable: true }) }) }),
    ],
  });
  expect(catalogHash(short.catalog)).toBe(catalogHash(long.catalog));
  expect(expression(short, "id")).toBeUndefined();
  expect(collation(short, "id")).toBe("C");
  expect(dataType(short, "id")).toBe("text");
  expect(label(short, "id")).toBe("client");
  const sql = renderCatalog(short.catalog, "public").join("\n");
  expect(sql).toContain('collate "C"');
  expect(sql).not.toContain(" default ");
});

test("a column id choice wins over the schema default", () => {
  const app = schema({
    defaults: { id: okid({ prefix: "usr_" }) },
    tables: [
      table("users", { id: t.id() }),
      table("sessions", { id: t.id({ default: "uuidv4" }) }),
    ],
  });
  expect(dataType(app, "id", "users")).toBe("text");
  expect(collation(app, "id", "users")).toBe("C");
  expect(expression(app, "id", "sessions")).toBe("gen_random_uuid()");
  expect(dataType(app, "id", "sessions")).toBe("uuid");
  expect(collation(app, "id", "sessions")).toBeUndefined();
});

test("schema defaults.id uuidv4 is a database default and a function is not", () => {
  const database = schema({
    defaults: { id: "uuidv4" },
    requires: { postgres: ">=15" },
    tables: [table("sessions", { id: t.id() })],
  });
  expect(expression(database, "id")).toBe("gen_random_uuid()");
  const client = schema({
    defaults: { id: uuidv7 },
    requires: { postgres: ">=15" },
    tables: [table("sessions", { id: t.id() })],
  });
  expect(expression(client, "id")).toBeUndefined();
  expect(dataType(client, "id")).toBe("uuid");
  expect(label(client, "id")).toBe("client");
});

test("uuidv7 below Postgres 18 names defaults.id", () => {
  let error: OkmError | undefined;
  try {
    schema({
      requires: { postgres: ">=15" },
      tables: [table("sessions", { id: t.id() })],
    });
  } catch (caught) {
    if (caught instanceof OkmError) error = caught;
  }
  expect(error?.code).toBe("OKM1812");
  expect(error?.message).toContain("defaults.id");
});

test("adding collation is a plan step", () => {
  const before = schema({ tables: [table("notes", { id: t.text().primaryKey() })] });
  const after = schema({
    tables: [table("notes", { id: t.id({ default: okid({ sortable: true }) }) })],
  });
  const sql = planMigration({ before: before.catalog, after: after.catalog, name: "collate" })
    .steps.map((step) => step.sql)
    .join("\n");
  expect(sql.toLowerCase()).toContain('collate "c"');
});

test("insert fills each row and connect can replace the generator", async () => {
  const app = schema({
    tables: [
      table("users", { id: t.id({ default: uuidv4 }), name: t.text() }),
      table("notes", { id: t.id({ default: okid({ prefix: "nt_" }) }), title: t.text() }),
      table("events", { id: t.id({ default: uuidv7 }), name: t.text() }),
      table("tags", { id: t.text().primaryKey(), slug: t.text().default(uuidv4) }),
    ],
  });
  const pool = await openPglite();
  try {
    for (const statement of renderCatalog(app.catalog, "public")) {
      await pool.execute(statement);
    }
    const fixed = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ] as const;
    let index = 0;
    const db = await connect(pool, {
      schema: app,
      generators: {
        uuidv4: () => fixed[index++] ?? fixed[0],
        okid: () => "nt_fixed",
      },
    });
    const first = await db.users.insert({ name: "Ada" });
    expect(first.id).toBe(fixed[0]);
    expect(first.name).toBe("Ada");
    const batch = await db.users.insert([{ name: "Grace" }, { name: "Lin" }]);
    expect(batch.map((row) => row.id)).toEqual([fixed[1], fixed[2]]);
    const note = await db.notes.insert({ title: "hello" });
    expect(note.id).toBe("nt_fixed");
    const event = await db.events.insert({ name: "open" });
    expect(event.id).toMatch(UUID);
    expect(event.id[14]).toBe("7");
    const tag = await db.tags.insert({ id: "kept", slug: "explicit" });
    expect(tag.slug).toBe("explicit");
    const filled = await db.tags.insert({ id: "next" });
    expect(filled.slug).toBe(fixed[3]);
    let refused: unknown;
    try {
      await db.users.insert({ id: fixed[0], name: "no" } as never);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(OkmError);
    if (refused instanceof OkmError) expect(refused.code).toBe("OKM1190");
    await db.close();
  } finally {
    await pool.close();
  }
});

function expression(
  source: { readonly catalog: Catalog },
  field: string,
  tableName?: string,
): string | undefined {
  return columnOf(source.catalog, field, tableName ?? firstTable(source.catalog))?.definition
    .defaultExpression;
}

function collation(
  source: { readonly catalog: Catalog },
  field: string,
  tableName?: string,
): string | undefined {
  return columnOf(source.catalog, field, tableName)?.definition.collation;
}

function dataType(
  source: { readonly catalog: Catalog },
  field: string,
  tableName?: string,
): string | undefined {
  return columnOf(source.catalog, field, tableName)?.definition.dataType;
}

function label(
  source: {
    readonly model: Readonly<
      Record<
        string,
        {
          readonly columns: readonly {
            readonly field: string;
            readonly clientDefault?: "client";
          }[];
        }
      >
    >;
  },
  field: string,
): "client" | undefined {
  for (const tableModel of Object.values(source.model)) {
    const found = tableModel.columns.find((item) => item.field === field);
    if (found?.clientDefault !== undefined) return found.clientDefault;
  }
  return undefined;
}

function columnOf(source: Catalog, field: string, tableName?: string): ColumnObject | undefined {
  return source.objects.find(
    (object): object is ColumnObject =>
      object.kind === "column" &&
      object.identity.name === field &&
      (tableName === undefined || object.identity.parent?.name === tableName),
  );
}

function firstTable(source: Catalog): string | undefined {
  return source.objects.find((object) => object.kind === "table")?.identity.name;
}
