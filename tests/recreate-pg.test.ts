/**
 * Recreate round-trip across every object kind the planner handles.
 *
 * CI runs seeds 1 through 6, one required shape each (about half a second on
 * the local topology). `OKM_RECREATE_SEEDS` is a count: seeds `1..N` for a
 * longer local run. A failure names the seed.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog } from "../src/contracts/catalog/types.js";
import { schemaDeclarations, type DeclaredRename } from "../src/dialects/pg/declarations.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { pgTrgm, type PgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { fn, trigger, type Routine, type TriggerDeclaration } from "../src/dialects/pg/fn/index.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import {
  index,
  schema,
  sql as sqlText,
  table,
  t,
  type AnyTable,
} from "../src/dialects/pg/index.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { attachRoles, type RolesInput } from "../src/dialects/pg/role/index.js";
import {
  materializedView,
  view,
  type MaterializedViewDeclaration,
  type ViewDeclaration,
} from "../src/dialects/pg/view/index.js";
import { sealViews } from "../src/dialects/pg/view/scratch.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

/**
 * One required recreate case per seed in CI.
 *
 * Seeds past this list repeat a shape and vary a function body and a
 * nullability flip so a longer local run is not six identical pairs.
 */
const SHAPES = [
  "view-column",
  "trigger-function",
  "domain",
  "matview-index",
  "drop-dependents",
  "rename-column",
] as const;

type Shape = (typeof SHAPES)[number];

/** Seeds that run when `OKM_RECREATE_SEEDS` is unset. One pass of {@link SHAPES}. */
const CI_SEED_COUNT = SHAPES.length;

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "sealViews creates domain and enum types before the stub table",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const tasks = table("tasks", {
        id: t.identity(),
        label: t.domain("label", t.text(), "((length(VALUE) > 0))"),
        status: t.enum("color", ["red", "blue"]),
      });
      const declared = schema({
        tables: [tasks],
        views: [
          view("task_ids", {
            columns: [{ name: "id", type: "bigint" }],
            query: "select id from tasks",
          }),
        ],
      });
      const sealed = await sealViews(queryOf(sql), declared.catalog);
      const found = sealed.objects.find((object) => object.kind === "view");
      expect(found?.kind === "view" ? found.definition.columns[0]?.dataType : "").toBe("bigint");
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a recreated view is granted again",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const roles: RolesInput = {
      migration: mig,
      app,
      managed: [{ name: mig }, { name: app }],
    };
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const before = attachRoles(
        schema({
          tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],
          views: [
            view("task_rows", {
              columns: [
                { name: "id", type: "text" },
                { name: "title", type: "text" },
              ],
              query: "select id, title from tasks",
            }),
          ],
        }).catalog,
        roles,
      );
      const after = attachRoles(
        schema({
          tables: [table("tasks", { id: t.text().primaryKey(), title: t.varchar(80) })],
          views: [
            view("task_rows", {
              columns: [
                { name: "id", type: "text" },
                { name: "title", type: "character varying(80)" },
              ],
              query: "select id, title from tasks",
            }),
          ],
        }).catalog,
        roles,
      );
      const runner = queryOf(sql);
      const sealedBefore = await sealViews(runner, before);
      const sealedAfter = await sealViews(runner, after);
      await applyPlan(sql, 0, catalog([]), sealedBefore, []);
      await applyPlan(sql, 0, sealedBefore, sealedAfter, []);
      await expectNoDrift(sql, 0, sealedAfter, roles);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRoles([mig, app]);
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a check keeps the name key it was declared with",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const declared = schema({
        tables: [
          table(
            "tasks",
            { id: t.identity(), email: t.text() },
            {
              checks: {
                emailPresent: (columns) => sqlText`((${columns.email} <> ''::text))`,
              },
            },
          ),
        ],
      });
      await applyPlan(sql, 0, catalog([]), declared.catalog, []);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const check = live.objects.find(
        (object) => object.kind === "constraint" && object.definition.constraintKind === "check",
      );
      expect(check?.kind === "constraint" ? check.definition.nameKey : "").toBe("emailPresent");
      expect(planMigration({ before: live, after: declared.catalog, name: "check" }).steps).toEqual(
        [],
      );
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a plan round-trips to zero steps for every object kind",
  async () => {
    const chosen = recreateSeeds();
    const mig = roleName("mig");
    const app = roleName("app");
    const roles: RolesInput = {
      migration: mig,
      app,
      managed: [{ name: mig }, { name: app }],
    };
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const started = Date.now();
    try {
      for (const seed of chosen) {
        const shape = SHAPES[(seed - 1) % SHAPES.length] ?? "view-column";
        try {
          await roundTrip(sql, seed, shape, roles);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("recreate seed ")) throw error;
          throw new Error(`recreate seed ${seed} (${shape}) failed\n${message}`);
        }
      }
      console.log(`recreate: ${chosen.length} seeds in ${Date.now() - started}ms`);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
      await dropRoles([mig, app]);
    }
  },
  180_000,
);

