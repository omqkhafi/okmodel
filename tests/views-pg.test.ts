/**
 * Views and materialized views on Postgres.
 *
 * Create, compatible replace, a column change under a dependent view,
 * drop order, materialized view populate and concurrent refresh, and an
 * empty second plan. Scratch verification reads `pg_depend`.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { sealViews } from "../src/dialects/pg/view/scratch.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "a view is created, replaced, and the second introspection has no steps",
  async () => {
    await using(async (sql) => {
      const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const declared = schema({
        tables: [tasks],
        views: [
          view("active_tasks", {
            columns: [
              { name: "id", type: "text" },
              { name: "title", type: "text" },
            ],
            query: "select id, title from tasks where title is not null",
          }),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      const edge = sealed.objects.find((object) => object.kind === "view");
      expect(
        edge?.dependencies.some(
          (item) => item.target.kind === "column" && item.target.name === "title",
        ),
      ).toBe(true);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into tasks (id, title) values ('1', 'a')`);
      const rows = await sql<{ id: string }[]>`select id from active_tasks`;
      expect(rows[0]?.id).toBe("1");

      const appended = schema({
        tables: [tasks],
        views: [
          view("active_tasks", {
            columns: [
              { name: "id", type: "text" },
              { name: "title", type: "text" },
              { name: "marker", type: "integer" },
            ],
            query: "select id, title, 1 as marker from tasks where title is not null",
          }),
        ],
      });
      const sealedNext = await sealViews(queryOf(sql), appended.catalog);
      const plan = planMigration({ before: sealed, after: sealedNext, name: "append" });
      expect(plan.steps.some((step) => step.behavior === "change")).toBe(true);
      expect(plan.steps.some((step) => step.sql.startsWith("create or replace view"))).toBe(true);
      await apply(sql, sealed, sealedNext);

      const live = await introspectSchema(queryOf(sql), "public", "public");
      const second = await introspectSchema(queryOf(sql), "public", "public");
      expect(planMigration({ before: live, after: second, name: "again" }).steps).toEqual([]);
      expect(viewSteps(live, sealedNext)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a column change drops the view, alters, and recreates it",
  async () => {
    await using(async (sql) => {
      const before = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],
        views: [
          view("active_tasks", {
            columns: [
              { name: "id", type: "text" },
              { name: "title", type: "text" },
            ],
            query: "select id, title from tasks",
          }),
        ],
      });
      const sealed = await sealViews(queryOf(sql), before.catalog);
      await apply(sql, catalog([]), sealed);
      const after = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.integer() })],
        views: [
          view("active_tasks", {
            columns: [
              { name: "id", type: "text" },
              { name: "title", type: "integer" },
            ],
            query: "select id, title from tasks",
          }),
        ],
      });
      const sealedAfter = await sealViews(queryOf(sql), after.catalog);
      const plan = planMigration({ before: sealed, after: sealedAfter, name: "type" });
      const statements = plan.steps.map((step) => step.sql);
      expect(statements.join("\n").toLowerCase()).not.toContain("cascade");
      expect(indexOf(statements, "drop view")).toBeLessThan(indexOf(statements, "alter table"));
      expect(indexOf(statements, "alter table")).toBeLessThan(indexOf(statements, "create view"));
      expect(statements.some((step) => step.includes("set data type"))).toBe(true);
      await apply(sql, sealed, sealedAfter);
      await sql.unsafe(`insert into tasks (id, title) values ('1', 2)`);
      const rows = await sql<{ title: number }[]>`select title from active_tasks`;
      expect(rows[0]?.title).toBe(2);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "drop removes the view before the table",
  async () => {
    await using(async (sql) => {
      const app = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],
        views: [
          view("active_tasks", {
            columns: [{ name: "id", type: "text" }],
            query: "select id from tasks",
          }),
        ],
      });
      const sealed = await sealViews(queryOf(sql), app.catalog);
      await apply(sql, catalog([]), sealed);
      const plan = planMigration({ before: sealed, after: catalog([]), name: "drop" });
      const statements = plan.steps.map((step) => step.sql);
      expect(indexOf(statements, "drop view")).toBeLessThan(indexOf(statements, "drop table"));
      await apply(sql, sealed, catalog([]));
      const left = await sql<{ count: string }[]>`
        select count(*)::text as count from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'active_tasks'
      `;
      expect(left[0]?.count).toBe("0");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a materialized view is populated and refreshes concurrently",
  async () => {
    await using(async (sql) => {
      const app = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],
        views: [
          materializedView("task_titles", {
            columns: [
              { name: "id", type: "text" },
              { name: "title", type: "text" },
            ],
            query: "select id, title from tasks",
            indexes: [{ name: "task_titles_id", columns: ["id"], unique: true }],
            refresh: "concurrently",
          }),
        ],
      });
      const sealed = await sealViews(queryOf(sql), app.catalog);
      const plan = planMigration({ before: catalog([]), after: sealed, name: "create" });
      expect(plan.steps.some((step) => step.sql.includes("with no data"))).toBe(true);
      expect(plan.steps.some((step) => step.action === "backfill")).toBe(true);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into tasks (id, title) values ('1', 'a')`);
      await sql.unsafe(`refresh materialized view concurrently task_titles`);
      const rows = await sql<{ title: string }[]>`select title from task_titles`;
      expect(rows[0]?.title).toBe("a");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const second = await introspectSchema(queryOf(sql), "public", "public");
      expect(planMigration({ before: live, after: second, name: "again" }).steps).toEqual([]);
    });
  },
  30_000,
);

async function apply(sql: Sql, before: Catalog, after: Catalog): Promise<void> {
  const plan = planMigration({ before, after, name: "apply" });
  for (const step of plan.steps) await sql.unsafe(step.sql);
}

async function using(body: (sql: Sql) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await body(sql);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

function viewSteps(before: Catalog, after: Catalog): string[] {
  return planMigration({ before, after, name: "views" })
    .steps.map((step) => step.sql)
    .filter((statement) => /\bview\b/i.test(statement));
}

function indexOf(sql: readonly string[], prefix: string): number {
  const found = sql.findIndex((step) => step.startsWith(prefix));
  if (found < 0) throw new Error(`missing ${prefix}`);
  return found;
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
