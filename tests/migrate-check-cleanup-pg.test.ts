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

function migration(sql: string): {
  id: string;
  catalog: ReturnType<typeof catalog>;
  steps: readonly [
    {
      sql: string;
      class: "expand";
      action: "ddl";
      lock: string;
      transactional: true;
    },
  ];
} {
  return {
    id: "0001_init",
    catalog: catalog([]),
    steps: [{ sql, class: "expand", action: "ddl", lock: "none", transactional: true }],
  };
}

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