function recreateSeeds(): readonly number[] {
  const raw = process.env.OKM_RECREATE_SEEDS;
  if (raw === undefined || raw.trim().length === 0) {
    return Array.from({ length: CI_SEED_COUNT }, (_, index) => index + 1);
  }
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`OKM_RECREATE_SEEDS must be a positive integer, got ${raw}`);
  }
  return Array.from({ length: count }, (_, index) => index + 1);
}

async function roundTrip(sql: Sql, seed: number, shape: Shape, roles: RolesInput): Promise<void> {
  await resetDatabase(sql, roles);
  const before = declare(shape, false, seed, roles);
  const after = declare(shape, true, seed, roles);
  const runner = queryOf(sql);
  const sealedBefore = await sealViews(runner, before.catalog);
  const sealedAfter = await sealViews(runner, after.catalog);
  await applyPlan(sql, seed, catalog([]), sealedBefore, []);
  await applyPlan(sql, seed, sealedBefore, sealedAfter, after.renames);
  await expectNoDrift(sql, seed, sealedAfter, roles);
  const reverse = after.renames.map((rename) => invertRename(rename));
  await applyPlan(sql, seed, sealedAfter, sealedBefore, reverse);
  await expectNoDrift(sql, seed, sealedBefore, roles);
}

async function applyPlan(
  sql: Sql,
  seed: number,
  before: Catalog,
  after: Catalog,
  renames: readonly DeclaredRename[],
): Promise<void> {
  const plan = planMigration({
    before,
    after,
    ...(renames.length > 0 ? { renames } : {}),
    name: `recreate-${seed}`,
  });
  for (const step of plan.steps) {
    try {
      await sql.unsafe(step.sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`recreate seed ${seed} failed applying:\n${step.sql}\n${message}`);
    }
  }
}

async function expectNoDrift(
  sql: Sql,
  seed: number,
  author: Catalog,
  roles: RolesInput,
): Promise<void> {
  const managed = [roles.migration, roles.app];
  const live = await introspectSchema(queryOf(sql), "public", "public", { managedRoles: managed });
  const plan = planMigration({ before: live, after: author, name: `recreate-${seed}-check` });
  if (plan.steps.length === 0) return;
  const text = plan.steps.map((step) => step.sql).join("\n");
  throw new Error(`recreate seed ${seed} drifted\n${text}`);
}

async function resetDatabase(sql: Sql, roles: RolesInput): Promise<void> {
  await sql.unsafe("drop extension if exists pg_trgm cascade");
  await sql.unsafe("drop extension if exists citext cascade");
  await sql.unsafe("drop schema if exists public cascade");
  await sql.unsafe("create schema public");
  await sql.unsafe("grant all on schema public to public");
  await sql.unsafe("set search_path to public");
  await dropRole(sql, roles.migration);
  await dropRole(sql, roles.app);
}

async function dropRole(sql: Sql, name: string): Promise<void> {
  const rows = await sql<{ ok: string }[]>`
    select 1::text as ok from pg_roles where rolname = ${name}
  `;
  if (rows.length === 0) return;
  await sql.unsafe(`drop owned by ${quoteIdent(name)}`);
  await sql.unsafe(`drop role if exists ${quoteIdent(name)}`);
}

