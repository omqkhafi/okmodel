/**
 * A failed CREATE INDEX CONCURRENTLY ends its sentence, and cleanup does not
 * treat another session's index on the same table as this build (N-87).
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { openPostgres, withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";
import type { StoredMigration } from "../src/tooling/migrate/files.js";
import type { PlanStep } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();
const url = primaryUrl();

postgresTest(
  gate,
  "a failed concurrent index ends with a period and ignores another build",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      await sql.unsafe(`create table ${q(schemaName)}.items (id integer, note integer)`);
      await sql.unsafe(
        `insert into ${q(schemaName)}.items select 1, n from generate_series(1, 40) as n`,
      );
      const other = openPostgres(url);
      const building = other
        .unsafe(
          `select pg_sleep(30) -- create index concurrently items_note_idx on ${schemaName}.items (note)`,
        )
        .then(
          () => undefined,
          () => undefined,
        );
      try {
        const started = await waitForBuild(sql, schemaName);
        expect(started).toBe(true);
        const create = `create unique index concurrently items_id_idx on ${q(schemaName)}.items (id)`;
        const failed = await catchError(() =>
          applyTarget({
            url,
            target: schemaName,
            protected: false,
            searchPath: schemaName,
            migrations: [migration("0001_idx", "hash-idx", [step(create)])],
          }),
        );
        const message = failed instanceof Error ? failed.message : "";
        expect(message).toContain('could not create unique index "items_id_idx".');
        expect(message).not.toContain("items_note_idx");
        expect(await invalidIndexes(sql, schemaName, "items_id_idx")).toEqual([]);
      } finally {
        await sql.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where pid <> pg_backend_pid() and query ilike '%items_note_idx%'`,
        );
        await building;
        await other.end({ timeout: 5 });
      }
    });
  },
  60_000,
);

async function waitForBuild(sql: Sql, schemaName: string): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await sql<{ pid: string }[]>`
      select pid::text as pid from pg_stat_activity
      where pid <> pg_backend_pid()
        and state = 'active'
        and query ilike ${`%create index concurrently items_note_idx%${schemaName}%`}
    `;
    if (rows.length > 0) return true;
    await Bun.sleep(40);
  }
  return false;
}

function migration(id: string, catalogHash: string, steps: readonly PlanStep[]): StoredMigration {
  return { id, catalogHash, steps };
}

function step(sql: string): PlanStep {
  return {
    sql,
    class: "expand",
    action: "ddl",
    lock: "SHARE UPDATE EXCLUSIVE",
    transactional: false,
  };
}

function q(name: string): string {
  return `"${name}"`;
}

async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

async function invalidIndexes(
  sql: Sql,
  schemaName: string,
  indexName: string,
): Promise<readonly { readonly indisvalid: boolean }[]> {
  return sql<{ indisvalid: boolean }[]>`
    select i.indisvalid
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = ${indexName} and n.nspname = ${schemaName} and i.indisvalid = false
  `;
}
