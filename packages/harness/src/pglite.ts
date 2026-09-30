import { PGlite } from "@electric-sql/pglite";

import { isolatedSchemaName } from "./schema-name.js";

/**
 * Opens an in-memory PGlite database.
 *
 * The caller closes it with `db.close()`.
 *
 * @returns A database no other call shares
 */
export async function openPglite(): Promise<PGlite> {
  const db = new PGlite("memory://");
  await db.waitReady;
  return db;
}

/**
 * Opens an in-memory PGlite database and closes it when `fn` finishes.
 *
 * @param fn - Receives the database
 * @returns Whatever `fn` returns
 */
export async function withPglite<T>(fn: (db: PGlite) => Promise<T>): Promise<T> {
  const db = await openPglite();
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/**
 * Opens a fresh PGlite database and a unique schema inside it.
 *
 * `search_path` is set to that schema.
 *
 * @param fn - Receives the database and the schema name
 * @returns Whatever `fn` returns
 */
export async function withPgliteSchema<T>(
  fn: (db: PGlite, schema: string) => Promise<T>,
): Promise<T> {
  return withPglite(async (db) => {
    const schema = isolatedSchemaName();
    await db.exec(`create schema ${schema}; set search_path to ${schema}`);
    return fn(db, schema);
  });
}
