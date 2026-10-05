/**
 * 0.3 gate: author, push, check, alter, remove.
 *
 * One database per kind, shared across the steps. `push` is only the first
 * step. Later steps plan from the previous catalog, because a second push
 * diffs the migrations snapshot, which this suite does not write.
 *
 * Lines already covered, and not repeated here:
 * - OKM1820: `tests/views.test.ts`
 * - OKM1821: `tests/views.test.ts`, `tests/routines.test.ts`
 * - OKM1822: `tests/views.test.ts`
 * - OKM1823 and OKM1824: `tests/routines.test.ts`
 * - domain base change OKM1020: `tests/domain.test.ts`
 * - non-owner application role, one SET ROLE, default privileges:
 *   `tests/roles-pg.test.ts`
 *
 * RLS is M2. This suite does not enable it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { quoteIdent } from "../src/dialects/pg/ddl.js";
import { extension } from "../src/dialects/pg/ext/index.js";
import { schema } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { projectHead } from "../src/tooling/migrate/project.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const VIEW = "SELECT id,\n    title\n   FROM tasks\n  WHERE title IS NOT NULL";
const VIEW_NEXT =
  "SELECT id,\n    title,\n    1 AS marker\n   FROM tasks\n  WHERE title IS NOT NULL";
const MAT = "SELECT id,\n    title\n   FROM tasks";
const MAT_NEXT = "SELECT id,\n    title\n   FROM tasks\n  WHERE title IS NOT NULL";

postgresTest(
  gate,
  "an extension round-trips, and a missing extension is OKM1811 before any statement",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const dirs: string[] = [];
    let cwd = project(database.url, extensionHeader, extensionV1, undefined, dirs);
    try {
      const missing = schema({
        tables: [],
        extensions: [extension("okm_not_a_real_extension")],
      });
      const refused = await refusal(() =>
        applyTarget({
          url: database.url,
          target: "default",
          protected: false,
          migrations: [
            {
              id: "missing",
              catalogHash: "missing",
              steps: planMigration({
                before: catalog([]),
                after: missing.catalog,
                name: "missing",
              }).steps,
            },
          ],
        }),
      );
      expect(refused.code).toBe("OKM1811");
      const meta = await sql<{ reg: string | null }[]>`
        select to_regclass('public.okm_meta')::text as reg
      `;
      expect(meta[0]?.reg ?? null).toBeNull();

      await pushCheck(cwd);
      cwd = (await alter(cwd, database.url, extensionHeader, extensionV2, "0002_trgm", dirs)).cwd;
      cwd = (await alter(cwd, database.url, extensionHeader, extensionV3, "0003_drop", dirs)).cwd;
      const left = await sql<{ name: string }[]>`
        select extname as name from pg_extension
        where extname in ('citext', 'pg_trgm')
      `;
      expect(left).toHaveLength(0);
      const table = await sql<{ reg: string | null }[]>`
        select to_regclass('public.people')::text as reg
      `;
      expect(table[0]?.reg ?? null).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a domain check changes and the domain drops with no cascade",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const dirs: string[] = [];
    let cwd = project(database.url, domainHeader, domainV1, undefined, dirs);
    try {
      await pushCheck(cwd);
      cwd = (await alter(cwd, database.url, domainHeader, domainV2, "0002_check", dirs)).cwd;
      cwd = (await alter(cwd, database.url, domainHeader, domainV3, "0003_drop", dirs)).cwd;
      const left = await sql<{ count: string }[]>`
        select count(*)::text as count from pg_type t
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public' and t.typname = 'pos'
      `;
      expect(left[0]?.count).toBe("0");
    } finally {
      await sql.end({ timeout: 5 });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a function round-trips through push, replace, and drop",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const dirs: string[] = [];
    let cwd = project(
      database.url,
      functionHeader,
      functionBody("begin return title; end"),
      undefined,
      dirs,
    );
    try {
      await pushCheck(cwd);
      cwd = (
        await alter(
          cwd,
          database.url,
          functionHeader,
          functionBody("begin return lower(title); end"),
          "0002_body",
          dirs,
        )
      ).cwd;
      cwd = (await alter(cwd, database.url, functionHeader, functionGone, "0003_drop", dirs)).cwd;
      expect(await routineCount(sql, "slug")).toBe("0");
    } finally {
      await sql.end({ timeout: 5 });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "timestamps enforcement round-trips and the trigger is dropped without cascade",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const dirs: string[] = [];
    let cwd = project(database.url, triggerHeader, triggerV1, undefined, dirs);
    try {
      await pushCheck(cwd);
      cwd = (await alter(cwd, database.url, triggerHeader, triggerV2, "0002_title", dirs)).cwd;
      cwd = (await alter(cwd, database.url, triggerHeader, triggerV3, "0003_drop", dirs)).cwd;
      expect(await routineCount(sql, "okm_touch_updated_at")).toBe("0");
      const triggers = await sql<{ count: string }[]>`
        select count(*)::text as count from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
      `;
      expect(triggers[0]?.count).toBe("0");
    } finally {
      await sql.end({ timeout: 5 });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a view round-trips through replace and drop",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const dirs: string[] = [];
    let cwd = project(
      database.url,
      viewHeader,
      viewSource("active", VIEW, viewColumns),
      undefined,
      dirs,
    );
    try {
      await pushCheck(cwd);
      cwd = (
        await alter(
          cwd,
          database.url,
          viewHeader,
          viewSource("active", VIEW_NEXT, viewColumnsNext),
          "0002_column",
          dirs,
        )
      ).cwd;
      cwd = (await alter(cwd, database.url, viewHeader, viewGone, "0003_drop", dirs)).cwd;
      const left = await sql<{ reg: string | null }[]>`
        select to_regclass('public.active')::text as reg
      `;
      expect(left[0]?.reg ?? null).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "a materialized view with concurrent refresh round-trips and drops",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const dirs: string[] = [];
    let cwd = project(database.url, viewHeader, matSource(MAT), undefined, dirs);
    try {
      await pushCheck(cwd);
      cwd = (await alter(cwd, database.url, viewHeader, matSource(MAT_NEXT), "0002_query", dirs))
        .cwd;
      cwd = (await alter(cwd, database.url, viewHeader, viewGone, "0003_drop", dirs)).cwd;
      const left = await sql<{ reg: string | null }[]>`
        select to_regclass('public.sums')::text as reg
      `;
      expect(left[0]?.reg ?? null).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "managed and external roles round-trip, with one set role per apply",
  async () => {
    const mig = roleName("mig");
    const app = roleName("app");
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    const dirs: string[] = [];
    const roles = { migration: mig, app };
    let cwd = project(database.url, roleHeader, roleV1, roles, dirs);
    try {
      await sql.unsafe(
        `create role ${quoteIdent(app)} login password 'secret' nosuperuser nocreatedb nocreaterole`,
      );
      const pushed: string[] = [];
      await run(["push"], { cwd, stdout: (text) => pushed.push(text) });
      expect(
        pushed
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("set role ")),
      ).toEqual([`set role ${mig}`]);
      await checkOk(cwd);
      const added = await alter(cwd, database.url, roleHeader, roleV2, "0002_later", dirs, roles);
      expect(added.setRole).toBe(mig);
      const removed = await alter(
        added.cwd,
        database.url,
        roleHeader,
        roleV1,
        "0003_drop",
        dirs,
        roles,
      );
      expect(removed.setRole).toBe(mig);
      const later = await sql<{ reg: string | null }[]>`
        select to_regclass('public.later')::text as reg
      `;
      expect(later[0]?.reg ?? null).toBeNull();
      const kept = await sql<{ name: string }[]>`
        select rolname as name from pg_roles where rolname = ${mig}
      `;
      expect(kept.map((row) => row.name)).toEqual([mig]);
    } finally {
      await sql.end({ timeout: 5 });
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
      await database.close();
      await dropRoles([mig, app]);
    }
  },
  60_000,
);

const pg = JSON.stringify(join(root, "src/dialects/pg/index.ts"));
const migrate = JSON.stringify(join(root, "src/tooling/migrate/index.ts"));

const extensionHeader = [
  `import { schema, t, table } from ${pg};`,
  `import { citext as citextExtension } from ${JSON.stringify(join(root, "src/dialects/pg/ext/citext.ts"))};`,
  `import { pgTrgm } from ${JSON.stringify(join(root, "src/dialects/pg/ext/pg-trgm.ts"))};`,
].join("\n");

const extensionV1 = [
  "export const app = schema({",
  '  tables: [table("people", { email: t.citext() })],',
  "  extensions: [citextExtension()],",
  "});",
].join("\n");

const extensionV2 = [
  "const trigram = pgTrgm();",
  "export const app = schema({",
  "  tables: [",
  "    table(",
  '      "people",',
  "      { email: t.citext(), title: t.text(), body: t.text() },",
  "      { indexes: (column) => [trigram.gin(column.title.name), trigram.gist(column.body.name)] },",
  "    ),",
  "  ],",
  "  extensions: [citextExtension(), trigram],",
  "});",
].join("\n");

const extensionV3 = ["export const app = schema({ tables: [] });"].join("\n");

const domainHeader = [`import { schema, t, table } from ${pg};`].join("\n");

const domainV1 = [
  "export const app = schema({",
  '  tables: [table("people", { n: t.domain("pos", t.integer(), "((VALUE > 0))") })],',
  "});",
].join("\n");

const domainV2 = [
  "export const app = schema({",
  '  tables: [table("people", { n: t.domain("pos", t.integer(), "((VALUE > 1))") })],',
  "});",
].join("\n");

const domainV3 = ["export const app = schema({ tables: [] });"].join("\n");

const functionHeader = [
  `import { fn } from ${JSON.stringify(join(root, "src/dialects/pg/fn/index.ts"))};`,
  `import { schema, t, table } from ${pg};`,
].join("\n");

function functionBody(body: string): string {
  return [
    'const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });',
    "export const app = schema({",
    "  tables: [tasks],",
    "  functions: [",
    '    fn("slug", {',
    '      arguments: [{ name: "title", type: "text" }],',
    '      returns: "text",',
    '      language: "plpgsql",',
    `      body: ${JSON.stringify(body)},`,
    "      dependsOn: [tasks],",
    "    }),",
    "  ],",
    "});",
  ].join("\n");
}

const functionGone = [
  'const tasks = table("tasks", { id: t.text().primaryKey(), title: t.text() });',
  "export const app = schema({ tables: [tasks] });",
].join("\n");

const triggerHeader = [
  `import { schema, t, table } from ${pg};`,
  `import { timestamps } from ${JSON.stringify(join(root, "src/runtime/traits/index.ts"))};`,
].join("\n");

const triggerV1 = [
  "export const app = schema({",
  '  casing: "snake",',
  "  tables: [",
  '    table("notes", { id: t.text().primaryKey() }, { traits: [timestamps({ enforce: "trigger" })] }),',
  "  ],",
  "});",
].join("\n");

const triggerV2 = [
  "export const app = schema({",
  '  casing: "snake",',
  "  tables: [",
  "    table(",
  '      "notes",',
  "      { id: t.text().primaryKey(), title: t.text() },",
  '      { traits: [timestamps({ enforce: "trigger" })] },',
  "    ),",
  "  ],",
  "});",
].join("\n");

const triggerV3 = [
  "export const app = schema({",
  '  casing: "snake",',
  '  tables: [table("notes", { id: t.text().primaryKey(), title: t.text() })],',
  "});",
].join("\n");

const viewHeader = [
  `import { schema, t, table } from ${pg};`,
  `import { materializedView, view } from ${JSON.stringify(join(root, "src/dialects/pg/view/index.ts"))};`,
].join("\n");

const viewColumns = [
  { name: "id", type: "text" },
  { name: "title", type: "text" },
];

const viewColumnsNext = [...viewColumns, { name: "marker", type: "integer" }];

function viewSource(
  name: string,
  query: string,
  columns: readonly { readonly name: string; readonly type: string }[],
): string {
  return [
    "export const app = schema({",
    '  tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],',
    "  views: [",
    `    view(${JSON.stringify(name)}, {`,
    `      columns: ${JSON.stringify(columns)},`,
    `      query: ${JSON.stringify(query)},`,
    "    }),",
    "  ],",
    "});",
  ].join("\n");
}

const viewGone = [
  "export const app = schema({",
  '  tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],',
  "});",
].join("\n");

function matSource(query: string): string {
  return [
    "export const app = schema({",
    '  tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],',
    "  views: [",
    '    materializedView("sums", {',
    `      columns: ${JSON.stringify(viewColumns)},`,
    `      query: ${JSON.stringify(query)},`,
    '      refresh: "concurrently",',
    '      indexes: [{ columns: ["id"], unique: true }],',
    "    }),",
    "  ],",
    "});",
  ].join("\n");
}

const roleHeader = [`import { schema, t, table } from ${pg};`].join("\n");

const roleV1 = [
  "export const app = schema({",
  '  tables: [table("tasks", { id: t.text().primaryKey(), title: t.text() })],',
  "});",
].join("\n");

const roleV2 = [
  "export const app = schema({",
  "  tables: [",
  '    table("tasks", { id: t.text().primaryKey(), title: t.text() }),',
  '    table("later", { id: t.text().primaryKey(), title: t.text() }),',
  "  ],",
  "});",
].join("\n");

async function pushCheck(cwd: string): Promise<void> {
  await run(["push"], { cwd, stdout: () => undefined });
  await checkOk(cwd);
}

async function checkOk(cwd: string): Promise<void> {
  const checked: string[] = [];
  await run(["check"], { cwd, stdout: (text) => checked.push(text) });
  expect(checked.join("")).toBe("ok\n");
}

async function alter(
  cwd: string,
  url: string,
  header: string,
  body: string,
  id: string,
  dirs: string[],
  roles?: { readonly migration: string; readonly app: string },
): Promise<{ readonly cwd: string; readonly setRole?: string }> {
  const next = project(url, header, body, roles, dirs);
  const before = await projectHead(cwd);
  const after = await projectHead(next);
  const plan = planMigration({ before: before.catalog, after: after.catalog, name: id });
  const text = plan.steps.map((step) => step.sql).join("\n");
  expect(plan.steps.length).toBeGreaterThan(0);
  expect(text.toLowerCase()).not.toContain("cascade");
  expect(text.toLowerCase()).not.toContain("drop role");
  const report = await applyTarget({
    url,
    target: "default",
    protected: false,
    ...(roles !== undefined ? { migrationRole: roles.migration } : {}),
    migrations: [{ id, catalogHash: id, steps: plan.steps }],
  });
  await checkOk(next);
  return { cwd: next, ...(report.setRole !== undefined ? { setRole: report.setRole } : {}) };
}

function project(
  url: string,
  header: string,
  body: string,
  roles: { readonly migration: string; readonly app: string } | undefined,
  dirs: string[],
): string {
  const cwd = mkdtempSync(join(tmpdir(), "okm-gate-"));
  dirs.push(cwd);
  writeSchema(cwd, header, body);
  const rolesLine =
    roles === undefined
      ? ""
      : `  roles: { migration: ${JSON.stringify(roles.migration)}, app: ${JSON.stringify(roles.app)}, managed: [{ name: ${JSON.stringify(roles.migration)}} ] },\n`;
  writeFileSync(
    join(cwd, "okmodel.config.ts"),
    [
      `import { defineConfig } from ${migrate};`,
      "export default defineConfig({",
      '  schema: "./schema.ts",',
      `  database: ${JSON.stringify(url)},`,
      rolesLine,
      "});",
      "",
    ].join("\n"),
  );
  return cwd;
}

function writeSchema(cwd: string, header: string, body: string): void {
  writeFileSync(join(cwd, "schema.ts"), `${header}\n${body}\n`);
}

async function routineCount(sql: Sql, name: string): Promise<string> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = ${name}
  `;
  return rows[0]?.count ?? "0";
}

function roleName(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function dropRoles(names: readonly string[]): Promise<void> {
  const admin = openPostgres();
  try {
    for (const name of names) await admin.unsafe(`drop role if exists ${quoteIdent(name)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function refusal(body: () => Promise<unknown>): Promise<OkmError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof OkmError) return error;
    throw error;
  }
  throw new Error("expected OkmError");
}
