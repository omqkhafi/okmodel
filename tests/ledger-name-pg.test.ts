/**
 * Apply refuses a foreign ledger before a non-transactional step runs.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { OkmError } from "../src/contracts/error.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "apply refuses a foreign okm_steps before CREATE INDEX CONCURRENTLY",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe("create schema appns");
      await sql.unsafe("create table appns.notes (id integer primary key, title text)");
      await sql.unsafe("insert into appns.notes (id, title) values (1, 'a')");
      await sql.unsafe("create table appns.okm_steps (id integer primary key)");
      const error = await catchError(() =>
        applyTarget({
          url: database.url,
          target: "default",
          protected: false,
          schema: "appns",
          migrations: [concurrentIndex()],
        }),
      );
      expect(error).toBeInstanceOf(OkmError);
      if (!(error instanceof OkmError)) throw new Error("expected OKM1899");
      expect(error.code).toBe("OKM1899");
      expect(error.message).toBe('Another table owns the name "appns"."okm_steps".');
      expect(await names(sql, "i", "notes_title_idx")).toEqual([]);
      expect(await columnNames(sql, "okm_steps")).toEqual(["id"]);
      const meta = await sql<{ name: string | null }[]>`
        select to_regclass('appns.okm_meta')::text as name
      `;
      expect(meta[0]?.name ?? null).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "apply accepts a real okm_steps and creates the concurrent index",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe("create schema appns");
      await sql.unsafe("create table appns.notes (id integer primary key, title text)");
      await sql.unsafe(`create table appns.okm_steps (
        migration_id text not null,
        step_index integer not null,
        kind text not null,
        sql_hash text not null,
        state text not null,
        attempt integer not null,
        started_at timestamptz not null,
        finished_at timestamptz,
        runner text,
        error_code text,
        error_text text,
        primary key (migration_id, step_index)
      )`);
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        schema: "appns",
        migrations: [concurrentIndex()],
      });
      expect(await names(sql, "i", "notes_title_idx")).toEqual(["notes_title_idx"]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "apply refuses a view that uses a ledger name",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      await sql.unsafe("create schema appns");
      await sql.unsafe(
        `create view appns.okm_meta as select 'x'::text as id, 'y'::text as catalog_hash, 'z'::text as migration_id`,
      );
      const error = await catchError(() =>
        applyTarget({
          url: database.url,
          target: "default",
          protected: false,
          schema: "appns",
          migrations: [
            {
              id: "0001_init",
              catalogHash: "hash",
              steps: [
                {
                  sql: "create table notes (id integer)",
                  class: "expand",
                  action: "ddl",
                  lock: "ACCESS EXCLUSIVE",
                  transactional: true,
                },
              ],
            },
          ],
        }),
      );
      expect(error).toBeInstanceOf(OkmError);
      if (!(error instanceof OkmError)) throw new Error("expected OKM1899");
      expect(error.code).toBe("OKM1899");
      expect(error.message).toBe('Another table owns the name "appns"."okm_meta".');
      expect(await names(sql, "r", "notes")).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

function concurrentIndex(): StoredMigration {
  return {
    id: "0001_init",
    catalogHash: "hash",
    steps: [
      {
        sql: "create index concurrently notes_title_idx on notes (title)",
        class: "expand",
        action: "ddl",
        lock: "SHARE UPDATE EXCLUSIVE",
        transactional: false,
        kind: "create-index",
      },
    ],
  };
}

async function names(
  sql: ReturnType<typeof openPostgres>,
  relkind: string,
  relname: string,
): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'appns' and c.relkind::text = ${relkind} and c.relname = ${relname}
  `;
  return rows.map((row) => row.name);
}

async function columnNames(
  sql: ReturnType<typeof openPostgres>,
  relname: string,
): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select a.attname as name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'appns'
      and c.relname = ${relname}
      and a.attnum > 0
      and not a.attisdropped
    order by a.attnum
  `;
  return rows.map((row) => row.name);
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}
