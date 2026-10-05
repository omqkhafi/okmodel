/**
 * Functions and triggers on Postgres.
 *
 * Create, replace, drop order, a trigger firing, timestamps enforcement,
 * and an empty second plan. OKM1823 and OKM1824 are declaration checks.
 */

import { expect, test } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { fn, trigger } from "../src/dialects/pg/fn/index.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, table, t } from "../src/dialects/pg/index.js";
import { timestamps } from "../src/runtime/traits/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

test("plpgsql without dependsOn is OKM1824 and security definer without search_path is OKM1823", () => {
  expect(
    capture(() =>
      fn("touch", { returns: "trigger", language: "plpgsql", body: "begin return new; end" }),
    ).code,
  ).toBe("OKM1824");
  expect(
    capture(() =>
      fn("read", {
        returns: "integer",
        language: "sql",
        security: "definer",
        body: "begin atomic select 1; end",
      }),
    ).code,
  ).toBe("OKM1823");
});

postgresTest(
  gate,
  "a trigger fires, a compatible replace changes it, and the second plan is empty",
  async () => {
    await using(async (sql) => {
      const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const first = touch(tasks, "begin new.title = 'one'; return new; end");
      const app = schema({
        tables: [tasks],
        functions: [first],
        triggers: [onTasks(tasks, first)],
      });
      await apply(sql, catalog([]), app.catalog);
      await sql.unsafe(`insert into tasks (id, title) values ('1', 'a')`);
      await sql.unsafe(`update tasks set title = 'b' where id = '1'`);
      expect(await title(sql)).toBe("one");

      const replaced = schema({
        tables: [tasks],
        functions: [touch(tasks, "begin new.title = 'two'; return new; end")],
        triggers: [onTasks(tasks, touch(tasks, "begin new.title = 'two'; return new; end"))],
      });
      const plan = planMigration({ before: app.catalog, after: replaced.catalog, name: "replace" });
      expect(plan.steps.some((step) => step.behavior === "change")).toBe(true);
      await apply(sql, app.catalog, replaced.catalog);
      await sql.unsafe(`update tasks set title = 'c' where id = '1'`);
      expect(await title(sql)).toBe("two");

      const live = await introspectSchema(queryOf(sql), "public", "public");
      const second = await introspectSchema(queryOf(sql), "public", "public");
      expect(planMigration({ before: live, after: second, name: "again" }).steps).toEqual([]);
      expect(routineSteps(live, replaced.catalog)).toEqual([]);
      expect(bodyOf(live, "touch")).toBe("begin new.title = 'two'; return new; end");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "an incompatible return type is drop and create, never create or replace",
  async () => {
    await using(async (sql) => {
      const tasks = table("tasks", { id: t.text().primaryKey() });
      const before = schema({
        tables: [tasks],
        functions: [
          fn("slugify", {
            arguments: [{ name: "title", type: "text" }],
            returns: "integer",
            language: "plpgsql",
            body: "begin return 1; end",
            dependsOn: [tasks],
          }),
        ],
      });
      const after = schema({
        tables: [tasks],
        functions: [
          fn("slugify", {
            arguments: [{ name: "title", type: "text" }],
            returns: "text",
            language: "plpgsql",
            body: "begin return 'a'; end",
            dependsOn: [tasks],
          }),
        ],
      });
      await apply(sql, catalog([]), before.catalog);
      const plan = planMigration({ before: before.catalog, after: after.catalog, name: "returns" });
      expect(plan.steps.some((step) => step.sql.startsWith("create or replace"))).toBe(false);
      expect(
        plan.steps
          .map((step) => step.sql)
          .join("\n")
          .toLowerCase(),
      ).not.toContain("cascade");
      await apply(sql, before.catalog, after.catalog);
      const rows = await sql<{ result: string }[]>`
      select pg_get_function_result(p.oid) as result
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'slugify'
    `;
      expect(rows[0]?.result).toBe("text");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "drop removes the trigger before the function",
  async () => {
    await using(async (sql) => {
      const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const body = touch(tasks, "begin return new; end");
      const app = schema({
        tables: [tasks],
        functions: [body],
        triggers: [onTasks(tasks, body)],
      });
      await apply(sql, catalog([]), app.catalog);
      const plan = planMigration({ before: app.catalog, after: catalog([]), name: "drop" });
      const sqlText = plan.steps.map((step) => step.sql);
      expect(sqlText.findIndex((step) => step.startsWith("drop trigger"))).toBeLessThan(
        sqlText.findIndex((step) => step.startsWith("drop function")),
      );
      await apply(sql, app.catalog, catalog([]));
      const left = await sql<{ count: string }[]>`
      select count(*)::text as count from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'touch'
    `;
      expect(left[0]?.count).toBe("0");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "timestamps enforcement overwrites updated_at and the second plan is empty",
  async () => {
    await using(async (sql) => {
      const app = schema({
        casing: "snake",
        tables: [
          table(
            "notes",
            { id: t.text().primaryKey() },
            { traits: [timestamps({ enforce: "trigger" })] },
          ),
        ],
      });
      await apply(sql, catalog([]), app.catalog);
      await sql.unsafe(`insert into notes (id) values ('1')`);
      await sql.unsafe(`update notes set updated_at = '2000-01-01T00:00:00Z' where id = '1'`);
      const rows = await sql<{ updated_at: Date }[]>`select updated_at from notes where id = '1'`;
      const stamp = rows[0]?.updated_at;
      expect(stamp).toBeInstanceOf(Date);
      expect(stamp?.getUTCFullYear()).toBeGreaterThan(2000);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const second = await introspectSchema(queryOf(sql), "public", "public");
      expect(planMigration({ before: live, after: second, name: "again" }).steps).toEqual([]);
      expect(routineSteps(live, app.catalog)).toEqual([]);
      expect(bodyOf(live, "okm_touch_updated_at")).toBe(
        'begin new."updated_at" = now(); return new; end',
      );
    });
  },
  30_000,
);

postgresTest(
  gate,
  "begin atomic reads dependencies from pg_depend",
  async () => {
    await using(async (sql) => {
      const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const app = schema({
        tables: [tasks],
        functions: [
          fn("count_tasks", {
            returns: "bigint",
            language: "sql",
            body: "begin atomic select count(*) from tasks; end",
          }),
        ],
      });
      await apply(sql, catalog([]), app.catalog);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const again = await introspectSchema(queryOf(sql), "public", "public");
      const drift = planMigration({ before: live, after: again, name: "stable" });
      expect(drift.steps).toEqual([]);
      const found = live.objects.find((object) => object.kind === "function");
      expect(found?.kind === "function" ? found.definition.atomic : undefined).toBe(true);
      expect(
        found?.dependencies.some(
          (edge) => edge.target.kind === "table" && edge.target.name === "tasks",
        ),
      ).toBe(true);
    });
  },
  30_000,
);

function touch(tasks: ReturnType<typeof table>, body: string): ReturnType<typeof fn> {
  return fn("touch", {
    returns: "trigger",
    language: "plpgsql",
    body,
    dependsOn: [tasks],
  });
}

function onTasks(tasks: ReturnType<typeof table>, calls: ReturnType<typeof fn>) {
  return trigger("tasks_touch", {
    on: tasks,
    timing: "before",
    events: ["update"],
    level: "row",
    calls,
  });
}

async function title(sql: Sql): Promise<string> {
  const rows = await sql<{ title: string }[]>`select title from tasks where id = '1'`;
  return rows[0]?.title ?? "";
}

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

function routineSteps(before: Catalog, after: Catalog): string[] {
  return planMigration({ before, after, name: "routines" })
    .steps.map((step) => step.sql)
    .filter((sql) => /\b(function|trigger)\b/i.test(sql));
}

function bodyOf(source: Catalog, name: string): string | undefined {
  const found = source.objects.find(
    (object) => object.kind === "function" && object.identity.name === name,
  );
  return found?.kind === "function" ? found.definition.body : undefined;
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

function capture(runBody: () => unknown): OkmError {
  try {
    runBody();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}
