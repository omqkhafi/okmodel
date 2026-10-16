/**
 * `okm import drizzle` on Postgres: apply the built schema and introspect (D280).
 */

import { introspectSchema } from "../src/dialects/pg/introspect.js";
import { openPostgres } from "../packages/harness/src/postgres.js";
import { createIsolatedDatabase } from "../packages/harness/src/postgres.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { roundTrip } from "./import-drizzle-roundtrip.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "import drizzle round-trips through Postgres",
  async () => {
    const database = await createIsolatedDatabase();
    try {
      await roundTrip(async (statements) => {
        const sql = openPostgres(database.url);
        try {
          await sql.unsafe("create schema shop");
          await sql.unsafe("set search_path to shop");
          for (const statement of statements) {
            if (statement.trim().length === 0) continue;
            await sql.unsafe(statement);
          }
          return await introspectSchema(
            {
              async query(text, params) {
                const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
                return rows.map((row) => {
                  const copy: Record<string, unknown> = {};
                  for (const [key, value] of Object.entries(row)) copy[key] = value;
                  return copy;
                });
              },
            },
            "shop",
            "public",
          );
        } finally {
          await sql.end({ timeout: 5 });
        }
      });
    } finally {
      await database.close();
    }
  },
  60_000,
);
