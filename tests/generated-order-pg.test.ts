/**
 * `testing().close()` drops a generated search column on Postgres.
 *
 * The generated column is ordered after the column its expression reads, so
 * the drop does not fail with 2BP01.
 */

import { expect } from "bun:test";

import { open as openPostgresJs } from "../src/adapters/pg/postgresjs.js";
import { identity, schema, table, text, tsvector } from "../src/dialects/pg/index.js";
import { testing } from "../src/tooling/testing/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const docs = schema({
  tables: [
    table("docs", {
      id: identity(),
      title: text(),
      search: tsvector().generated("to_tsvector('english', title)"),
    }),
  ],
});

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "testing() closes a generated search column",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      const harness = await testing(docs, { driver: openPostgresJs({ url: database.url }) });
      await harness.close();
      const sql = openPostgres(database.url);
      try {
        const relations = await sql<{ relname: string }[]>`
          select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'S')
        `;
        expect(relations.map((row) => row.relname)).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    } finally {
      await database.close();
    }
  },
  30_000,
);