async function dropRoles(names: readonly string[]): Promise<void> {
  const admin = openPostgres();
  try {
    for (const name of names) await dropRole(admin, name);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function invertRename(rename: DeclaredRename): DeclaredRename {
  if (rename.kind === "table") return { kind: "table", from: rename.to, to: rename.from };
  return { kind: "column", table: rename.table, from: rename.to, to: rename.from };
}

type Declared = {
  readonly catalog: Catalog;
  readonly renames: readonly DeclaredRename[];
};

function declare(shape: Shape, flip: boolean, seed: number, roles: RolesInput): Declared {
  const trgm = pgTrgm();
  const users = table("users", {
    id: t.integer().primaryKey(),
    email: t.text().unique(),
  });
  const drop = shape === "drop-dependents" && flip;
  const tables: AnyTable[] = [users];
  const views: (ViewDeclaration | MaterializedViewDeclaration)[] = [];
  const functions: Routine[] = [];
  const triggers: TriggerDeclaration[] = [];
  if (!drop) {
    const titleName = shape === "rename-column" && flip ? "heading" : "title";
    const tasks = tasksTable(shape, flip, seed, titleName, trgm);
    const body = functionBody(shape, flip, seed, titleName);
    const touch = fn("touch_title", {
      returns: "trigger",
      language: "plpgsql",
      body,
      dependsOn: [tasks],
    });
    const titleType = columnTypeName(shape, flip);
    tables.push(tasks);
    functions.push(touch);
    triggers.push(
      trigger("tasks_touch", {
        on: tasks,
        timing: "before",
        events: ["update"],
        level: "row",
        calls: touch,
      }),
    );
    views.push(
      view("task_rows", {
        columns: [
          { name: "id", type: "bigint" },
          { name: titleName, type: titleType },
        ],
        query: `select id, ${titleName} from tasks`,
      }),
      materializedView("task_titles", {
        columns: [
          { name: "id", type: "bigint" },
          { name: titleName, type: titleType },
        ],
        query: `select id, ${titleName} from tasks`,
        indexes:
          shape === "matview-index"
            ? [{ columns: [titleName], unique: true }]
            : [{ columns: ["id"], unique: true }],
      }),
    );
  }
  const built = schema({
    tables,
    extensions: [trgm, extension("citext")],
    functions,
    triggers,
    views,
  });
  return {
    catalog: attachRoles(built.catalog, roles),
    renames: schemaDeclarations(built).renames,
  };
}

function tasksTable(
  shape: Shape,
  flip: boolean,
  seed: number,
  titleName: string,
  trgm: PgTrgm,
): AnyTable {
  const title = titleColumn(shape, flip);
  const note = seed > CI_SEED_COUNT && flip && seed % 2 === 0 ? t.text() : t.text().nullable();
  const shared = {
    id: t.identity(),
    email: t.text().unique(),
    note,
    label: t.domain("label", t.text(), domainCheck(shape, flip)),
    status: t.enum("color", ["red", "blue"]),
    userId: t.integer().nullable().references("users"),
  };
  const options = {
    indexes: (columns: {
      readonly userId: { readonly name: string };
      readonly email: { readonly name: string };
    }) => [
      index(columns.userId),
      index(columns.email).unique(),
      trgm.gin(titleName),
      trgm.gist("note"),
    ],
    checks: {
      emailPresent: (columns: { readonly email: { readonly name: string } }) =>
        sqlText`((${columns.email} <> ''::text))`,
    },
  };
  if (titleName === "heading") {
    return table("tasks", { ...shared, heading: title.renamedFrom("title") }, options);
  }
  return table("tasks", { ...shared, title }, options);
}

function titleColumn(shape: Shape, flip: boolean) {
  if ((shape === "view-column" || shape === "matview-index") && flip) return t.varchar(80);
  return t.text();
}

function columnTypeName(shape: Shape, flip: boolean): string {
  if ((shape === "view-column" || shape === "matview-index") && flip)
    return "character varying(80)";
  return "text";
}

function domainCheck(shape: Shape, flip: boolean): string {
  if (shape === "domain" && flip) return "((length(VALUE) > 1))";
  return "((length(VALUE) > 0))";
}

function functionBody(shape: Shape, flip: boolean, seed: number, titleName: string): string {
  if (shape === "rename-column") return "begin return new; end";
  const token =
    shape === "trigger-function" && flip ? "b" : seed > CI_SEED_COUNT && flip ? String(seed) : "a";
  return `begin new.${titleName} = '${token}'; return new; end`;
}

function roleName(prefix: string): string {
  return `okm_recreate_${prefix}_${Math.random().toString(36).slice(2, 10)}`;
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
