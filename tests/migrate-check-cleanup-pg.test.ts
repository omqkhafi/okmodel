/**
 * `okm migrate check` cleanup connections.
 *
 * A replay that rolls back does not open a second connection. A step that
 * commits leaves the scratch schema, and that path still drops it on a new
 * connection. `pg_stat_database.sessions` counts each new session.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { OkmError } from "../src/contracts/error.js";
import { CHECK_SCHEMA_PREFIX } from "../src/tooling/migrate/check.js";
import { replayCheckHistory } from "../src/tooling/migrate/sandbox.js";

const gate = await loadPostgresGate();

const config = { schema: "schema.ts" };

postgresTest(
  gate,
  "a rolled-back check does not open a cleanup connection",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const before = await sessions(sql);
      const scratch = schemaName();
      await replayCheckHistory(database.url, scratch, config, false, [migration("select 1")]);
      expect((await sessions(sql)) - before).toBe(1);
      expect(await scratchSchemas(sql)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "a committed scratch schema is dropped on a cleanup connection",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const before = await sessions(sql);
      const scratch = schemaName();
      const error = await replayCheckHistory(database.url, scratch, config, false, [
        migration("commit"),
      ]).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(OkmError);
      expect((error as OkmError).message).toContain("left its transaction");
      expect((await sessions(sql)) - before).toBe(2);
      expect(await scratchSchemas(sql)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

type Step = {
  sql: string;
  class: "expand";
  action: "ddl";
  lock: string;
  transactional: true;
};

function migration(...statements: readonly string[]): {
  id: string;
  catalog: ReturnType<typeof catalog>;
  steps: readonly Step[];
} {
  return {
    id: "0001_init",
    catalog: catalog([]),
    steps: statements.map((sql) => ({
      sql,
      class: "expand",
      action: "ddl",
      lock: "none",
      transactional: true,
    })),
  };
}

async function citextHome(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ schema: string }[]>`
    select n.nspname as schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'citext'
  `;
  return rows.map((row) => row.schema);
}

async function withInstalledCitext(body: (url: string, sql: Sql) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await sql.unsafe("create extension citext schema public");
    await sql.unsafe("create table public.people (email citext not null)");
    await body(database.url, sql);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
}

const INSTALLED = 'create extension "citext" schema "public"';

postgresTest(
  gate,
  "a step that commits cannot move or drop an installed extension",
  async () => {
    await withInstalledCitext(async (url, sql) => {
      const error = await replayCheckHistory(url, schemaName(), config, false, [
        migration(INSTALLED, 'create table "public"."scratch_people" ("email" citext)', "commit"),
      ]).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect((error as OkmError).message).toContain("left its transaction");
      expect(await citextHome(sql)).toEqual(["public"]);
      expect(await scratchSchemas(sql)).toEqual([]);
      const column = await sql<{ type: string }[]>`
        select format_type(a.atttypid, a.atttypmod) as type
        from pg_attribute a
        where a.attrelid = 'public.people'::regclass and a.attname = 'email'
      `;
      expect(column.map((row) => row.type)).toEqual(["citext"]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "replaying drop extension leaves the installed extension and its real dependents alone (N-98)",
  async () => {
    await withInstalledCitext(async (url, sql) => {
      const outcome = await replayCheckHistory(url, schemaName(), config, false, [
        migration(INSTALLED, 'drop extension "citext"'),
      ]);
      expect(outcome.stop).toBeUndefined();
      expect(await citextHome(sql)).toEqual(["public"]);
      expect(await scratchSchemas(sql)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "replaying drop extension still fails while a scratch object uses it",
  async () => {
    await withInstalledCitext(async (url, sql) => {
      const error = await replayCheckHistory(url, schemaName(), config, false, [
        migration(
          INSTALLED,
          'create table "public"."t" ("email" citext not null)',
          'drop extension "citext"',
        ),
      ]).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect((error as OkmError).message).toContain(
        "cannot drop extension citext because other objects depend on it",
      );
      expect(await citextHome(sql)).toEqual(["public"]);
      expect(await scratchSchemas(sql)).toEqual([]);
    });
  },
  30_000,
);

postgresTest(
  gate,
  "replaying an extension that is not installed creates it in the scratch schema only",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const outcome = await replayCheckHistory(database.url, schemaName(), config, false, [
        migration(INSTALLED, 'create table "public"."t" ("email" citext not null)'),
      ]);
      expect(outcome.stop?.back.steps.map((step) => step.sql).join("\n")).toContain("citext");
      expect(await citextHome(sql)).toEqual([]);
      expect(await scratchSchemas(sql)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

function schemaName(): string {
  return `${CHECK_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function sessions(sql: Sql): Promise<number> {
  const rows = await sql<{ sessions: string | number }[]>`
    select sessions from pg_stat_database where datname = current_database()
  `;
  const value = rows[0]?.sessions;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  throw new Error("pg_stat_database.sessions is missing");
}

async function scratchSchemas(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ nspname: string }[]>`
    select nspname from pg_namespace where nspname like ${`${CHECK_SCHEMA_PREFIX}%`}
  `;
  return rows.map((row) => row.nspname);
}
