/**
 * Function introspection on real Postgres.
 *
 * Internal and extension functions are not the user's, and a language the
 * catalog cannot hold is reported instead of read as plpgsql.
 */

import { expect } from "bun:test";
import type { Sql } from "postgres";

import {
  introspectSchema,
  type CatalogQuery,
  type IntrospectSkip,
} from "../src/dialects/pg/introspect.js";
import { loadPostgresGate, postgresTest } from "../packages/harness/src/postgres-test.js";
import { createIsolatedDatabase, openPostgres } from "../packages/harness/src/postgres.js";

const gate = await loadPostgresGate();

postgresTest(
  gate,
  "introspection skips range constructors and extension functions and keeps a user function",
  async () => {
    await using(async (sql) => {
      await sql.unsafe("create extension btree_gist");
      await sql.unsafe("create type floatrange as range (subtype = float8)");
      await sql.unsafe(
        "create function double_it(x integer) returns integer language sql immutable as 'select x * 2'",
      );
      const live = await introspectSchema(queryOf(sql), "public");
      const names = live.objects
        .filter((object) => object.kind === "function")
        .map((object) => object.identity.name);
      expect(names).toEqual(["double_it"]);
      // The range type created five internal constructors and btree_gist hundreds of members.
      const owned = await sql.unsafe(
        `select count(*)::int as n from pg_proc p join pg_depend d
           on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype in ('i', 'a', 'e')
         where p.pronamespace = 'public'::regnamespace`,
      );
      expect(Number(owned[0]?.n)).toBeGreaterThan(5);
    });
  },
);

postgresTest(
  gate,
  "a function in another language is reported as not pulled and is never plpgsql",
  async () => {
    await using(async (sql) => {
      await sql.unsafe(
        "create function absolute(integer) returns integer language internal immutable strict as 'int4abs'",
      );
      await sql.unsafe(
        "create function keeps(x integer) returns integer language plpgsql as 'begin return x; end'",
      );
      const notPulled: IntrospectSkip[] = [];
      const live = await introspectSchema(queryOf(sql), "public", "public", { notPulled });
      const functions = live.objects.filter((object) => object.kind === "function");
      expect(functions.map((object) => object.identity.name)).toEqual(["keeps"]);
      expect(
        functions.every((object) => object.kind === "function" && object.definition.language),
      ).toBe(true);
      expect(notPulled).toHaveLength(1);
      expect(notPulled[0]?.label).toBe("absolute");
      expect(notPulled[0]?.reason).toBe("not pulled yet: language internal");
      // Without a list the function is still left out, not relabelled.
      const quiet = await introspectSchema(queryOf(sql), "public");
      expect(quiet.objects.filter((object) => object.kind === "function")).toHaveLength(1);
    });
  },
);

async function using(body: (sql: Sql) => Promise<void>): Promise<void> {
  const database = await createIsolatedDatabase();
  const sql = openPostgres(database.url);
  try {
    await body(sql);
  } finally {
    await sql.end({ timeout: 5 });
    await database.close();
  }
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
