/**
 * `schema()` catalog compile and the OKM1020–1023 guards.
 */

import { expect, test } from "bun:test";

import { OkmError } from "../src/contracts/error.js";
import {
  catalogHash,
  loadTrustedCatalog,
  parseCatalog,
  serializeCatalog,
} from "../src/contracts/catalog/document.js";
import { creationOrder } from "../src/contracts/catalog/document.js";
import { emitRowTypes } from "../src/dialects/pg/emit.js";
import { index, schema, sql, table, t } from "../src/dialects/pg/index.js";

const users = table("users", {
  id: t.id({ default: "uuidv4" }),
  email: t.text().unique(),
});

const tasks = table(
  "tasks",
  {
    id: t.id({ default: "uuidv4" }),
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
  id: t.id({ default: "uuidv4" }),
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

test("later options are OKM1061 and name the version that adds them", () => {
  const error = capture(() =>
    schema({
      tables: [table("tasks", { id: t.id() })],
      functions: [],
    }),
  );
  expect(error.code).toBe("OKM1061");
  expect(error.message).toContain("not available yet");
  expect(error.message).toContain("0.3");
  const tableError = capture(() =>
    schema({ tables: [table("tasks", { id: t.id() }, { relations: { owner: true } })] }),
  );
  expect(tableError.code).toBe("OKM1061");
  expect(tableError.message).toContain("one(), many(), and manyThrough()");
  expect(tableError.message).toContain("morph arrives later");
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

test("an enum column is one catalog type with a column dependency", () => {
  const app = schema({
    tables: [
      table("tasks", {
        id: t.integer(),
        status: t.enum("color", ["red", "blue"]),
        shade: t.enum("color", ["red", "blue"]),
      }),
      table("labels", {
        id: t.integer(),
        tone: t.enum("color", ["red", "blue"]),
      }),
    ],
  });
  const types = app.catalog.objects.filter((object) => object.kind === "type");
  expect(types).toHaveLength(1);
  const enumObject = types[0];
  expect(enumObject?.kind === "type" ? enumObject.definition.labels : []).toEqual(["red", "blue"]);
  expect(enumObject?.owner).toBe("managed");
  const users = app.catalog.objects.filter(
    (object) => object.kind === "column" && object.definition.dataType === "color",
  );
  expect(users).toHaveLength(3);
  for (const column of users) {
    expect(
      column.dependencies.some(
        (edge) => edge.target.kind === "type" && edge.target.name === "color",
      ),
    ).toBe(true);
  }
  const text = serializeCatalog(app.catalog);
  const hash = catalogHash(app.catalog);
  expect(catalogHash(schema({ tables: app.tables }).catalog)).toBe(hash);
  const loaded = loadTrustedCatalog(text, hash);
  expect(serializeCatalog(loaded)).toBe(text);
  expect(catalogHash(loaded)).toBe(hash);
  expect(catalogHash(parseCatalog(text))).toBe(hash);
  const swapped = schema({
    tables: [table("tasks", { id: t.integer(), status: t.enum("color", ["blue", "red"]) })],
  });
  expect(catalogHash(swapped.catalog)).not.toBe(hash);
});

test("two declarations of one enum must list the same labels", () => {
  const error = capture(
    () =>
      schema({
        tables: [
          table("tasks", { id: t.integer(), status: t.enum("color", ["red", "blue"]) }),
          table("labels", { id: t.integer(), tone: t.enum("color", ["red", "green"]) }),
        ],
      }).catalog,
  );
  expect(error.code).toBe("OKM1020");
});

test("a column primary key and a composite key are catalog constraints", () => {
  const natural = schema({
    tables: [table("skus", { code: t.text().primaryKey(), name: t.text() })],
  });
  const composite = schema({
    tables: [
      table(
        "members",
        { userId: t.uuid(), orgId: t.uuid(), role: t.text() },
        { primaryKey: ["userId", "orgId"] },
      ),
    ],
  });
  const naturalKey = natural.catalog.objects.find(
    (object) => object.kind === "constraint" && object.definition.constraintKind === "primaryKey",
  );
  const compositeKey = composite.catalog.objects.find(
    (object) => object.kind === "constraint" && object.definition.constraintKind === "primaryKey",
  );
  expect(naturalKey?.kind === "constraint" ? naturalKey.definition.columns : []).toEqual(["code"]);
  expect(compositeKey?.kind === "constraint" ? compositeKey.definition.columns : []).toEqual([
    "userId",
    "orgId",
  ]);
  expect(natural.model.skus?.primary).toEqual(["code"]);
  expect(composite.model.members?.primary).toEqual(["userId", "orgId"]);
  const code = natural.model.skus?.columns.find((column) => column.field === "code");
  expect(code?.writable).toBe(true);
  expect(code?.guardUpdate).toBe(true);
});

test("uuidv7 below the declared Postgres 18 names the uuidv4 default", () => {
  const error = capture(() =>
    schema({
      requires: { postgres: ">=17" },
      tables: [table("sessions", { id: t.id() })],
    }),
  );
  expect(error.code).toBe("OKM1812");
  expect(error.message).toContain("uuidv7()");
  expect(error.message).toContain("defaults.id");
  expect(error.fix.summary).toContain("defaults.id");
  const allowed = schema({
    requires: { postgres: ">=18" },
    tables: [table("sessions", { id: t.id() })],
  });
  const column = allowed.catalog.objects.find((object) => object.kind === "column");
  expect(column?.kind === "column" ? column.definition.defaultExpression : "").toBe("uuidv7()");
  const uuidv4 = schema({
    requires: { postgres: ">=15" },
    tables: [table("sessions", { id: t.id({ default: "uuidv4" }) })],
  });
  const uuidv4Column = uuidv4.catalog.objects.find((object) => object.kind === "column");
  expect(uuidv4Column?.kind === "column" ? uuidv4Column.definition.defaultExpression : "").toBe(
    "gen_random_uuid()",
  );
});

test("a column primary key and a primaryKey option cannot both be set", () => {
  const error = capture(() =>
    schema({
      tables: [
        table(
          "members",
          { userId: t.uuid().primaryKey(), orgId: t.uuid() },
          {
            primaryKey: ["userId", "orgId"],
          },
        ),
      ],
    }),
  );
  expect(error.code).toBe("OKM1020");
  expect(error.message).toContain("One primary key");
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
