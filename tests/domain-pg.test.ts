/**
 * Domain lifecycle on Postgres: create, check, alter, drop, and introspection.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();
const open = "((VALUE > 0))";
const tight = "((VALUE > 1))";

function people(expression: string) {
  return schema({
    tables: [table("people", { n: t.domain("pos", t.integer(), expression) })],
  });
}

postgresTest(
  gate,
  "a domain accepts a value, rejects another, changes its check, drops, and does not drift",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const app = people(open);
      const created = planMigration({
        before: schema({ tables: [] }).catalog,
        after: app.catalog,
        schema: schemaName,
        name: "create",
      });
      expect(created.steps.some((step) => step.sql.startsWith("create domain"))).toBe(true);
      await apply(
        sql,
        created.steps.map((step) => step.sql),
      );
      await sql.unsafe(`insert into people (n) values (2)`);
      await expectRejected(sql, `insert into people (n) values (0)`);

      const live = await introspectSchema(queryOf(sql), schemaName, "public");
      const again = planMigration({
        before: live,
        after: app.catalog,
        schema: schemaName,
        name: "again",
      });
      expect(again.steps.map((step) => step.sql)).toEqual([]);

      const tighter = people(tight);
      const changed = planMigration({
        before: app.catalog,
        after: tighter.catalog,
        schema: schemaName,
        name: "tighten",
      });
      const text = changed.steps
        .map((step) => step.sql)
        .join("\n")
        .toLowerCase();
      expect(text).toContain("not valid");
      expect(text).toContain("validate constraint");
      expect(text).not.toContain("cascade");
      await apply(
        sql,
        changed.steps.map((step) => step.sql),
      );
      await expectRejected(sql, `insert into people (n) values (1)`);
      await sql.unsafe(`insert into people (n) values (3)`);

      const afterChange = await introspectSchema(queryOf(sql), schemaName, "public");
      const settled = planMigration({
        before: afterChange,
        after: tighter.catalog,
        schema: schemaName,
        name: "settled",
      });
      expect(settled.steps.map((step) => step.sql)).toEqual([]);

      const dropped = planMigration({
        before: tighter.catalog,
        after: schema({ tables: [] }).catalog,
        schema: schemaName,
        name: "drop",
      });
      const dropSql = dropped.steps
        .map((step) => step.sql)
        .join("\n")
        .toLowerCase();
      expect(dropSql).toContain("drop type");
      expect(dropSql).not.toContain("cascade");
      await apply(
        sql,
        dropped.steps.map((step) => step.sql),
      );
      const gone = await sql<{ typname: string }[]>`
        select typname from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = ${schemaName} and t.typname = 'pos'
      `;
      expect(gone).toHaveLength(0);
    });
  },
  30_000,
);

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
