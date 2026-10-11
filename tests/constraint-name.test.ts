/**
 * Generated constraint names use SQL columns. The stored name key stays.
 *
 * An older catalog, whose names still use that key, plans renames only.
 */

import { expect, test } from "bun:test";

import { catalog } from "../src/contracts/catalog/build.js";
import {
  POSTGRES_IDENTIFIER_MAX_BYTES,
  deterministicName,
  utf8ByteLength,
} from "../src/contracts/catalog/identifier.js";
import type {
  Catalog,
  CatalogObject,
  ConstraintObject,
  IndexObject,
} from "../src/contracts/catalog/types.js";
import { id, integer, schema, sql, table, text } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { archivable } from "../src/runtime/traits/index.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { app } from "./tenancy-schema.js";

test("unique and foreign-key names use every SQL column", () => {
  const plain = schema({
    tables: [table("users", { userName: text().unique() })],
  });
  const snake = schema({
    casing: "snake",
    tables: [
      table("users", { userName: text().unique() }),
      table(
        "tasks",
        { userName: text(), title: text() },
        { unique: { label: ["userName", "title"] } },
      ),
    ],
  });
  expect(constraintName(plain.catalog, "unique", "users")).toBe("users_userName_key");
  expect(constraintName(snake.catalog, "unique", "users")).toBe("users_user_name_key");
  const label = namedUnique(snake.catalog, "tasks", "label");
  expect(label?.identity.name).toBe("tasks_user_name_title_key");
  expect(label?.definition.nameKey).toBe("label");

  const foreign = namedKind(app.catalog, "foreignKey", "tasks");
  expect(foreign?.definition.columns).toEqual(["org_id", "tenant_id"]);
  expect(foreign?.identity.name).toBe("tasks_org_id_tenant_id_fkey");
  expect(foreign?.definition.nameKey).toBe("org_id");
  expect(constraintName(app.catalog, "primaryKey", "tasks")).toBe("tasks_pkey");
});

test("a picklist check uses the SQL column and a named check keeps its name", () => {
  const built = schema({
    casing: "snake",
    tables: [
      table(
        "tasks",
        { userName: text().picklist(["a", "b"]), n: integer() },
        { checks: { stays_mine: (columns) => sql`${columns.n} > 0` } },
      ),
    ],
  });
  const pick = built.catalog.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "check" &&
      object.definition.nameKey === "user_name",
  );
  expect(pick?.kind === "constraint" ? pick.identity.name : "").toBe("tasks_user_name_check");
  const named = built.catalog.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "check" &&
      object.definition.nameKey === "stays_mine",
  );
  expect(named?.kind === "constraint" ? named.identity.name : "").toBe("tasks_stays_mine_check");
});

test("an archivable partial unique keeps its SQL index name", () => {
  const built = schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
    tables: [
      table(
        "tasks",
        { id: id({ default: "none" }), title: text().unique() },
        { traits: [archivable()] },
      ),
    ],
  });
  const indexes = built.catalog.objects.filter(
    (object): object is IndexObject => object.kind === "index" && object.definition.unique === true,
  );
  expect(indexes.map((object) => object.identity.name).sort()).toEqual([
    "tasks_id_tenant_id_idx",
    "tasks_tenant_id_title_idx",
  ]);
});

test("a long generated name keeps a hash suffix inside 63 bytes", () => {
  const piece = "c".repeat(20);
  const left = wide(piece, "a");
  const right = wide(piece, "b");
  expect(left).not.toBe(right);
  expect(utf8ByteLength(left)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(utf8ByteLength(right)).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES);
  expect(left).toMatch(/_[0-9a-f]{8}$/);
});

test("an older catalog plans only constraint renames, and the next plan is empty", () => {
  const before = legacyNames(app.catalog);
  const plan = planMigration({ before, after: app.catalog, name: "names" });
  expect(plan.steps.length).toBeGreaterThan(0);
  for (const step of plan.steps) {
    expect(step.sql.includes("rename constraint")).toBe(true);
    expect(step.lock).toBe("ACCESS EXCLUSIVE");
    expect(step.class).toBe("contract");
  }
  expect(plan.steps.some((step) => step.sql.includes("drop constraint"))).toBe(false);
  expect(plan.steps.some((step) => step.sql.includes('"tasks_id_tenant_id_key"'))).toBe(true);
  expect(plan.steps.some((step) => step.sql.includes('"tasks_org_id_tenant_id_fkey"'))).toBe(true);
  const again = planMigration({ before: app.catalog, after: app.catalog, name: "again" });
  expect(again.steps).toEqual([]);
  expect(deterministicName({ parent: "tasks", purpose: "unique", nameKey: "id_tenant_id" })).toBe(
    "tasks_id_tenant_id_key",
  );
});

function wide(piece: string, mark: string): string {
  const built = schema({
    tables: [
      table(
        "t".repeat(20),
        {
          a: text().sqlName(`a${piece}`),
          b: text().sqlName(`b${piece}`),
          c: text().sqlName(`x${piece}${mark}`),
        },
        { unique: { row: ["a", "b", "c"] } },
      ),
    ],
  });
  return constraintName(built.catalog, "unique", "t".repeat(20));
}

function legacyNames(source: Catalog): Catalog {
  const objects: CatalogObject[] = source.objects.map((object) => {
    if (object.kind !== "constraint") return object;
    const kind = object.definition.constraintKind;
    if (kind !== "unique" && kind !== "foreignKey") return object;
    const name = deterministicName({
      parent: object.identity.parent.name,
      purpose: kind,
      nameKey: object.definition.nameKey,
    });
    if (name === object.identity.name) return object;
    return { ...object, identity: { ...object.identity, name } };
  });
  return catalog(objects);
}

function constraintName(source: Catalog, kind: "unique" | "primaryKey", parent: string): string {
  const found = namedKind(source, kind, parent);
  return found?.identity.name ?? "";
}

function namedKind(
  source: Catalog,
  kind: "unique" | "primaryKey" | "foreignKey",
  parent: string,
): ConstraintObject | undefined {
  return source.objects.find(
    (object): object is ConstraintObject =>
      object.kind === "constraint" &&
      object.definition.constraintKind === kind &&
      object.identity.parent.name === parent,
  );
}

function namedUnique(source: Catalog, parent: string, nameKey: string) {
  const found = source.objects.find(
    (object) =>
      object.kind === "constraint" &&
      object.definition.constraintKind === "unique" &&
      object.identity.parent.name === parent &&
      object.definition.nameKey === nameKey,
  );
  return found?.kind === "constraint" ? found : undefined;
}
