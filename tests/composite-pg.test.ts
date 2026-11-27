/**
 * Composite types on Postgres: create, read, write, nulls, and a clean round trip.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { schemaDeclarations } from "../src/dialects/pg/declarations.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

const address = t.composite("address", {
  street: t.text(),
  city: t.text(),
  zip: t.text().nullable(),
});

function people() {
  return schema({
    tables: [
      table("people", {
        id: t.integer().primaryKey(),
        home: address,
        work: address.nullable(),
      }),
    ],
  });
}

postgresTest(
  gate,
  "a composite type round-trips with field nulls and rejects a null field",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = people();
      const created = planMigration({
        before: schema({ tables: [] }).catalog,
        after: app.catalog,
        schema: schemaName,
        name: "create",
      });
      const sqlText = created.steps.map((step) => step.sql);
      expect(sqlText.some((statement) => statement.toLowerCase().startsWith("create type"))).toBe(
        true,
      );
      const typeAt = sqlText.findIndex((statement) =>
        statement.toLowerCase().startsWith("create type"),
      );
      const tableAt = sqlText.findIndex((statement) =>
        statement.toLowerCase().startsWith("create table"),
      );
      expect(typeAt).toBeGreaterThanOrEqual(0);
      expect(typeAt).toBeLessThan(tableAt);
      await apply(sql, sqlText);

      await sql.unsafe(
        `insert into people (id, home) values (1, jsonb_populate_record(null::address, '{"street":"a","city":"Riyadh","zip":null}'::jsonb))`,
      );
      await expectRejected(
        sql,
        `insert into people (id, home) values (2, jsonb_populate_record(null::address, '{"street":"a","city":null,"zip":null}'::jsonb))`,
      );

      const live = await introspectSchema(queryOf(sql), schemaName, "public");
      const type = live.objects.find(
        (object) => object.kind === "type" && object.identity.name === "address",
      );
      expect(type?.kind).toBe("type");
      if (type?.kind === "type" && "fields" in type.definition) {
        const byName = new Map(type.definition.fields.map((field) => [field.name, field.nullable]));
        expect(byName.get("street")).toBe(false);
        expect(byName.get("city")).toBe(false);
        expect(byName.get("zip")).toBe(true);
      }
      const again = planMigration({
        before: live,
        after: app.catalog,
        schema: schemaName,
        name: "again",
      });
      expect(again.steps.map((step) => step.sql)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:type.composite",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = people();
      await applyPlan(sql, schema({ tables: [] }).catalog, app.catalog, schemaName);
      const noted = schema({
        tables: [
          table("people", {
            id: t.integer().primaryKey(),
            home: t.composite("address", {
              street: t.text(),
              city: t.text(),
              zip: t.text().nullable(),
              note: t.text().nullable(),
            }),
            work: address.nullable(),
          }),
        ],
      });
      const added = planMigration({
        before: app.catalog,
        after: noted.catalog,
        schema: schemaName,
        name: "add",
      });
      expect(added.steps.some((step) => step.sql.toLowerCase().includes("add attribute"))).toBe(
        true,
      );
      await apply(
        sql,
        added.steps.map((step) => step.sql),
      );
      const live = await introspectSchema(queryOf(sql), schemaName, "public");
      const settled = planMigration({
        before: live,
        after: noted.catalog,
        schema: schemaName,
        name: "settled",
      });
      expect(settled.steps.map((step) => step.sql)).toEqual([]);
      await sql.unsafe(`update people set home.city = 'Jeddah' where id is null`);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:comment.composite",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = schema({
        tables: [
          table("people", {
            id: t.integer().primaryKey(),
            home: t.composite(
              "address",
              { street: t.text().comment("road"), city: t.text() },
              { comment: "where someone lives" },
            ),
          }),
        ],
      });
      await applyPlan(sql, schema({ tables: [] }).catalog, app.catalog, schemaName);
      const live = await introspectSchema(queryOf(sql), schemaName, "public");
      const type = live.objects.find(
        (object) => object.kind === "type" && object.identity.name === "address",
      );
      expect(type?.comment).toBe("where someone lives");
      if (type?.kind === "type" && "fields" in type.definition) {
        expect(type.definition.fields.find((field) => field.name === "street")?.comment).toBe(
          "road",
        );
      }
      expect(
        planMigration({
          before: live,
          after: app.catalog,
          schema: schemaName,
          name: "comments",
        }).steps,
      ).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a renamed composite field follows on the server",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = people();
      await applyPlan(sql, schema({ tables: [] }).catalog, app.catalog, schemaName);
      const next = schema({
        tables: [
          table("people", {
            id: t.integer().primaryKey(),
            home: t.composite("address", {
              street: t.text(),
              town: t.text().renamedFrom("city"),
              zip: t.text().nullable(),
            }),
            work: t
              .composite("address", {
                street: t.text(),
                town: t.text().renamedFrom("city"),
                zip: t.text().nullable(),
              })
              .nullable(),
          }),
        ],
      });
      const plan = planMigration({
        before: app.catalog,
        after: next.catalog,
        renames: schemaDeclarations(next).renames,
        schema: schemaName,
        name: "rename",
      });
      expect(plan.steps[0]?.sql.toLowerCase()).toBe(
        `alter type "${schemaName}"."address" rename attribute "city" to "town"`,
      );
      await apply(
        sql,
        plan.steps.map((step) => step.sql),
      );
      const live = await introspectSchema(queryOf(sql), schemaName, "public");
      expect(
        planMigration({
          before: live,
          after: next.catalog,
          schema: schemaName,
          name: "after-rename",
        }).steps,
      ).toEqual([]);
    });
  },
  30_000,
);

async function applyPlan(
  sql: Sql,
  before: ReturnType<typeof people>["catalog"],
  after: ReturnType<typeof people>["catalog"],
  schemaName: string,
): Promise<void> {
  const plan = planMigration({ before, after, schema: schemaName, name: "apply" });
  await apply(
    sql,
    plan.steps.map((step) => step.sql),
  );
}

async function expectRejected(sql: Sql, statement: string): Promise<void> {
  try {
    await sql.unsafe(statement);
  } catch {
    return;
  }
  throw new Error(`expected ${statement} to fail`);
}

async function apply(sql: Sql, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await sql.unsafe(statement);
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
