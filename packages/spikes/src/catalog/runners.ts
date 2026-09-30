/**
 * Adapters from the harness drivers to the spike's statement runner.
 */

import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";

import { type SqlRunner } from "./introspect.js";

/**
 * Wraps a PGlite database.
 *
 * @param db - Open database
 * @returns A runner
 */
export function pgliteRunner(db: PGlite): SqlRunner {
  return {
    async exec(statement) {
      await db.exec(statement);
    },
    async query(statement) {
      const result = await db.query<Record<string, unknown>>(statement);
      return result.rows;
    },
  };
}

/**
 * Wraps a postgres.js connection.
 *
 * @param sql - Open connection
 * @returns A runner
 */
export function postgresRunner(sql: Sql): SqlRunner {
  return {
    async exec(statement) {
      await sql.unsafe(statement);
    },
    async query(statement) {
      const rows = await sql.unsafe<Record<string, unknown>[]>(statement);
      return rows.map((row) => ({ ...row }));
    },
  };
}
