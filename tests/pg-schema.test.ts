/**
 * `schema()` catalog compile and the OKM1020–1023 guards.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import { catalogHash, parseCatalog, serializeCatalog } from "../src/contracts/catalog/document.js";
import { creationOrder } from "../src/contracts/catalog/document.js";
import { index, schema, sql, table, t, emitRowTypes } from "../src/dialects/pg/index.js";

const users = table("users", {
  id: t.id(),
  email: t.text().unique(),
});

const tasks = table(
  "tasks",
  {
    id: t.id(),
    ownerId: t.uuid().references("users"),
    listId: t.uuid().references("lists", { onDelete: "cascade" }),
    title: t.varchar(200),
    status: t.varchar(20).picklist(["draft", "active", "done"]).default("draft"),
    notes: t.text().nullable(),
    position: t.integer().default(0),
  },
  {
    indexes: (columns) => [index(columns.ownerId, columns.status)],
    checks: { positionPositive: (columns) => sql`${columns.position} >= 0` },
    unique: { ownerTitle: ["ownerId", "title"] },
    comment: "work items",
    renamedFrom: "todos",
  },
);

const lists = table("lists", {
  id: t.id(),
  name: t.text(),
});

function built() {
  return schema({
    tables: [users, lists, tasks],
    casing: "snake",
    requires: { postgres: ">=17" },
    types: "inferred",
  });
}

test("schema compiles a hashable catalog", () => {
  const first = built();
  const second = built();
  expect(first.types).toBe("inferred");
  expect(first.casing).toBe("snake");
  expect(first.codecs).toEqual({ bigint: "string", numeric: "string", timestamps: "temporal" });
  expect(first.requires).toEqual({ postgres: ">=17" });
  expect(serializeCatalog(first.catalog)).toBe(serializeCatalog(second.catalog));
  expect(catalogHash(first.catalog)).toBe(catalogHash(second.catalog));
  expect(serializeCatalog(parseCatalog(serializeCatalog(first.catalog)))).toBe(
    serializeCatalog(first.catalog),
  );
});

test("names, dependencies, and referential actions are stored", () => {
  const document = built().catalog;
  const names = document.objects.map((object) =>
    object.kind === "table" ? object.identity.name : `${object.kind}:${object.identity.name}`,
  );
  expect(names).toContain("tasks");
  expect(names).toContain("users");
  const fk = document.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "foreignKey" &&
      object.definition.columns[0] === "list_id",
  );
  expect(fk?.kind === "constraint" ? fk.definition.references?.onDelete : undefined).toBe(
    "cascade",
  );
  expect(fk?.kind === "constraint" ? fk.identity.name : "").toBe("tasks_list_id_fkey");
  const pk = document.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.identity.parent.name === "tasks" &&
      object.definition.constraintKind === "primaryKey",
  );
  expect(pk?.identity.name).toBe("tasks_pkey");
  const check = document.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "check" &&
      object.definition.nameKey === "positionPositive",
  );
  expect(check?.kind === "constraint" ? check.definition.expression : "").toBe("position >= 0");
  const unique = document.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.definition.nameKey === "ownerTitle",
  );
  expect(unique?.kind === "constraint" ? unique.definition.columns : []).toEqual([
    "owner_id",
    "title",
  ]);
  const secondary = document.objects.find(
    (object) => object.kind === "index" && object.identity.parent.name === "tasks",
  );
  expect(secondary?.kind === "index" ? secondary.definition.columns : []).toEqual([
    "owner_id",
    "status",
  ]);
  const order = creationOrder(document).map((object) => object.kind);
  expect(order.indexOf("table")).toBeLessThan(order.indexOf("column"));
  const edge = fk?.kind === "constraint" ? fk.dependencies.map((item) => item.target.kind) : [];
  expect(edge).toContain("table");
  expect(edge).toContain("column");
});

test("identity columns compile a sequence", () => {
  const app = schema({
    tables: [
      table("orders", {
        id: t.identity(),
        note: t.text(),
      }),
    ],
  });
  const seq = app.catalog.objects.find((object) => object.kind === "sequence");
  expect(seq?.identity.name).toBe("orders_id_seq");
  const column = app.catalog.objects.find(
    (object) => object.kind === "column" && object.identity.name === "id",
  );
  expect(column?.dependencies.some((edge) => edge.target.kind === "sequence")).toBe(true);
  expect(column?.kind === "column" ? column.definition.identity : undefined).toEqual({
    always: true,
  });
});

test("defaults to emitted types and public names", () => {
  const app = schema({ tables: [table("tasks", { id: t.id(), title: t.text() })] });
  expect(app.types).toBe("emitted");
  expect(
    app.catalog.objects.some(
      (object) => object.kind === "column" && object.identity.name === "title",
    ),
  ).toBe(true);
});

test("OKM1020 names the missing table and the accepted names", () => {
  const error = capture(() =>
    schema({
      tables: [table("tasks", { ownerId: t.uuid().references("people") })],
    }),
  );
  expect(error.code).toBe("OKM1020");
  expect(error.message).toContain("people");
  expect(error.message).toContain("Accepted names: tasks");
});

test("OKM1021 names a missing primary key and the accepted columns", () => {
  const error = capture(() =>
    schema({
      tables: [
        table("users", { email: t.text() }),
        table("tasks", { ownerId: t.uuid().references("users") }),
      ],
    }),
  );
  expect(error.code).toBe("OKM1021");
  expect(error.message).toContain("tasks.ownerId");
  expect(error.message).toContain("Accepted columns: email");
});

test("OKM1021 names an ambiguous reference and the accepted columns", () => {
  const error = capture(() =>
    schema({
      tables: [
        table("users", { id: t.id(), email: t.text() }),
        table("tasks", {
          ownerId: t.uuid().references("users", { columns: ["id", "email"] }),
        }),
      ],
    }),
  );
  expect(error.code).toBe("OKM1021");
  expect(error.message).toContain("tasks.ownerId");
  expect(error.message).toContain("ambiguous");
  expect(error.message).toContain("Accepted columns: email, id");
});

test("a table with two primary keys is rejected", () => {
  const error = capture(() =>
    schema({
      tables: [table("users", { first: t.id(), second: t.identity() })],
    }),
  );
  expect(error.code).toBe("OKM1020");
  expect(error.message).toContain("more than one primary key");
});

test("OKM1022 names the types", () => {
  const error = capture(() =>
    schema({
      tables: [
        table("users", { id: t.id() }),
        table("tasks", { ownerId: t.integer().references("users") }),
      ],
    }),
  );
  expect(error.code).toBe("OKM1022");
  expect(error.message).toContain("tasks.ownerId");
  expect(error.message).toContain("integer");
  expect(error.message).toContain("uuid");
  expect(error.message).toContain("Accepted type: uuid");
});

test("OKM1023 names a duplicate table and the accepted names", () => {
  const tasksTable = table("tasks", { id: t.id() });
  const error = capture(() => schema({ tables: [tasksTable, tasksTable] }));
  expect(error.code).toBe("OKM1023");
  expect(error.message).toContain("tasks");
  expect(error.message).toContain("Accepted names: tasks");
});

test("later options are OKM1061 and name the prompt that adds them", () => {
  const error = capture(() =>
    schema({
      tables: [table("tasks", { id: t.id() })],
      traits: [],
    }),
  );
  expect(error.code).toBe("OKM1061");
  expect(error.message).toContain("not available yet");
  expect(error.message).toContain("P23");
  const tableError = capture(() => table("tasks", { id: t.id() }, { relations: { owner: true } }));
  expect(tableError.code).toBe("OKM1061");
  expect(tableError.message).toContain("P27");
  expect(tableError.message).toContain("not available yet");
  const computed = capture(() => table("tasks", { id: t.id() }, { computed: { label: true } }));
  expect(computed.code).toBe("OKM1061");
  expect(computed.message).toContain("arrives later");
  expect(computed.message).not.toContain("P15");
  const policies = capture(() => table("tasks", { id: t.id() }, { policies: { read: true } }));
  expect(policies.code).toBe("OKM1061");
  expect(policies.message).toContain("arrives later");
  expect(policies.message).not.toContain("M2");
});

test("emitRowTypes spells the inferred field modes", () => {
  const app = schema({
    tables: [
      table("tasks", {
        id: t.id(),
        title: t.text(),
        status: t.varchar(20).picklist(["draft", "active"]).default("draft"),
        notes: t.text().nullable(),
        secret: t.text().hidden(),
      }),
    ],
  });
  const text = emitRowTypes(app);
  expect(text).toContain("export interface Tasks {");
  expect(text).toContain("export interface TasksInsert {");
  expect(text).toContain("export interface TasksUpdate {");
  expect(text).toContain('readonly status: "draft" | "active";');
  expect(text).toContain("readonly notes: string | null;");
  const row = text.slice(
    text.indexOf("export interface Tasks {"),
    text.indexOf("export interface TasksInsert"),
  );
  expect(row).not.toContain("secret");
  expect(text).toContain('readonly status: "draft" | "active" | undefined;');
  expect(text).toContain("readonly notes: string | null | undefined;");
});

function capture(run: () => unknown): OkmError {
  try {
    run();
  } catch (error) {
    if (error instanceof OkmError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected OkmError");
}
