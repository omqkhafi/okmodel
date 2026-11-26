/**
 * Typed views and materialized views on Postgres.
 *
 * Round trip, planner rules, security, expressions, and to-one paths.
 * The registry proof titles are the `postgresTest` names below.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { viewObject } from "../src/contracts/catalog/view.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { and, index, not, one, schema, table, t } from "../src/dialects/pg/index.js";
import { col, setweight, toTsvector } from "../src/dialects/pg/expr/index.js";
import { materializedView, view } from "../src/dialects/pg/view/index.js";
import { sealViews } from "../src/dialects/pg/view/scratch.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

const projects = table("projects", { id: t.text().primaryKey(), name: t.text() });
const notes = table("notes", { id: t.text().primaryKey(), title: t.text() });
const linked = table(
  "notes",
  {
    id: t.text().primaryKey(),
    title: t.text(),
    projectId: t.text().nullable().references("projects"),
  },
  { relations: { project: one("projects", "projectId") } },
);

postgresTest(
  gate,
  "proof:view.typed",
  async () => {
    await using(async (sql) => {
      const declared = schema({
        tables: [notes, projects],
        views: [
          view("open_notes", { tables: [notes] }, (q) =>
            q.notes.find({ select: ["id", "title"], where: { title: not(null) } }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into notes (id, title) values ('1', 'a')`);
      const rows = await sql<{ title: string }[]>`select title from open_notes`;
      expect(rows[0]?.title).toBe("a");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(viewSteps(live, sealed)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:view.materialized",
  async () => {
    await using(async (sql) => {
      const declared = schema({
        tables: [notes],
        views: [
          materializedView(
            "note_titles",
            {
              tables: [notes],
              refresh: "concurrently",
              indexes: (columns) => [index(columns.id).unique()],
            },
            (q) => q.notes.find({ select: ["id", "title"] }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into notes (id, title) values ('1', 'a')`);
      await sql.unsafe(`refresh materialized view concurrently note_titles`);
      const rows = await sql<{ title: string }[]>`select title from note_titles`;
      expect(rows[0]?.title).toBe("a");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(viewSteps(live, sealed)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:view.security",
  async () => {
    await using(async (sql) => {
      const invoker = view("invoker_notes", { tables: [notes], security: "invoker" }, (q) =>
        q.notes.find({ select: ["id"] }),
      );
      const definer = view(
        "definer_notes",
        { tables: [notes], security: { definer: "the owner reads the base table" } },
        (q) => q.notes.find({ select: ["id"] }),
      );
      const declared = schema({ tables: [notes], views: [invoker, definer] });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into notes (id, title) values ('1', 'a')`);
      await sql.unsafe(`drop role if exists view_reader`);
      await sql.unsafe(`create role view_reader nologin`);
      await sql.unsafe(`grant usage on schema public to view_reader`);
      await sql.unsafe(`grant select on invoker_notes, definer_notes to view_reader`);
      const asReader = async (query: string): Promise<unknown> => {
        await sql.unsafe(`set role view_reader`);
        try {
          return await sql.unsafe(query);
        } finally {
          await sql.unsafe(`reset role`);
        }
      };
      let refused = false;
      try {
        await asReader(`select id from invoker_notes`);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      const rows = (await asReader(`select id from definer_notes`)) as { id: string }[];
      expect(rows[0]?.id).toBe("1");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(viewSteps(live, sealed)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:view.checkOption",
  async () => {
    await using(async (sql) => {
      const declared = schema({
        tables: [notes],
        views: [
          view("checked_notes", { tables: [notes], checkOption: "local" }, (q) =>
            q.notes.find({ select: ["id", "title"], where: { title: not(null) } }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      await apply(sql, catalog([]), sealed);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(viewSteps(live, sealed)).toEqual([]);
      const object = live.objects.find((item) => item.kind === "view");
      expect(object?.kind === "view" ? object.definition.checkOption : "").toBe("local");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:matview.refresh",
  async () => {
    await using(async (sql) => {
      const declared = schema({
        tables: [notes],
        views: [
          materializedView(
            "fresh_notes",
            {
              tables: [notes],
              refresh: "concurrently",
              indexes: (columns) => [index(columns.id).unique()],
            },
            (q) => q.notes.find({ select: ["id"] }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      const plan = planMigration({ before: catalog([]), after: sealed, name: "create" });
      expect(plan.steps.some((step) => step.sql.includes("with no data"))).toBe(true);
      expect(plan.steps.some((step) => step.sql.startsWith("refresh materialized view "))).toBe(
        true,
      );
      expect(
        plan.steps.some((step) => step.sql.startsWith("refresh materialized view concurrently")),
      ).toBe(false);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into notes (id, title) values ('1', 'a')`);
      await sql.unsafe(`refresh materialized view concurrently fresh_notes`);
      const rows = await sql<{ id: string }[]>`select id from fresh_notes`;
      expect(rows[0]?.id).toBe("1");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:view.dependencyOrder",
  async () => {
    await using(async (sql) => {
      const inner = view("inner_notes", { tables: [notes] }, (q) =>
        q.notes.find({ select: ["id"] }),
      );
      const outer = view("outer_notes", { tables: [inner] }, (q) => q.inner_notes.find());
      const declared = schema({ tables: [notes], views: [outer, inner] });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      const plan = planMigration({ before: catalog([]), after: sealed, name: "create" });
      const statements = plan.steps.map((step) => step.sql);
      expect(indexOf(statements, "create view")).toBeLessThan(
        indexOf(statements, 'create view "public"."outer_notes"'),
      );
      await apply(sql, catalog([]), sealed);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(viewSteps(live, sealed)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:query.exprSelect",
  async () => {
    await using(async (sql) => {
      const declared = schema({
        tables: [notes],
        views: [
          view("weighted_notes", { tables: [notes] }, (q) =>
            q.notes.find({
              select: [
                toTsvector("simple", col("title")).as("vector"),
                setweight(toTsvector("simple", "hello"), "A").as("weighted"),
              ],
            }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into notes (id, title) values ('1', 'hello')`);
      const rows = await sql<{ vector: string; weighted: string }[]>`
        select vector::text as vector, weighted::text as weighted from weighted_notes
      `;
      expect(rows[0]?.vector.toLowerCase()).toContain("hello");
      expect(rows[0]?.weighted.toLowerCase()).toContain("hello");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "proof:query.toOnePath",
  async () => {
    await using(async (sql) => {
      const declared = schema({
        tables: [projects, linked],
        views: [
          view("named_notes", { tables: [linked, projects] }, (q) =>
            q.notes.find({
              select: ["id", "project.name"],
              where: and([{ title: not(null) }, { "project.name": "alpha" }]),
            }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into projects (id, name) values ('p', 'alpha')`);
      await sql.unsafe(`insert into notes (id, title, "projectId") values ('1', 'a', 'p')`);
      await sql.unsafe(`insert into notes (id, title, "projectId") values ('2', 'b', null)`);
      const rows = await sql<{ id: string; name: string }[]>`select id, name from named_notes`;
      expect(rows.map((row) => row.id)).toEqual(["1"]);
      expect(rows[0]?.name).toBe("alpha");
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a column rename is alter view rename column and a type change drops the view",
  async () => {
    await using(async (sql) => {
      const before = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],
        views: [
          view("task_rows", { tables: [] }, (q) =>
            q.sql({
              columns: [
                { name: "id", type: t.text() },
                { name: "title", type: t.text() },
              ],
              query: "select id, title from tasks",
            }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), before.catalog);
      await apply(sql, catalog([]), sealed);
      const sealedRename = catalog(
        sealed.objects.map((object) => {
          if (object.kind !== "view") return object;
          return viewObject({
            namespace: object.identity.namespace,
            name: object.identity.name,
            columns: object.definition.columns.map((column) =>
              column.name === "title" ? { ...column, name: "heading" } : column,
            ),
            query: object.definition.query,
            provenance: object.provenance,
            dependencies: object.dependencies.map((edge) => edge.target),
            ...(object.definition.securityInvoker === true
              ? { securityInvoker: true as const }
              : {}),
            ...(object.definition.securityBarrier === true
              ? { securityBarrier: true as const }
              : {}),
            ...(object.definition.checkOption !== undefined
              ? { checkOption: object.definition.checkOption }
              : {}),
          });
        }),
      );
      const renamePlan = planMigration({ before: sealed, after: sealedRename, name: "rename" });
      expect(renamePlan.steps.some((step) => step.sql.includes("rename column"))).toBe(true);
      const typed = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.integer() })],
        views: [
          view("task_rows", { tables: [] }, (q) =>
            q.sql({
              columns: [
                { name: "id", type: t.text() },
                { name: "title", type: t.integer() },
              ],
              query: "select id, title from tasks",
            }),
          ),
        ],
      });
      const sealedType = await sealViews(queryOf(sql), typed.catalog);
      const typePlan = planMigration({ before: sealed, after: sealedType, name: "type" });
      const statements = typePlan.steps.map((step) => step.sql);
      expect(indexOf(statements, "drop view")).toBeLessThan(indexOf(statements, "alter table"));
      expect(indexOf(statements, "alter table")).toBeLessThan(indexOf(statements, "create view"));
      await apply(sql, sealed, sealedType);
      await sql.unsafe(`insert into tasks (id, title) values ('1', 2)`);
      const rows = await sql<{ title: number }[]>`select title from task_rows`;
      expect(rows[0]?.title).toBe(2);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a plan built against the old column type still drops and recreates after the table changes",
  async () => {
    await using(async (sql) => {
      const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });
      const before = schema({
        tables: [tasks],
        views: [
          view("task_rows", { tables: [tasks] }, (q) => q.tasks.find({ select: ["id", "title"] })),
        ],
      });
      const sealed = await sealViews(queryOf(sql), before.catalog);
      await apply(sql, catalog([]), sealed);
      const after = schema({
        tables: [table("tasks", { id: t.text().primaryKey(), title: t.integer() })],
        views: [
          view("task_rows", { tables: [] }, (q) =>
            q.sql({
              columns: [
                { name: "id", type: t.text() },
                { name: "title", type: t.integer() },
              ],
              query: "select id, title from tasks",
            }),
          ),
        ],
      });
      const sealedAfter = await sealViews(queryOf(sql), after.catalog);
      const plan = planMigration({ before: sealed, after: sealedAfter, name: "race" });
      await sql.unsafe(`insert into tasks (id, title) values ('1', '9')`);
      await applySteps(
        sql,
        plan.steps.map((step) => step.sql),
      );
      const rows = await sql<{ title: number }[]>`select title from task_rows`;
      expect(rows[0]?.title).toBe(9);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "a non-null view column that comes back null is OKM1901",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const loose = table("notes", { id: t.text().primaryKey(), title: t.text().nullable() });
      const declared = schema({
        tables: [loose],
        views: [
          view("strict_notes", { tables: [] }, (q) =>
            q.sql({
              columns: [{ name: "title", type: t.text() }],
              query: "select title from notes",
            }),
          ),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      await apply(sql, catalog([]), sealed);
      await sql.unsafe(`insert into notes (id, title) values ('1', null)`);
      const { connect } = await import("../src/runtime/pg/postgresjs.js");
      const db = connect(database.url, { schema: declared, max: 1 });
      try {
        await db.connected;
        let caught: unknown;
        try {
          await db.views.strictNotes.find({ limit: 1 });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(OkmError);
        expect(caught instanceof OkmError ? caught.code : "").toBe("OKM1901");
      } finally {
        await db.close();
      }
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

async function apply(sql: Sql, before: Catalog, after: Catalog): Promise<void> {
  const plan = planMigration({ before, after, name: "apply" });
  await applySteps(
    sql,
    plan.steps.map((step) => step.sql),
  );
}

async function applySteps(sql: Sql, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await sql.unsafe(statement);
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
  const found = sql.findIndex((step) => step.startsWith(prefix) || step.includes(prefix));
  if (found < 0) throw new Error(`missing ${prefix} in ${sql.join(" | ")}`);
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

void OkmError;
