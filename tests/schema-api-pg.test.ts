/**
 * The handbook example, applied on Postgres.
 *
 * Local runs skip when Docker is down. CI with `needs: postgres` requires it.
 */

import { expect } from "bun:test";

import { catalogHash } from "../src/contracts/catalog/document.js";
import { catalog } from "../src/contracts/catalog/build.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";
import { loadSchemaApiExample } from "./schema-api-docs.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "the schema API example applies on Postgres",
  async () => {
    const example = await loadSchemaApiExample();
    expect(catalogHash(example.catalog)).toBe(catalogHash(example.app.catalog));
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      const plan = planMigration({
        before: catalog([]),
        after: example.catalog,
        name: "describe",
      });
      expect(plan.steps.length).toBeGreaterThan(0);
      for (const step of plan.steps) await sql.unsafe(step.sql);
      const inserted = await sql<{ email: string }[]>`
        insert into "users" ("email") values ('a@b.c') returning "email"
      `;
      expect(inserted[0]?.email).toBe("a@b.c");
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  60_000,
);
