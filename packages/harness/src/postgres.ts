import postgres, { type Sql } from "postgres";

import { isolatedSchemaName } from "./schema-name.js";
import { primaryUrl } from "./topology.js";

/**
 * Opens a postgres.js connection.
 *
 * The caller closes it with `sql.end()`. This is the driver for the harness.
 * The published `okmodel` package does not depend on it.
 *
 * @param url - Connection URL. Defaults to the topology primary
 * @returns A connection with a single pooled session
 */
export function openPostgres(url: string = primaryUrl()): Sql {
  return postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
}

/**
 * Opens a connection and closes it when `fn` finishes.
 *
 * @param fn - Receives the connection
 * @param url - Connection URL. Defaults to the topology primary
 * @returns Whatever `fn` returns
 */
export async function withPostgres<T>(fn: (sql: Sql) => Promise<T>, url?: string): Promise<T> {
  const sql = openPostgres(url ?? primaryUrl());
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Creates a unique schema on one connection and drops it afterwards.
 *
 * @param fn - Receives the reserved connection and the schema name
 * @param url - Connection URL. Defaults to the topology primary
 * @returns Whatever `fn` returns
 */
export async function withPostgresSchema<T>(
  fn: (sql: Sql, schema: string) => Promise<T>,
  url?: string,
): Promise<T> {
  const sql = openPostgres(url ?? primaryUrl());
  const schema = isolatedSchemaName();
  const reserved = await sql.reserve();
  try {
    await reserved.unsafe(`create schema ${schema}`);
    await reserved.unsafe(`set search_path to ${schema}`);
    return await fn(reserved, schema);
  } finally {
    await reserved.unsafe(`drop schema if exists ${schema} cascade`);
    reserved.release();
    await sql.end({ timeout: 5 });
  }
}

/** An empty database on the primary, dropped when {@link IsolatedDatabase.close} runs. */
export type IsolatedDatabase = {
  /** `postgres://` URL whose path is the new database. */
  readonly url: string;
  /** Drops the database and closes the admin connection. */
  close(): Promise<void>;
};

/**
 * Creates an empty database on the primary.
 *
 * `okm` opens its own connection, so a schema on the admin session is not enough.
 * `close` drops the database with `FORCE`, which every supported major accepts.
 *
 * @param base - Admin URL. Defaults to the topology primary
 * @returns The new database URL and a close function
 */
export async function createIsolatedDatabase(
  base: string = primaryUrl(),
): Promise<IsolatedDatabase> {
  const admin = openPostgres(base);
  const name = `okm_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await admin.unsafe(`create database ${name}`);
  } catch (error) {
    await admin.end({ timeout: 5 });
    throw error;
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  const href = url.href.replace(/\/$/, "");
  let closed = false;
  return {
    url: href,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await admin.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}

/**
 * Returns whether a connection can run `select 1`.
 *
 * @param url - Connection URL. Defaults to the topology primary
 * @returns True when the server accepts the connection
 */
export async function postgresReachable(url: string = primaryUrl()): Promise<boolean> {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 1,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      // The connection never opened.
    }
  }
}
