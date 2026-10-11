/**
 * Postgres 15 and 18: a default unique adopts, a rename is only a rename,
 * and a real violation still reasons the stored name key.
 *
 * The suite runs this file on 15 and on 18. It does not open port 55432
 * unless that is the primary this process was given.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { mapDriverError } from "../src/adapters/error.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { deterministicName } from "../src/contracts/catalog/identifier.js";
import type { Catalog, CatalogObject } from "../src/contracts/catalog/types.js";
import { renderCatalog } from "../src/dialects/pg/ddl.js";
import { mapPostgresError } from "../src/dialects/pg/errors.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { id, schema, table, text } from "../src/dialects/pg/index.js";
import { columnTenancy } from "../src/runtime/tenancy/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "a plain unique adopts with no plan steps",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(
        `create table ${q(schemaName)}.tasks (
          a text not null,
          b text not null,
          unique (a, b)
        )`,
      );
      const matching = schema({
        tables: [table("tasks", { a: text(), b: text() }, { unique: { row: ["a", "b"] } })],
      });
      const found = await introspectSchema(queryOf(sql), schemaName, "public");
      const expected = await rendered(sql, schemaName, matching.catalog);
      const plan = planMigration({
        before: found,
        after: expected,
        schema: schemaName,
        name: "adopt",
      });
      expect(plan.steps).toEqual([]);
      const unique = found.objects.find(
        (object) => object.kind === "constraint" && object.definition.constraintKind === "unique",
      );
      expect(unique?.kind === "constraint" ? unique.identity.name : "").toBe("tasks_a_b_key");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "an old catalog renames constraints and the second plan is empty",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const current = tenantSchema();
      const previous = legacyNames(current.catalog);
      await apply(sql, renderCatalog(previous, schemaName));
      const plan = planMigration({
        before: previous,
        after: current.catalog,
        schema: schemaName,
        name: "names",
      });
      expect(plan.steps.length).toBeGreaterThan(0);
      expect(plan.steps.every((step) => step.sql.includes("rename constraint"))).toBe(true);
      await apply(
        sql,
        plan.steps.map((step) => step.sql),
      );
      const again = planMigration({
        before: current.catalog,
        after: current.catalog,
        schema: schemaName,
        name: "again",
      });
      expect(again.steps).toEqual([]);

      const tenant = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const first = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c02";
      const second = "01890c5a-8f0e-7c3a-9b2d-6e4f1a0b9c03";
      await sql.unsafe(
        `insert into ${q(schemaName)}.tasks (id, tenant_id, title) values ('${first}', '${tenant}', 'one')`,
      );
      let caught: unknown;
      try {
        await sql.unsafe(
          `insert into ${q(schemaName)}.tasks (id, tenant_id, title) values ('${second}', '${tenant}', 'one')`,
        );
      } catch (error) {
        caught = error;
      }
      const mapped = mapPostgresError(mapDriverError(caught), {
        schema: { catalog: current.catalog, model: current.model },
      });
      expect(mapped.kind).toBe("unique");
      expect(mapped.fieldReason).toBe("title");
    });
  },
  30_000,
);

function tenantSchema() {
  return schema({
    casing: "snake",
    tenancy: columnTenancy({ key: "tenantId", type: "uuid" }),
    tables: [table("tasks", { id: id({ default: "none" }), title: text().unique() })],
  });
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

async function rendered(sql: Sql, schemaName: string, source: Catalog): Promise<Catalog> {
  await sql.unsafe(`drop schema if exists ${q(schemaName)} cascade`);
  await sql.unsafe(`create schema ${q(schemaName)}`);
  await sql.unsafe(`set search_path to ${q(schemaName)}`);
  await apply(sql, renderCatalog(source, schemaName));
  return introspectSchema(queryOf(sql), schemaName, "public");
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}

async function apply(sql: Sql, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    await sql.unsafe(statement);
  }
}

function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
