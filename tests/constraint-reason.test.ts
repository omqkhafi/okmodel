/**
 * Pins the reasons `mapPostgresError` returns today.
 *
 * These strings are what application code matches. A later name change must
 * keep them: a single unique, a named unique, the tenant extra unique, an
 * archivable partial unique, and a tenant foreign key.
 */

import { expect, test } from "bun:test";

import { DriverError } from "../src/adapters/error.js";
import type { Catalog, ConstraintObject, IndexObject } from "../src/contracts/catalog/types.js";
import { mapPostgresError, type MapPostgresErrorSchema } from "../src/dialects/pg/errors.js";
import { id, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { tenantApp } from "./archive-schema.js";
import { app } from "./tenancy-schema.js";

const single = schema({
  tables: [table("users", { id: id(), email: text().unique() })],
});

const named = schema({
  tables: [table("users", { id: id(), email: text() }, { unique: { email_taken: ["email"] } })],
});

test("a single unique reasons the column", () => {
  const object = uniqueOn(single.catalog, "users", "email");
  expect(object.identity.name).toBe("users_email_key");
  expect(reason(single, object, "23505")).toBe("email");
});

test("a named unique reasons the name the author chose", () => {
  const object = uniqueOn(named.catalog, "users", "email");
  expect(object.identity.name).toBe("users_email_key");
  expect(object.definition.nameKey).toBe("email_taken");
  expect(reason(named, object, "23505")).toBe("email_taken");
});

test("the tenant extra unique reasons the stored name key", () => {
  const object = uniqueColumns(app.catalog, "tasks", "id,tenant_id");
  expect(object.identity.name).toBe("tasks_id_tenant_id_key");
  expect(object.definition.nameKey).toBe("id_tenantId");
  expect(reason(app, object, "23505")).toBe("id_tenantId");
});

test("a tenant column unique reasons the field, not every column", () => {
  const object = uniqueColumns(app.catalog, "tasks", "tenant_id,title");
  expect(object.identity.name).toBe("tasks_tenant_id_title_key");
  expect(object.definition.nameKey).toBe("title");
  expect(reason(app, object, "23505")).toBe("title");
});

test("an archivable partial unique reasons the full index name", () => {
  const object = uniqueIndex(tenantApp.catalog, "tasks", "id,tenant_id");
  expect(object.identity.name).toBe("tasks_id_tenant_id_idx");
  expect(reason(tenantApp, object, "23505")).toBe("tasks_id_tenant_id_idx");
});

test("a tenant foreign key reasons the stored name key", () => {
  const object = foreignKey(app.catalog, "tasks");
  expect(object.identity.name).toBe("tasks_org_id_tenant_id_fkey");
  expect(object.definition.nameKey).toBe("org_id");
  expect(object.definition.columns).toEqual(["org_id", "tenant_id"]);
  expect(reason(app, object, "23503")).toBe("org_id");
});

test("a missing column list falls back to the stored name key", () => {
  const object = uniqueColumns(app.catalog, "tasks", "id,tenant_id");
  const mapped = mapPostgresError(
    new DriverError("duplicate", {
      sqlstate: "23505",
      constraint: object.identity.name,
      table: "tasks",
    }),
    { schema: view(app) },
  );
  expect(mapped.fieldReason).toBe("id_tenantId");
});

test("an introspected composite name key becomes the TypeScript fields", () => {
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
  const object = uniqueColumns(adopted.catalog, "tasks", "tenant_id,title");
  expect(object.definition.nameKey).toBe("tenant_id_title");
  expect(reason(adopted, object, "23505")).toBe("tenantId_title");
});

function reason(
  source: { readonly catalog: Catalog; readonly model: MapPostgresErrorSchema["model"] },
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
    { schema: view(source) },
  );
  return mapped.fieldReason;
}

function view(source: {
  readonly catalog: Catalog;
  readonly model: MapPostgresErrorSchema["model"];
}): MapPostgresErrorSchema {
  return { catalog: source.catalog, model: source.model };
}

function uniqueOn(catalog: Catalog, parent: string, column: string): ConstraintObject {
  const found = catalog.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === parent &&
      object.definition.columns.includes(column),
  );
  if (found === undefined) throw new Error(`missing unique ${parent}.${column}`);
  return found;
}

function uniqueColumns(catalog: Catalog, parent: string, columns: string): ConstraintObject {
  const found = catalog.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === parent &&
      object.definition.columns.join(",") === columns,
  );
  if (found === undefined) throw new Error(`missing unique ${parent} (${columns})`);
  return found;
}

function uniqueIndex(catalog: Catalog, parent: string, columns: string): IndexObject {
  const found = catalog.objects.find(
    (object): object is IndexObject =>
      object.kind === "index" &&
      object.definition.unique === true &&
      object.identity.parent.name === parent &&
      object.definition.columns.join(",") === columns,
  );
  if (found === undefined) throw new Error(`missing unique index ${parent} (${columns})`);
  return found;
}

function foreignKey(catalog: Catalog, parent: string): ConstraintObject {
  const found = catalog.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "foreignKey" &&
      object.identity.parent.name === parent,
  );
  if (found === undefined) throw new Error(`missing foreign key on ${parent}`);
  return found;
}
