/**
 * Extension lifecycle on Postgres.
 *
 * Extensions are database-scoped, so each case uses its own database.
 * A server without the contrib package skips that case.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import { catalog } from "../src/contracts/catalog/build.js";
import { citext as citextExtension } from "../src/dialects/pg/ext/citext.js";
import { pgTrgm } from "../src/dialects/pg/ext/pg-trgm.js";
import { introspectSchema, type CatalogQuery } from "../src/dialects/pg/introspect.js";
import { schema, t, table } from "../src/dialects/pg/index.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";
import { planMigration } from "../src/tooling/migrate/plan.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "citext is created, introspected, and compared case-insensitively",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await available(sql, "citext"))) return;
      const app = schema({
        tables: [table("people", { email: t.citext() })],
        extensions: [citextExtension()],
      });
      const plan = planMigration({ before: catalog([]), after: app.catalog, name: "citext" });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      await sql.unsafe(`insert into people (email) values ('Ada@Example.com')`);
      const found = await sql<
        { email: string }[]
      >`select email from people where email = ${"ada@example.com"}`;
      expect(found).toHaveLength(1);
      const live = await introspectSchema(queryOf(sql), "public", "public");
      const extension = live.objects.find((object) => object.kind === "extension");
      expect(extension?.identity).toEqual({ kind: "extension", name: "citext" });
      expect(extension?.definition.schema).toBe("public");
      expect(extension?.definition.version).toBeTypeOf("string");
      const column = live.objects.find(
        (object) => object.kind === "column" && object.identity.name === "email",
      );
      expect(column?.dependencies.some((edge) => edge.target.kind === "extension")).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

postgresTest(
  gate,
  "pg_trgm similarity operator runs on the declared extension",
  async () => {
    const database = await createIsolatedDatabase();
    const sql = openPostgres(database.url);
    try {
      if (!(await available(sql, "pg_trgm"))) return;
      const trigram = pgTrgm();
      const app = schema({
        tables: [table("notes", { title: t.text() })],
        extensions: [trigram],
      });
      const plan = planMigration({ before: catalog([]), after: app.catalog, name: "trgm" });
      for (const step of plan.steps) await sql.unsafe(step.sql);
      await sql.unsafe(`insert into notes (title) values ('postgresql')`);
      const found = await sql<{ title: string }[]>`
        select title from notes where title operator(public.%) ${"postgre"}
      `;
      expect(found.map((row) => row.title)).toEqual(["postgresql"]);
    } finally {
      await sql.end({ timeout: 5 });
      await database.close();
    }
  },
  30_000,
);

async function available(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql<{ name: string }[]>`
    select name from pg_available_extensions where name = ${name}
  `;
  if (rows.length === 0) {
    console.warn(`${name} is not available on this server; skipping`);
    return false;
  }
  return true;
}

function queryOf(sql: Sql): CatalogQuery {
  return {
    async query(text, params) {
      const rows = await sql.unsafe(text, params === undefined ? undefined : [...params]);
      return rows.map((row) => {
        const copy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) copy[key] = value;
        return copy;
      });
    },
  };
}
