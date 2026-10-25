/**
 * Apply preflight folds an unquoted extension name.
 *
 * `CREATE EXTENSION IF NOT EXISTS PG_TRGM` is `pg_trgm`. A quoted name keeps
 * its case. The check runs before any statement.
 */

import { expect } from "bun:test";

import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { applyTarget } from "../src/tooling/migrate/apply.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "apply accepts CREATE EXTENSION IF NOT EXISTS PG_TRGM",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const rows = await sql<{ ok: number }[]>`
        select 1 as ok from pg_available_extensions where name = 'pg_trgm'
      `;
      if (rows.length === 0) return;
      await applyTarget({
        url: database.url,
        target: "default",
        protected: false,
        migrations: [
          {
            id: "0001_ext",
            catalogHash: "hash",
            steps: [
              {
                sql: "CREATE EXTENSION IF NOT EXISTS PG_TRGM",
                class: "expand",
                action: "ddl",
                lock: "ACCESS EXCLUSIVE",
                transactional: true,
              },
            ],
          },
        ],
      });
      const installed = await sql<{ name: string }[]>`
        select extname as name from pg_extension where extname = 'pg_trgm'
      `;
      expect(installed.map((row) => row.name)).toEqual(["pg_trgm"]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);
