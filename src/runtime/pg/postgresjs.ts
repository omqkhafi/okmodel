/**
 * `connect` for postgres.js (`okmodel/pg/postgresjs`).
 *
 * One URL or an existing pool is one endpoint. The client is typed by the
 * schema passed in, not by `Register`.
 */

import type { DriverPool } from "../../contracts/driver.js";
import type { QuerySchema } from "../../dialects/pg/model.js";
import { open, type PostgresJsConfig } from "../../adapters/pg/postgresjs.js";
import { createClient } from "../client.js";
import type { ConnectOptions, Connected } from "../types.js";

export { open, type PostgresJsConfig } from "../../adapters/pg/postgresjs.js";
export { capabilities, hasCapability, readCapability } from "../../adapters/pg/postgresjs.js";
export { DriverError } from "../../adapters/error.js";

/** A connection string or a pool from {@link open}. */
export type PostgresTarget = string | DriverPool;

/** Driver options `connect` forwards to {@link open}. */
export type PostgresConnectOptions<S extends QuerySchema> = ConnectOptions<S> &
  Omit<PostgresJsConfig, "url">;

/**
 * Connects one Postgres endpoint and returns a client for `schema`.
 *
 * Named prepared statements are off unless `prepared` is `"named"`.
 * `prepared: "named"` is not for transaction-mode poolers.
 *
 * @typeParam S - Schema
 * @param target - URL or an existing pool
 * @param options - Schema, errors, logger, and driver options
 * @returns The client. Await `connected` for the dialect check
 */
export function connect<const S extends QuerySchema>(
  target: PostgresTarget,
  options: PostgresConnectOptions<S>,
): Connected<S> {
  if (isPool(target)) {
    return createClient(options.schema, target, {
      ownsPool: false,
      http: options.errors?.http,
      includeValues: options.errors?.includeValues,
      logger: options.logger,
      signal: options.signal,
      timeout: options.timeout,
      catalog: options.catalog,
      catalogDir: options.catalogDir,
      requireMeta: options.requireMeta,
      generators: options.generators,
    });
  }
  const url = target;
  const pool = open({
    url,
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
    ...(options.prepared !== undefined ? { prepared: options.prepared } : {}),
    ...(options.searchPath !== undefined ? { searchPath: options.searchPath } : {}),
    ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
  });
  return createClient(options.schema, pool, {
    ownsPool: true,
    http: options.errors?.http,
    includeValues: options.errors?.includeValues,
    logger: options.logger,
    signal: options.signal,
    timeout: options.timeout,
    catalog: options.catalog,
    catalogDir: options.catalogDir,
    requireMeta: options.requireMeta,
    generators: options.generators,
  });
}

function isPool(target: PostgresTarget): target is DriverPool {
  return typeof target === "object" && "execute" in target && "capabilities" in target;
}
