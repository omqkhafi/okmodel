/**
 * A NOT NULL constraint that is not validated, on a real Postgres.
 *
 * PostgreSQL 18 accepts `ADD CONSTRAINT … NOT NULL col NOT VALID`. From then
 * on `attnotnull` is true while rows with NULL may exist. Introspection,
 * drift, `okm push`, `okm pull`, and the external-catalog check have to say
 * so. PostgreSQL 15 through 17 cannot hold that state, so the same fixtures
 * there give the plain results.
 */

import { expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Sql } from "postgres";

import { column } from "../src/contracts/catalog/object.js";
import { catalog } from "../src/contracts/catalog/build.js";
import type { Catalog, CatalogObject, ColumnObject } from "../src/contracts/catalog/types.js";
import { OkmError } from "../src/contracts/error.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { repoRoot } from "../scripts/root.js";
import { run } from "../src/tooling/migrate/commands.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { pullProject } from "../src/tooling/migrate/pull.js";

const gate = await loadPostgresGate();
const root = repoRoot();

const FIXTURE = [
  `create table items (
    id integer primary key,
    a integer,
    b integer not null,
    c integer generated always as (id * 2) stored,
    d integer generated always as identity
  )`,
  "insert into items (id, a, b) values (1, null, 1)",
];

postgresTest(
  gate,
  "valid NOT NULL, identity, generated, and primary-key columns carry no mark",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe(
        "create table plain (id integer primary key, b integer not null, c integer generated always as (id * 2) stored, d integer generated always as identity, e integer)",
      );
      const live = await introspectSchema(queryOf(sql), "public", "public");
      expect(definitions(live, "plain")).toEqual({
        id: { dataType: "integer", nullable: false },
        b: { dataType: "integer", nullable: false },
        c: {
          dataType: "integer",
          nullable: true,
          generated: { stored: true, expression: "(id * 2)" },
        },
        d: { dataType: "integer", nullable: false, identity: { always: true } },
        e: { dataType: "integer", nullable: true },
      });
      const author = withoutMarks(live);
      expect(planMigration({ before: live, after: author, name: "check" }).steps).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "an unvalidated NOT NULL is recorded, planned as VALIDATE, and plain once validated",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const major = await serverMajor(sql);
      for (const statement of FIXTURE) await sql.unsafe(statement);
      if (major < 18) {
        await sql.unsafe("update items set a = 1");
        await sql.unsafe("alter table items alter column a set not null");
        const live = await introspectSchema(queryOf(sql), "public", "public");
        expect(definitions(live, "items").a).toEqual({ dataType: "integer", nullable: false });
        expect(planMigration({ before: live, after: withoutMarks(live), name: "c" }).steps).toEqual(
          [],
        );
        return;
      }
      await sql.unsafe("alter table items add constraint items_a_nn not null a not valid");

      const live = await introspectSchema(queryOf(sql), "public", "public");
      const items = definitions(live, "items");
      expect(items.a).toEqual({
        dataType: "integer",
        nullable: false,
        unvalidatedNotNull: "items_a_nn",
      });
      expect(items.id).toEqual({ dataType: "integer", nullable: false });
      expect(items.b).toEqual({ dataType: "integer", nullable: false });
      expect(items.c?.unvalidatedNotNull).toBeUndefined();
      expect(items.d?.unvalidatedNotNull).toBeUndefined();

      const author = withoutMarks(live);
      const plan = planMigration({ before: live, after: author, name: "check" });
      expect(plan.steps.map((step) => step.sql)).toEqual([
        'alter table "public"."items" validate constraint "items_a_nn"',
      ]);
      expect(plan.steps[0]?.kind).toBe("validate-constraint");
      expect(plan.steps[0]?.lock).toBe("SHARE UPDATE EXCLUSIVE");

      const failure = await sql.unsafe(plan.steps[0]?.sql ?? "").catch((error: unknown) => error);
      expect(String(failure)).toContain("contains null values");
      expect(await validated(sql, "items_a_nn")).toBe(false);

      await sql.unsafe("update items set a = 1");
      await sql.unsafe(plan.steps[0]?.sql ?? "");
      expect(await validated(sql, "items_a_nn")).toBe(true);
      const after = await introspectSchema(queryOf(sql), "public", "public");
      expect(definitions(after, "items").a).toEqual({ dataType: "integer", nullable: false });
      expect(planMigration({ before: after, after: author, name: "check" }).steps).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "the schema says nullable: the plan drops the unvalidated constraint",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if ((await serverMajor(sql)) < 18) return;
      for (const statement of FIXTURE) await sql.unsafe(statement);
      await sql.unsafe("alter table items add constraint items_a_nn not null a not valid");
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const nullable = withColumn(withoutMarks(live), "items", "a", true);
      const plan = planMigration({ before: live, after: nullable, name: "check" });
      expect(plan.steps.map((step) => step.sql)).toEqual([
        'alter table "public"."items" alter column "a" drop not null',
      ]);
      await sql.unsafe(plan.steps[0]?.sql ?? "");
      expect(await constraintCount(sql, "items_a_nn")).toBe(0);
      const after = await introspectSchema(queryOf(sql), "public", "public");
      expect(definitions(after, "items").a).toEqual({ dataType: "integer", nullable: true });
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);

