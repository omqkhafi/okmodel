/**
 * Constraint index built by `schema()` without the catalog compiler.
 *
 * Every catalog constraint and index matches a row. Mapped errors use the
 * rows and do not read `schema().catalog`.
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import type { Catalog, ConstraintObject, IndexObject } from "../src/contracts/catalog/types.js";
import { constraintRows } from "../src/dialects/pg/constraint-index.js";
import { mapPostgresError, type MapPostgresErrorSchema } from "../src/dialects/pg/errors.js";
import { id, schema, sql, table, text, uuid } from "../src/dialects/pg/index.js";
import { ERROR_DOCS } from "../src/tooling/errors/registry.js";
import { tenantApp } from "./archive-schema.js";
import { app as tenant } from "./tenancy-schema.js";

const single = schema({
  tables: [table("users", { id: id(), email: text().unique() })],
});

const named = schema({
  tables: [table("users", { id: id(), email: text() }, { unique: { email_taken: ["email"] } })],
});

const checked = schema({
  casing: "snake",
  tables: [
    table("users", { id: id(), email: text().unique() }),
    table(
      "notes",
      {
        id: id(),
        userId: uuid().references("users"),
        title: text(),
        status: text().picklist(["open", "closed"]),
      },
      { checks: { title_len: (columns) => sql`${columns.title} <> ''` } },
    ),
  ],
});

const adopted = schema({
  casing: "snake",
  tables: [
    table(
      "tasks",
      { id: id(), tenantId: uuid(), title: text() },
      { unique: { tenant_id_title: ["tenantId", "title"] } },
    ),
  ],
});

test("every catalog constraint and index has a matching row", () => {
  for (const built of [single, named, checked, adopted, tenant, tenantApp]) {
    const rows = constraintRows(built);
    expect(rows).toBeDefined();
    for (const object of built.catalog.objects) {
      if (object.kind !== "constraint" && object.kind !== "index") continue;
      const row = rows?.find(
        (item) => item.table === object.identity.parent.name && item.name === object.identity.name,
      );
      expect(row).toBeDefined();
      expect(row?.columns).toEqual(object.definition.columns);
      expect(row?.nameKey).toBe(object.definition.nameKey);
      expect(row?.kind).toBe(object.kind);
    }
  }
});

test("a mapped unique, foreign key, and check do not read schema().catalog", () => {
  const unique = objectNamed(checked.catalog, "users_email_key");
  const foreign = objectNamed(checked.catalog, "notes_user_id_fkey");
  const check = objectNamed(checked.catalog, "notes_title_len_check");
  const reads = spyCatalog(checked);
  expect(reasonOn(checked, unique, "23505")).toBe("email");
  expect(reasonOn(checked, foreign, "23503")).toBe("user_id");
  expect(reasonOn(checked, check, "23514")).toBe("title_len");
  expect(reads()).toBe(0);
});

test("the index reasons match the catalog path", () => {
  expect(reasonOn(single, objectNamed(single.catalog, "users_email_key"), "23505")).toBe("email");
  expect(reasonOn(named, uniqueOn(named.catalog, "users", "email"), "23505")).toBe("email_taken");
  expect(reasonOn(tenant, uniqueColumns(tenant.catalog, "tasks", "id,tenant_id"), "23505")).toBe(
    "id_tenantId",
  );
  expect(reasonOn(tenant, uniqueColumns(tenant.catalog, "tasks", "tenant_id,title"), "23505")).toBe(
    "title",
  );
  expect(reasonOn(tenant, foreignKey(tenant.catalog, "tasks"), "23503")).toBe("org_id");
  expect(
    reasonOn(tenantApp, uniqueIndex(tenantApp.catalog, "tasks", "id,tenant_id"), "23505"),
  ).toBe("tasks_id_tenant_id_idx");
  expect(
    reasonOn(adopted, uniqueColumns(adopted.catalog, "tasks", "tenant_id,title"), "23505"),
  ).toBe("tenantId_title");
});

test("a missing column list on the index falls back to the stored name key", () => {
  const object = uniqueColumns(tenant.catalog, "tasks", "id,tenant_id");
  const reads = spyCatalog(tenant);
  const mapped = mapPostgresError(
    new DriverError("duplicate", {
      sqlstate: "23505",
      constraint: object.identity.name,
      table: "tasks",
    }),
    { schema: tenant },
  );
  expect(mapped.fieldReason).toBe("id_tenantId");
  expect(reads()).toBe(0);
});

test("OKM1020 help still names armCatalog", () => {
  const doc = ERROR_DOCS.find((item) => item.code === "OKM1020");
  expect(doc?.fix).toContain("armCatalog()");
  expect(doc?.fix).toContain("okmodel/pg/catalog");
});

function spyCatalog(source: object): () => number {
  let reads = 0;
  const desc = Object.getOwnPropertyDescriptor(source, "catalog");
  if (desc?.get === undefined) throw new Error("catalog getter missing");
  // oxlint-disable-next-line typescript/unbound-method -- the getter is invoked on the schema object
  const read = (target: object): unknown =>
    Reflect.apply(desc.get as (this: object) => unknown, target, []);
  Object.defineProperty(source, "catalog", {
    configurable: true,
    get() {
      reads += 1;
      return read(source);
    },
  });
  return () => reads;
}

function reasonOn(
  source: MapPostgresErrorSchema,
  object: ConstraintObject | IndexObject,
  sqlstate: string,
): string {
  const columns = object.definition.columns;
  const mapped = mapPostgresError(
    new DriverError("violation", {
      sqlstate,
      constraint: object.identity.name,
      table: object.identity.parent.name,
      detail: `Key (${columns.join(", ")})=(x) already exists.`,
    }),
    { schema: source },
  );
  return mapped.fieldReason;
}

function objectNamed(catalog: Catalog, name: string): ConstraintObject | IndexObject {
  const found = catalog.objects.find(
    (object) =>
      (object.kind === "constraint" || object.kind === "index") && object.identity.name === name,
  );
  if (found?.kind !== "constraint" && found?.kind !== "index") throw new Error(`missing ${name}`);
  return found;
}

function uniqueOn(catalog: Catalog, tableName: string, column: string): ConstraintObject {
  const found = catalog.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === tableName &&
      object.definition.columns.join(",") === column,
  );
  if (found === undefined) throw new Error(`missing unique ${tableName}.${column}`);
  return found;
}

function uniqueColumns(catalog: Catalog, tableName: string, columns: string): ConstraintObject {
  const found = catalog.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === tableName &&
      object.definition.columns.join(",") === columns,
  );
  if (found === undefined) throw new Error(`missing unique ${tableName} ${columns}`);
  return found;
}

function uniqueIndex(catalog: Catalog, tableName: string, columns: string): IndexObject {
  const found = catalog.objects.find(
    (object): object is IndexObject =>
      object.kind === "index" &&
      object.identity.parent.name === tableName &&
      object.definition.columns.join(",") === columns,
  );
  if (found === undefined) throw new Error(`missing index ${tableName} ${columns}`);
  return found;
}

function foreignKey(catalog: Catalog, tableName: string): ConstraintObject {
  const found = catalog.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "foreignKey" &&
      object.identity.parent.name === tableName,
  );
  if (found === undefined) throw new Error(`missing foreign key ${tableName}`);
  return found;
}
