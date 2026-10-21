/**
 * `testing()` drops its catalog on real Postgres, then can apply it again
 * in that same database.
 */

import { expect } from "bun:test";

import { id, schema, table, text, uuid } from "../src/dialects/pg/index.js";
import { open as openPostgresJs } from "../src/adapters/pg/postgresjs.js";
import { testing } from "../src/tooling/testing/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const users = table("users", { id: id(), name: text() });
const accounts = table("accounts", {
  id: id({ default: "none" }),
  name: text(),
  userId: uuid().references("users"),
});
const linked = schema({ tables: [accounts, users] });

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "close drops applied objects and a second testing() applies them again",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      const first = await testing(linked, { driver: openPostgresJs({ url: database.url }) });
      await first.close();

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

      const second = await testing(linked, { driver: openPostgresJs({ url: database.url }) });
      try {
        expect(await second.db.accounts.find({ limit: 1 })).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      await database.close();
    }
  },
  30_000,
);