postgresTest(
  gate,
  "check reports the weaker database as OKM1520, pull declares it nullable, push validates it",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = projectDir();
    const pulled = projectDir();
    const sql = openPostgres(database.url);
    try {
      writeSchema(cwd, database.url);
      expect(await cli(cwd, ["push"])).toMatch(/applied/);
      expect(await cli(cwd, ["check"])).toBe("ok\n");
      const major = await serverMajor(sql);
      if (major < 18) return;

      await sql.unsafe("alter table items alter column a drop not null");
      await sql.unsafe("insert into items (id, a, note) values (1, null, 'x')");
      await sql.unsafe("alter table items add constraint items_a_nn not null a not valid");

      const drift = await rejected(cwd, ["check"]);
      expect(drift.code).toBe("OKM1520");
      expect(drift.message).toContain(
        'alter table "public"."items" validate constraint "items_a_nn"',
      );
      expect(drift.message).toContain(
        "items.a is NOT NULL NOT VALID (items_a_nn) in the database; rows with NULL may exist.",
      );

      writeConfig(pulled, database.url, { tables: true });
      const result = await pullProject(pulled, []);
      expect(result.text).toContain("not validated: 1");
      expect(result.text).toContain("items.a (items_a_nn)");
      const source = readFileSync(join(pulled, "tables", "items.ts"), "utf8");
      expect(source).toContain("a: t.integer().nullable(),");
      expect(source).toContain("NOT NULL NOT VALID (items_a_nn)");
      expect(source).not.toMatch(/\ba: t\.integer\(\),/);

      // Clean rows do not validate the constraint: the database is still weaker.
      await sql.unsafe("update items set a = 1");
      expect((await rejected(cwd, ["check"])).code).toBe("OKM1520");

      expect(await cli(cwd, ["push"])).toMatch(/applied/);
      expect(await validated(sql, "items_a_nn")).toBe(true);
      expect(await cli(cwd, ["check"])).toBe("ok\n");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      rmSync(pulled, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

postgresTest(
  gate,
  "a dependent catalog is stale when the external column is NOT NULL NOT VALID",
  async () => {
    const database = await createIsolatedDatabase();
    const identity = projectDir();
    const billing = projectDir();
    const sql = openPostgres(database.url);
    try {
      writeIdentity(identity, database.url);
      await cli(identity, ["generate", "init"]);
      await cli(identity, ["migrate", "apply"]);
      await cli(identity, ["catalog", "export", "--out", "identity.okm.json"]);
      writeBilling(billing, identity, database.url);
      await cli(billing, ["generate", "init"]);
      await cli(billing, ["migrate", "apply"]);
      expect(await cli(billing, ["check"])).toContain("ok");
      if ((await serverMajor(sql)) < 18) return;

      const users = '"identity"."users"';
      await sql.unsafe(`alter table ${users} alter column email drop not null`);
      await sql.unsafe(`insert into ${users} (id, email) values (gen_random_uuid(), null)`);
      await sql.unsafe(
        `alter table ${users} add constraint users_email_nn not null email not valid`,
      );
      const stale = await rejected(billing, ["check"]);
      expect(stale.code).toBe("OKM1841");
      expect(stale.message).toContain(
        "identity.users.email is NOT NULL NOT VALID (users_email_nn) on the database, so rows with NULL may exist",
      );

      await sql.unsafe(`delete from ${users}`);
      await sql.unsafe(`alter table ${users} validate constraint users_email_nn`);
      expect(await cli(billing, ["check"])).toContain("ok");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(identity, { recursive: true, force: true });
      rmSync(billing, { recursive: true, force: true });
      await database.close();
    }
  },
  180_000,
);

type Shape = Record<string, ColumnObject["definition"]>;

function definitions(source: Catalog, parent: string): Shape {
  const found: Record<string, ColumnObject["definition"]> = {};
  for (const object of source.objects) {
    if (object.kind === "column" && object.identity.parent.name === parent) {
      found[object.identity.name] = object.definition;
    }
  }
  return found;
}

function withoutMarks(source: Catalog): Catalog {
  return mapColumns(source, (object) => rebuilt(object, object.definition.nullable));
}

function withColumn(source: Catalog, parent: string, name: string, nullable: boolean): Catalog {
  return mapColumns(source, (object) =>
    object.identity.parent.name === parent && object.identity.name === name
      ? rebuilt(object, nullable)
      : object,
  );
}

function mapColumns(source: Catalog, change: (object: ColumnObject) => ColumnObject): Catalog {
  const objects: CatalogObject[] = source.objects.map((object) =>
    object.kind === "column" ? change(object) : object,
  );
  return catalog(objects);
}

function rebuilt(object: ColumnObject, nullable: boolean): ColumnObject {
  const definition = object.definition;
  return column({
    parent: object.identity.parent,
    name: object.identity.name,
    dataType: definition.dataType,
    nullable,
    owner: object.owner,
    provenance: object.provenance,
    dependencies: object.dependencies.map((edge) => edge.target),
    ...(definition.defaultExpression !== undefined
      ? { defaultExpression: definition.defaultExpression }
      : {}),
    ...(definition.collation !== undefined ? { collation: definition.collation } : {}),
    ...(definition.identity !== undefined ? { identity: definition.identity } : {}),
    ...(definition.generated !== undefined ? { generated: definition.generated } : {}),
  });
}

async function serverMajor(sql: Sql): Promise<number> {
  const rows = await sql<
    { version: string }[]
  >`select current_setting('server_version_num') as version`;
  return Math.floor(Number(rows[0]?.version ?? "0") / 10_000);
}

async function validated(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql<{ ok: boolean }[]>`
    select convalidated as ok from pg_constraint where conname = ${name}
  `;
  return rows[0]?.ok === true;
}

async function constraintCount(sql: Sql, name: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_constraint where conname = ${name}
  `;
  return rows[0]?.n ?? 0;
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

function projectDir(): string {
  return mkdtempSync(join(tmpdir(), "okm-nn-"));
}

function source(path: string): string {
  return JSON.stringify(join(root, path));
}

function writeConfig(
  cwd: string,
  url: string,
  options: {
    readonly namespace?: string;
    readonly external?: readonly string[];
    readonly tables?: boolean;
  },
): void {
  const lines = [
    `import { defineConfig } from ${source("src/tooling/migrate/index.ts")};`,
    "export default defineConfig({",
    '  schema: "./schema.ts",',
    `  database: ${JSON.stringify(url)},`,
  ];
  if (options.tables === true) lines.push('  tables: "./tables",');
  if (options.namespace !== undefined)
    lines.push(`  namespace: ${JSON.stringify(options.namespace)},`);
  if (options.external !== undefined)
    lines.push(`  external: ${JSON.stringify(options.external)},`);
  lines.push("});", "");
  writeFileSync(join(cwd, "okmodel.config.ts"), lines.join("\n"));
}

function writeSchema(cwd: string, url: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      "export default schema({",
      "  tables: [",
      '    table("items", {',
      "      id: t.integer().primaryKey(),",
      "      a: t.integer(),",
      "      note: t.text().nullable(),",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
  );
  writeConfig(cwd, url, {});
}

function writeIdentity(cwd: string, url: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      'export const users = table("users", {',
      "  id: t.uuid().primaryKey(),",
      "  email: t.text(),",
      "});",
      "export const app = schema({ tables: [users] });",
      "",
    ].join("\n"),
  );
  writeConfig(cwd, url, { namespace: "identity" });
}

function writeBilling(cwd: string, identity: string, url: string): void {
  writeFileSync(
    join(cwd, "schema.ts"),
    [
      `import { external, schema, t, table } from ${source("src/dialects/pg/index.ts")};`,
      `import { users } from ${JSON.stringify(join(identity, "schema.ts"))};`,
      'const invoices = table("invoices", {',
      "  id: t.uuid().primaryKey(),",
      '  userId: t.uuid().references("users"),',
      "});",
      "export const app = schema({ tables: [external(users), invoices] });",
      "",
    ].join("\n"),
  );
  writeConfig(cwd, url, {
    namespace: "billing",
    external: [join(identity, "identity.okm.json")],
  });
}

type Outcome = { readonly stdout: string; readonly error?: OkmError };

async function attempt(cwd: string, argv: readonly string[]): Promise<Outcome> {
  const lines: string[] = [];
  try {
    await run(argv, { cwd, stdout: (text) => lines.push(text) });
    return { stdout: lines.join("") };
  } catch (error) {
    return { stdout: lines.join(""), error: OkmError.from(error) };
  }
}

async function cli(cwd: string, argv: readonly string[]): Promise<string> {
  const outcome = await attempt(cwd, argv);
  if (outcome.error !== undefined) throw outcome.error;
  return outcome.stdout;
}

async function rejected(cwd: string, argv: readonly string[]): Promise<OkmError> {
  const outcome = await attempt(cwd, argv);
  if (outcome.error === undefined) throw new Error(`${argv.join(" ")} should have failed`);
  return outcome.error;
}

postgresTest(
  gate,
  "a migration that adds NOT NULL NOT VALID and never validates it is OKM1547 in migrate check",
  async () => {
    const database = await createIsolatedDatabase();
    const cwd = projectDir();
    const sql = openPostgres(database.url);
    try {
      writeSchema(cwd, database.url);
      await cli(cwd, ["generate", "init"]);
      const file = migrationFile(cwd);
      const text = readFileSync(file, "utf8");
      expect(text).toContain('"a" integer not null');
      if ((await serverMajor(sql)) < 18) {
        expect(await cli(cwd, ["migrate", "check"])).toContain("ok");
        return;
      }
      writeFileSync(
        file,
        `${text.replace('"a" integer not null', '"a" integer')}\nalter table "public"."items" add constraint items_a_nn not null "a" not valid;\n`,
      );
      const failure = await rejected(cwd, ["migrate", "check"]);
      expect(failure.code).toBe("OKM1547");
      expect(failure.message).toContain('validate constraint "items_a_nn"');
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(cwd, { recursive: true, force: true });
      await database.close();
    }
  },
  120_000,
);

function migrationFile(cwd: string): string {
  const directory = join(cwd, "migrations");
  const name = readdirSync(directory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .at(-1);
  if (name === undefined) throw new Error(`no migration in ${directory}`);
  return join(directory, name);
}
