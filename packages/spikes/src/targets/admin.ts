/**
 * Database create and drop for the spike's own fixtures.
 *
 * `CREATE DATABASE` is what a database-per-tenant registry's `create(id)`
 * runs. Dropping a database is test cleanup. The migration engine does not
 * offer it: OKModel never drops a database.
 */

import type { Sql } from "postgres";

import { quoteIdent } from "../catalog/sql.js";

/**
 * Creates an empty database.
 *
 * @param admin - Connection to an existing database on the same server
 * @param name - Database name, already a safe identifier
 */
export async function createEmptyDatabase(admin: Sql, name: string): Promise<void> {
  await admin.unsafe(`create database ${quoteIdent(name)}`);
}

/**
 * Terminates sessions and drops a database created by a test.
 *
 * @param admin - Connection to a different database
 * @param name - Database name
 */
export async function dropEmptyDatabase(admin: Sql, name: string): Promise<void> {
  await admin.unsafe(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
    [name],
  );
  await admin.unsafe(`drop database if exists ${quoteIdent(name)}`);
}

/**
 * Drops every database whose name starts with `prefix`.
 *
 * @param admin - Connection to a different database
 * @param prefix - Name prefix, including the trailing underscore
 */
export async function dropDatabasesByPrefix(admin: Sql, prefix: string): Promise<void> {
  const rows = await admin.unsafe("select datname from pg_database where datname like $1", [
    `${prefix}%`,
  ]);
  for (const row of rows) {
    const name = row.datname;
    if (typeof name === "string") await dropEmptyDatabase(admin, name);
  }
}

/**
 * Counts sessions with this `application_name`.
 *
 * @param admin - Any connection on the server
 * @param applicationName - Value the pools set
 * @returns Open backends
 */
export async function countApplicationBackends(
  admin: Sql,
  applicationName: string,
): Promise<number> {
  const rows = await admin.unsafe(
    "select count(*)::int as count from pg_stat_activity where application_name = $1",
    [applicationName],
  );
  const count = rows[0]?.count;
  if (typeof count === "number") return count;
  if (typeof count === "string") return Number(count);
  return 0;
}
