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

/** Cluster role used as a non-superuser schema owner in check tests. */
export const SCHEMA_OWNER = "okm_owner";

/**
 * `okm_owner` without `CREATEROLE`.
 *
 * Check replay only needs to create a schema. It does not need to create roles.
 */
export const LIMITED_SCHEMA_OWNER = "okm_owner_limited";

/**
 * Ensures {@link SCHEMA_OWNER} exists: `NOSUPERUSER`, `NOBYPASSRLS`, `CREATEROLE`, login.
 *
 * The role is cluster-wide. A later test alters it to the same shape.
 *
 * @param base - Admin URL. Defaults to the topology primary
 */
export async function ensureSchemaOwner(base: string = primaryUrl()): Promise<void> {
  const admin = openPostgres(base);
  try {
    await admin.unsafe(
      `do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'okm_owner') then
          create role okm_owner nosuperuser nobypassrls createrole login password 'okm';
        else
          alter role okm_owner nosuperuser nobypassrls createrole login password 'okm';
        end if;
      end $$`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * Connection URL for {@link SCHEMA_OWNER} on the same database.
 *
 * @param databaseUrl - A superuser URL whose path is the database
 * @returns The owner URL
 */
export function ownerUrl(databaseUrl: string, role: string = SCHEMA_OWNER): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "okm";
  return url.href.replace(/\/$/, "");
}

/**
 * Ensures {@link LIMITED_SCHEMA_OWNER} exists: `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEROLE`, login.
 *
 * @param base - Admin URL. Defaults to the topology primary
 */
export async function ensureLimitedSchemaOwner(base: string = primaryUrl()): Promise<void> {
  const admin = openPostgres(base);
  try {
    await admin.unsafe(
      `do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'okm_owner_limited') then
          create role okm_owner_limited nosuperuser nobypassrls nocreaterole login password 'okm';
        else
          alter role okm_owner_limited nosuperuser nobypassrls nocreaterole login password 'okm';
        end if;
      end $$`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * Makes {@link SCHEMA_OWNER} the owner of the database and of `public`.
 *
 * @param databaseUrl - Superuser URL of the isolated database
 * @param base - Admin URL. Defaults to the topology primary
 * @returns The owner URL
 */
export async function giveDatabaseToOwner(
  databaseUrl: string,
  base: string = primaryUrl(),
  role: string = SCHEMA_OWNER,
): Promise<string> {
  if (role === LIMITED_SCHEMA_OWNER) await ensureLimitedSchemaOwner(base);
  else await ensureSchemaOwner(base);
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name ${name}`);
  const admin = openPostgres(base);
  try {
    await admin.unsafe(`alter database ${name} owner to ${role}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const db = openPostgres(databaseUrl);
  try {
    await db.unsafe(`alter schema public owner to ${role}`);
  } finally {
    await db.end({ timeout: 5 });
  }
  return ownerUrl(databaseUrl, role);
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
