/**
 * Cleanup of a partial CREATE INDEX CONCURRENTLY drops the index in the
 * table's schema, whatever the spelling (N-83, N-84).
 */

import { expect } from "bun:test";

import type { DriverConnection } from "../src/contracts/driver.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { withPostgresSchema } from "../packages/harness/src/postgres.js";
import { primaryUrl } from "../packages/harness/src/topology.js";
import { postgresStepEngine } from "../src/tooling/migrate/pg-probe.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "cleanup drops a mixed-case index, an escaped quote, and another schema",
  async () => {
    await withPostgresSchema(async (sql, schemaName) => {
      const schema = `"${schemaName}"`;
      await sql.unsafe(`create table ${schema}.tasks (id integer, title text)`);
      await sql.unsafe(`create index MixedCase on ${schema}.tasks (title)`);
      await sql.unsafe(`create index "a""b" on ${schema}.tasks (id)`);
      await sql.unsafe(`create index "Quoted" on ${schema}.tasks (title, id)`);
      const opened = await openPublic();
      try {
        await opened.connection.execute("set search_path to public");
        for (const statement of [
          `create index concurrently MixedCase on ${schema}.tasks (title)`,
          `create index concurrently "a""b" on ${schema}.tasks (id)`,
          `create index concurrently "Quoted" on ${schema}.tasks (title, id)`,
        ]) {
          await postgresStepEngine(
            opened.connection,
            { kind: "create-index", sql: statement, lockTimeoutMs: 1_000 },
            () => Promise.resolve(),
          ).cleanup();
        }
      } finally {
        await opened.connection.release();
        await opened.close();
      }
      const left = await sql<{ name: string }[]>`
        select c.relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${schemaName} and c.relkind = 'i'
      `;
      expect(left).toEqual([]);
    });
  },
  60_000,
);

async function openPublic(): Promise<{
  readonly connection: DriverConnection;
  readonly close: () => Promise<void>;
}> {
  const { open } = await import("../src/adapters/pg/postgresjs.js");
  const pool = open({ url: primaryUrl(), max: 1, searchPath: "public" });
  if (pool.reserve === undefined) throw new Error("no reserve");
  return { connection: await pool.reserve(), close: () => pool.close() };
}
